const OpenAI = require('openai');
const { getSystemPrompt, getSystemPromptForTenant } = require('../prompts/systemPrompt');
const { getOutboundSystemPrompt, getOutboundOpener } = require('../prompts/outboundPrompt');
const { getTenant } = require('../config/tenants');
const { classifyAndEnrich, formatTranscript } = require('./intentRouter');
const state = require('./conversationState');
const n8n = require('./n8nClient');
const { functions } = require('./functions');
const { stripAndExtractAction } = require('./actionParser');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

let cachedSystemPrompt = null;
function getOrCacheSystemPrompt() {
  if (!cachedSystemPrompt) cachedSystemPrompt = getSystemPrompt();
  return cachedSystemPrompt;
}

function log(callId, message) {
  console.log(`[${new Date().toISOString()}] [retellWS] [${callId}] ${message}`);
}

const FUNCTION_TO_ACTION = {
  dispatch_emergency: 'EMERGENCY',
  book_appointment: 'BOOKING',
  request_quote: 'QUOTE',
  check_job_status: 'JOB_STATUS',
  transfer_to_human: 'HUMAN_TRANSFER',
  end_call: 'END_CALL',
};

function sendResponse(ws, responseId, content, endCallFlag) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({
      response_id: responseId || 0,
      content,
      content_complete: true,
      end_call: endCallFlag || false,
    }));
  }
}

function buildMessages(systemPrompt, transcript, interactionType) {
  const messages = [{ role: 'system', content: systemPrompt }];
  if (transcript && transcript.length > 0) {
    for (const turn of transcript) {
      const role = turn.role === 'agent' ? 'assistant' : 'user';
      const content = turn.content;
      if (!content) continue;
      if (messages.length > 1 && messages[messages.length - 1].role === role) {
        messages[messages.length - 1].content += ' ' + content;
      } else {
        messages.push({ role, content });
      }
    }
  }
  if (messages.length === 1) {
    messages.push({ role: 'user', content: '[Call connected.]' });
  } else if (interactionType === 'reminder_required') {
    if (messages[messages.length - 1].role === 'assistant') {
      messages.push({ role: 'user', content: '[Caller went quiet. Re-engage naturally — "Hey, you still there?" Keep it warm.]' });
    }
  }
  return messages;
}

function handleRetellWebSocket(ws) {
  let callId = 'unknown';
  let callState = null;
  let tenant = null;
  let systemPrompt = null;
  let hasGreeted = false;
  let callEnded = false;
  let actionFiredLocally = false;
  let processing = false;

  // KEY: always track the latest responseId Retell is waiting on.
  // GPT-4o can take 2-3s; Retell may send a new event (with new responseId)
  // before we finish. We must respond to the LATEST one, not the stale one.
  let latestResponseId = 0;
  let closingMessage = null; // set when we decide to end, so we can re-send on new responseIds

  function endCall(message) {
    if (callEnded) return;
    callEnded = true;
    closingMessage = message || "It was so great talking with you! Thanks for calling F-E-S Electrical Services. Have a wonderful day!";
    log(callId, `ENDING CALL (responseId=${latestResponseId}) — "${closingMessage.substring(0, 80)}"`);
    sendResponse(ws, latestResponseId, closingMessage, true);
    // Force-close after 15s to let TTS fully play
    setTimeout(() => { try { if (ws.readyState === ws.OPEN) ws.close(); } catch (e) {} }, 15000);
  }

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) { return; }

    // Update callId from any message
    callId = msg.call_id || msg.call?.call_id || msg.call?.id || callId;

    // ── Ping ──────────────────────────────────────────────────────────────────
    if (msg.interaction_type === 'ping' || msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    // ── update_only ───────────────────────────────────────────────────────────
    if (msg.interaction_type === 'update_only') return;

    // ── call_ended ────────────────────────────────────────────────────────────
    if (msg.interaction_type === 'call_ended') {
      log(callId, 'call_ended received');
      handleCallEnded(callId, msg.transcript, msg.call).catch(err =>
        log(callId, `CALL_COMPLETE error: ${err.message}`)
      );
      return;
    }

    // ── call_details — informational only, Retell ignores any response we send here ──
    if (msg.interaction_type === 'call_details') {
      callState = state.create(callId);
      const meta = msg.call?.metadata || {};
      const dynVars = msg.call?.retell_llm_dynamic_variables || {};
      const isOutbound = meta.outbound === true || dynVars.outbound === 'true';
      const outboundCallType = meta.call_type || dynVars.call_type || null;
      let customerData = meta.customer_data || {};
      if (dynVars.customer_data) { try { customerData = JSON.parse(dynVars.customer_data); } catch {} }

      const toNumber = msg.call?.to_number || null;
      tenant = getTenant(toNumber);

      if (isOutbound && outboundCallType) {
        systemPrompt = getOutboundSystemPrompt(outboundCallType, customerData, tenant.company_name);
        state.update(callId, { tenant, outbound: true, outboundCallType, customerData });
        log(callId, `Outbound ${outboundCallType} call`);
        // Outbound opener sent on first response_required (hasGreeted stays false)
      } else {
        systemPrompt = getSystemPromptForTenant(tenant);
        if (msg.call?.from_number) state.update(callId, { callerPhone: msg.call.from_number });
        state.update(callId, { tenant });
        log(callId, `Inbound from ${msg.call?.from_number || 'unknown'} — tenant: ${tenant.id}`);
        // Retell plays begin_message automatically as the opening line.
        // Mark hasGreeted so we don't double-greet on first response_required.
        hasGreeted = true;
      }
      return;
    }

    // ── response_required / reminder_required ─────────────────────────────────
    if (msg.interaction_type !== 'response_required' && msg.interaction_type !== 'reminder_required') return;

    // Always update latestResponseId — this is what Retell is CURRENTLY waiting for
    if (msg.response_id !== undefined) latestResponseId = msg.response_id;

    // If already ended: re-send the closing on the new responseId (handles Retell race conditions)
    if (callEnded) {
      if (closingMessage) {
        log(callId, `Re-ack end_call on responseId ${latestResponseId}`);
        sendResponse(ws, latestResponseId, closingMessage, true);
      }
      return;
    }

    // If already processing another message: just updated latestResponseId above, that's enough.
    // When the current GPT-4o call finishes, it will respond using the updated latestResponseId.
    if (processing) {
      log(callId, `Processing — skipping responseId ${latestResponseId}, will respond with latest when done`);
      return;
    }

    processing = true;
    try {
      // Lazy init
      if (!callState) {
        callState = state.create(callId);
        if (msg.call?.from_number) state.update(callId, { callerPhone: msg.call.from_number });
      }

      // Greet first if we haven't
      if (!hasGreeted) {
        const toNumber = msg.call?.to_number || null;
        if (!tenant) tenant = getTenant(toNumber);
        if (!systemPrompt) systemPrompt = getSystemPromptForTenant(tenant);
        const greeting = `Hey, thanks for calling F-E-S Electrical Services, this is Volt. What can I help you with today?`;
        sendResponse(ws, latestResponseId, greeting, false);
        state.addTranscriptEntry(callId, 'agent', greeting);
        hasGreeted = true;
        return;
      }

      // Ensure tenant/prompt resolved
      if (!tenant) {
        const toNumber = msg.call?.to_number || null;
        tenant = getTenant(toNumber);
        const saved = state.get(callId);
        systemPrompt = (saved?.outbound && saved?.outboundCallType)
          ? getOutboundSystemPrompt(saved.outboundCallType, saved.customerData || {}, tenant.company_name)
          : getSystemPromptForTenant(tenant);
        state.update(callId, { tenant });
      }

      const transcript = msg.transcript || [];
      const messages = buildMessages(systemPrompt || getOrCacheSystemPrompt(), transcript, msg.interaction_type);

      let assistantText = '';
      let actionData = null;

      try {
        const response = await openai.chat.completions.create({
          model: process.env.OPENAI_MODEL || 'gpt-4o',
          max_tokens: 250,
          temperature: 0.85,
          messages,
          tools: functions,
          tool_choice: 'auto',
        });

        const choice = response.choices[0];
        assistantText = choice?.message?.content || '';

        if (choice?.message?.tool_calls?.length > 0) {
          const toolCall = choice.message.tool_calls[0];
          const fnName = toolCall.function.name;
          const fnArgs = JSON.parse(toolCall.function.arguments);
          const actionType = FUNCTION_TO_ACTION[fnName];
          if (actionType) {
            actionData = { type: actionType, data: fnArgs };
            log(callId, `Tool call: ${fnName} -> ${actionType}`);
          }
        }

        if (!actionData && assistantText) {
          const fallback = stripAndExtractAction(assistantText);
          assistantText = fallback.spokenResponse;
          actionData = fallback.actionData;
          if (actionData) log(callId, `Fallback action: ${actionData.type}`);
        }
      } catch (err) {
        log(callId, `OpenAI error: ${err.message}`);
        endCall("We're having a quick technical issue. Someone from F-E-S will call you right back. Thanks for your patience!");
        return;
      }

      // GPT-4o called end_call tool
      if (actionData?.type === 'END_CALL') {
        const closing = actionData.data?.closing_message ||
          "It was so great talking with you today! Thanks for calling F-E-S Electrical Services — we truly appreciate it. Have a wonderful day and take care!";
        endCall(closing);
        return;
      }

      // Fire n8n webhook once
      if (actionData?.type && actionData?.data && !actionFiredLocally) {
        actionFiredLocally = true;
        log(callId, `Action: ${actionData.type}`);
        handleAction(callId, actionData, callState, tenant).catch(err =>
          log(callId, `Action error: ${err.message}`)
        );
      }

      // ── Programmatic end detection ──────────────────────────────────────────
      const savedState = state.get(callId);
      const lastUserMsg = ([...transcript].reverse().find(t => t.role === 'user')?.content || '').toLowerCase().trim();

      // Hard stop: caller said bye
      const callerSaidBye = /\b(bye|goodbye|bye bye|good bye|take care|have a good|have a great|talk later|gotta go)\b/.test(lastUserMsg);
      if (callerSaidBye) {
        endCall(assistantText || "It was great talking with you! Thanks for calling F-E-S Electrical Services. Have a wonderful day and take care!");
        return;
      }

      // Soft stop: caller is done AND an action was fired (check both local flag and saved state)
      const callerIsDone = /\b(thanks|thank you|okay|ok|alright|sounds good|perfect|that's it|that's all|that's good|no|nope|you're good|i'm good|we're good|got it|great|awesome|nothing else|all good|no thanks|no thank you)\b/.test(lastUserMsg);
      const actionWasFired = actionFiredLocally || savedState?.current_intent || savedState?.action_fired;

      if (callerIsDone && actionWasFired) {
        // Even if GPT-4o keeps asking "anything else", we end it now
        const closing = (assistantText && !/is there anything else|anything else i can|anything else for you/i.test(assistantText))
          ? assistantText
          : "You're all set! Thanks so much for calling F-E-S Electrical Services — we really appreciate your business. Have an amazing day!";
        endCall(closing);
        return;
      }

      // Normal response — use the latest responseId (may have updated during GPT-4o call)
      const finalResponse = assistantText || "Is there anything else I can help you with?";
      state.addTranscriptEntry(callId, 'agent', finalResponse);
      log(callId, `[responseId=${latestResponseId}] "${finalResponse.substring(0, 80)}"`);
      sendResponse(ws, latestResponseId, finalResponse, false);

    } catch (err) {
      console.error(`[retellWS] Error:`, err.message);
      try { sendResponse(ws, latestResponseId, "Sorry, could you say that again?", false); } catch (e) {}
    } finally {
      processing = false;
    }
  });

  ws.on('close', () => {
    log(callId, 'WS closed');
    if (callId) setTimeout(() => state.remove(callId), 5 * 60 * 1000);
  });

  ws.on('error', (err) => log(callId, `WS error: ${err.message}`));
}

async function handleCallEnded(callId, transcript, call) {
  const callState = state.get(callId);
  const rawTranscript = formatTranscript(transcript || callState?.transcript || []);
  const tenantConfig = callState?.tenant || null;

  await n8n.fireWebhook('CALL_COMPLETE', {
    call_id: callId,
    caller: {
      name: callState?.callerName || null,
      phone: callState?.callerPhone || call?.from_number || null,
      address: callState?.callerAddress || null,
    },
    details: {
      intent: callState?.intent || null,
      service_requested: callState?.serviceRequested || null,
      urgency: callState?.urgency || null,
      handed_off: callState?.handedOff || false,
    },
    raw_transcript: rawTranscript,
  }, tenantConfig);

  log(callId, `CALL_COMPLETE fired`);
}

async function handleAction(callId, action, callState, tenantConfig) {
  const { type, data } = action;
  if (!type || !data) return;

  const updates = { intent: type.toLowerCase() };
  if (data.name) updates.callerName = data.name;
  if (data.phone) updates.callerPhone = data.phone;
  if (data.address) updates.callerAddress = data.address;
  if (data.service_needed) updates.serviceRequested = data.service_needed;
  if (data.job_description) updates.serviceRequested = data.job_description;
  if (type === 'EMERGENCY') updates.urgency = 'emergency';
  if (type === 'HUMAN_TRANSFER') updates.handedOff = true;
  state.update(callId, updates);

  const transcript = callState.transcript || [];
  const { enrichedData } = classifyAndEnrich(transcript, action);

  await n8n.fireWebhook(type, {
    call_id: callId,
    caller: enrichedData.caller,
    details: enrichedData.details,
    raw_transcript: enrichedData.raw_transcript,
  }, tenantConfig || callState?.tenant || null);

  log(callId, `${type} webhook fired`);
}

module.exports = { handleRetellWebSocket };
