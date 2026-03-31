const OpenAI = require('openai');
const { COMPANY_NAME } = require('../config/constants');
const { getSystemPrompt, getSystemPromptForTenant } = require('../prompts/systemPrompt');
const { getOutboundSystemPrompt, getOutboundOpener } = require('../prompts/outboundPrompt');
const { getTenant } = require('../config/tenants');
const { classifyAndEnrich, formatTranscript } = require('./intentRouter');
const state = require('./conversationState');
const n8n = require('./n8nClient');
const { functions } = require('./functions');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

// Pre-cache system prompt at startup
let cachedSystemPrompt = null;

function getOrCacheSystemPrompt() {
  if (!cachedSystemPrompt) cachedSystemPrompt = getSystemPrompt();
  return cachedSystemPrompt;
}

function log(callId, message) {
  console.log(`[${new Date().toISOString()}] [retellWS] [${callId}] ${message}`);
}

// Map function names to action types
const FUNCTION_TO_ACTION = {
  dispatch_emergency: 'EMERGENCY',
  book_appointment: 'BOOKING',
  request_quote: 'QUOTE',
  check_job_status: 'JOB_STATUS',
  transfer_to_human: 'HUMAN_TRANSFER',
  end_call: 'END_CALL',
};

const { stripAndExtractAction } = require('./actionParser');

function handleRetellWebSocket(ws) {
  let callId = null;
  let callState = null;
  let tenant = null;
  let systemPrompt = null;

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      callId = msg.call_id || msg.call?.call_id || msg.call?.id || callId || 'unknown';

      if (msg.interaction_type === 'update_only') return;

      if (msg.interaction_type === 'ping' || msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      if (msg.interaction_type === 'call_ended') {
        log(callId, 'Call ended');
        // Fire webhook in background, don't await
        handleCallEnded(callId, msg.transcript, msg.call).catch(err =>
          log(callId, `CALL_COMPLETE error: ${err.message}`)
        );
        return;
      }

      // call_details — send greeting (inbound) or outbound opener
      if (msg.interaction_type === 'call_details') {
        callState = state.create(callId);

        // Detect outbound call type from metadata OR dynamic variables (for simulator testing)
        const meta = msg.call?.metadata || {};
        const dynVars = msg.call?.retell_llm_dynamic_variables || {};
        const isOutbound = meta.outbound === true || dynVars.outbound === 'true';
        const outboundCallType = meta.call_type || dynVars.call_type || null;
        let customerData = meta.customer_data || {};
        if (dynVars.customer_data) {
          try { customerData = JSON.parse(dynVars.customer_data); } catch {}
        }

        // Resolve tenant from to_number (the number the caller dialed)
        const toNumber = msg.call?.to_number || null;
        tenant = getTenant(toNumber);

        if (isOutbound && outboundCallType) {
          // Outbound: use outbound-specific prompt
          systemPrompt = getOutboundSystemPrompt(outboundCallType, customerData, tenant.company_name);
          state.update(callId, { tenant, outbound: true, outboundCallType, customerData });
          log(callId, `Outbound ${outboundCallType} call to ${toNumber}`);

          const opener = getOutboundOpener(outboundCallType, customerData, tenant.company_name);
          sendResponse(ws, 0, opener, false);
          state.addTranscriptEntry(callId, 'agent', opener);
        } else {
          // Inbound: normal greeting
          systemPrompt = getSystemPromptForTenant(tenant);
          if (msg.call?.from_number) {
            state.update(callId, { callerPhone: msg.call.from_number });
          }
          state.update(callId, { tenant });
          log(callId, `Inbound call from ${msg.call?.from_number || 'unknown'} to ${toNumber || 'unknown'} — tenant: ${tenant.id}`);

          const greeting = `Hey, thanks for calling ${tenant.company_name}, this is Volt. What can I help you with?`;
          sendResponse(ws, msg.response_id || 0, greeting, false);
          state.addTranscriptEntry(callId, 'agent', greeting);
        }
        return;
      }

      // response_required / reminder_required
      if (msg.interaction_type === 'response_required' || msg.interaction_type === 'reminder_required') {
        if (!callState) {
          callState = state.create(callId);
          if (msg.call?.from_number) {
            state.update(callId, { callerPhone: msg.call.from_number });
          }
        }

        // Ensure tenant and system prompt are resolved (in case call_details was missed)
        if (!tenant) {
          const toNumber = msg.call?.to_number || null;
          tenant = getTenant(toNumber);
          const savedState = state.get(callId);
          if (savedState?.outbound && savedState?.outboundCallType) {
            systemPrompt = getOutboundSystemPrompt(savedState.outboundCallType, savedState.customerData || {}, tenant.company_name);
          } else {
            systemPrompt = getSystemPromptForTenant(tenant);
          }
          state.update(callId, { tenant });
        }

        const transcript = msg.transcript || [];
        const messages = buildMessages(systemPrompt || getOrCacheSystemPrompt(), transcript, msg.interaction_type);

        let assistantText = '';
        let actionData = null;

        try {
          const response = await openai.chat.completions.create({
            model: process.env.OPENAI_MODEL || 'gpt-4o',
            max_tokens: 200,
            temperature: 0.85,
            messages,
            tools: functions,
            tool_choice: 'auto',
          });

          const choice = response.choices[0];
          assistantText = choice?.message?.content || '';

          // Check for function calls (primary path)
          if (choice?.message?.tool_calls && choice.message.tool_calls.length > 0) {
            const toolCall = choice.message.tool_calls[0];
            const fnName = toolCall.function.name;
            const fnArgs = JSON.parse(toolCall.function.arguments);
            const actionType = FUNCTION_TO_ACTION[fnName];

            if (actionType) {
              actionData = { type: actionType, data: fnArgs };
              log(callId, `Function call: ${fnName} -> ${actionType}`);
            }
          }

          // Fallback: check text for old ACTIONSTART/ACTIONEND format
          if (!actionData && assistantText) {
            const fallback = stripAndExtractAction(assistantText);
            assistantText = fallback.spokenResponse;
            actionData = fallback.actionData;
            if (actionData) {
              log(callId, `Fallback text action: ${actionData.type}`);
            }
          }
        } catch (err) {
          log(callId, `OpenAI error: ${err.message}`);
          sendResponse(ws, msg.response_id, "Technical issue on our end. Someone'll call you right back.", true);
          return;
        }

        // Handle end_call function — say goodbye and hang up
        if (actionData?.type === 'END_CALL') {
          const goodbye = actionData.data?.closing_message || "Thanks for calling. Take care!";
          log(callId, `END_CALL — "${goodbye}"`);
          sendResponse(ws, msg.response_id, goodbye, true);
          return;
        }

        // Fire n8n webhook in background — don't block the response
        if (actionData && actionData.type && actionData.data) {
          log(callId, `Action: ${actionData.type}`);
          handleAction(callId, actionData, callState, tenant).catch(err =>
            log(callId, `Action error: ${err.message}`)
          );
        }

        // Programmatic end detection — force hang up, don't rely on GPT-4o
        const savedState = state.get(callId);
        const lastUserMsg = (transcript[transcript.length - 1]?.content || '').toLowerCase().trim();

        // Hard stop: caller explicitly says bye/goodbye → end immediately
        const callerSaidBye = /\b(bye|goodbye|bye bye|good bye|take care|have a good|have a great|talk later|gotta go)\b/.test(lastUserMsg);
        if (callerSaidBye) {
          const goodbye = assistantText || "Take care! Bye!";
          log(callId, `Hard end_call — caller said bye`);
          sendResponse(ws, msg.response_id, goodbye, true);
          return;
        }

        // Soft stop: caller signals done + action already fired → end the call
        const callerIsDone = /\b(thanks|thank you|okay|ok|alright|sounds good|perfect|that's it|that's all|that's good|no|nope|you're good|i'm good|we're good|got it|great|awesome)\b/.test(lastUserMsg);
        const actionWasFired = savedState?.intent;
        if (callerIsDone && actionWasFired) {
          // Force a closing — don't wait for Volt to decide
          const closing = (assistantText && !/is there anything else/i.test(assistantText))
            ? assistantText
            : "You're all set. Thanks for calling, take care!";
          log(callId, `Soft end_call — caller done + action fired`);
          sendResponse(ws, msg.response_id, closing, true);
          return;
        }

        const finalResponse = assistantText || "Is there anything else I can help you with?";
        state.addTranscriptEntry(callId, 'agent', finalResponse);
        log(callId, `"${finalResponse.substring(0, 80)}"`);

        sendResponse(ws, msg.response_id, finalResponse, false);
      }
    } catch (err) {
      console.error(`[retellWS] Error:`, err.message);
      try {
        sendResponse(ws, 0, "Sorry, could you say that again?", false);
      } catch (e) {}
    }
  });

  ws.on('close', () => {
    log(callId || 'unknown', 'WS closed');
    if (callId) setTimeout(() => state.remove(callId), 5 * 60 * 1000);
  });

  ws.on('error', (err) => {
    log(callId || 'unknown', `WS error: ${err.message}`);
  });
}

function sendResponse(ws, responseId, content, endCall) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({
      response_id: responseId || 0,
      content,
      content_complete: true,
      end_call: endCall || false,
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
    const lastRole = messages[messages.length - 1].role;
    if (lastRole === 'assistant') {
      messages.push({ role: 'user', content: '[Caller has gone quiet. Gently re-engage them naturally, like "Hey, you still there?" or "Take your time, no rush" or ask if they had any other questions. Keep it warm and casual.]' });
    }
  }

  return messages;
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
