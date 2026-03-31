const OpenAI = require('openai');
const { getOutboundSystemPrompt, getOutboundOpener, CALL_TYPES } = require('../prompts/outboundPrompt');
const { getTenant } = require('../config/tenants');
const state = require('./conversationState');
const n8n = require('./n8nClient');
const { functions } = require('./functions');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

const FUNCTION_TO_ACTION = {
  dispatch_emergency: 'EMERGENCY',
  book_appointment: 'BOOKING',
  request_quote: 'QUOTE',
  check_job_status: 'JOB_STATUS',
  transfer_to_human: 'HUMAN_TRANSFER',
};

function log(callId, msg) {
  console.log(`[${new Date().toISOString()}] [outboundWS] [${callId}] ${msg}`);
}

function sendResponse(ws, responseId, content, endCall = false) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({
      response_id: responseId || 0,
      content,
      content_complete: true,
      end_call: endCall,
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
    messages.push({ role: 'user', content: '[Outbound call connected. Customer just answered. Start the call now.]' });
  } else if (interactionType === 'reminder_required') {
    const lastRole = messages[messages.length - 1].role;
    if (lastRole === 'assistant') {
      messages.push({ role: 'user', content: '[Customer went quiet. Re-engage naturally — "You still there?" or "Take your time."]' });
    }
  }

  return messages;
}

function handleOutboundWebSocket(ws) {
  let callId = null;
  let systemPrompt = null;
  let callType = null;
  let customerData = {};
  let tenant = null;

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      callId = msg.call_id || msg.call?.call_id || callId || 'unknown';

      if (msg.interaction_type === 'update_only') return;

      if (msg.interaction_type === 'ping' || msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      if (msg.interaction_type === 'call_ended') {
        log(callId, 'Outbound call ended');
        n8n.fireWebhook('CALL_COMPLETE', {
          call_id: callId,
          outbound: true,
          call_type: callType,
          customer_data: customerData,
        }).catch(() => {});
        return;
      }

      // call_details — extract call type and send opening line
      if (msg.interaction_type === 'call_details') {
        state.create(callId);

        // Get call type from metadata or dynamic variables
        const meta = msg.call?.metadata || {};
        const dynVars = msg.call?.retell_llm_dynamic_variables || {};

        callType = meta.call_type || dynVars.call_type || 'APPOINTMENT_REMINDER';
        customerData = meta.customer_data || {};
        if (dynVars.customer_data) {
          try { customerData = JSON.parse(dynVars.customer_data); } catch {}
        }

        // Resolve tenant
        const toNumber = msg.call?.to_number || null;
        tenant = getTenant(toNumber);

        // Build outbound system prompt for this call type
        systemPrompt = getOutboundSystemPrompt(callType, customerData, tenant.company_name);

        log(callId, `Outbound ${callType} call — customer: ${customerData.customer_name || 'unknown'}`);

        // Send the outbound opener immediately
        const opener = getOutboundOpener(callType, customerData, tenant.company_name);
        sendResponse(ws, 0, opener, false);
        state.addTranscriptEntry(callId, 'agent', opener);
        return;
      }

      // response_required / reminder_required
      if (msg.interaction_type === 'response_required' || msg.interaction_type === 'reminder_required') {
        // Rebuild prompt if not set (in case call_details was missed)
        if (!systemPrompt) {
          const dynVars = msg.call?.retell_llm_dynamic_variables || {};
          callType = dynVars.call_type || 'APPOINTMENT_REMINDER';
          try { customerData = JSON.parse(dynVars.customer_data || '{}'); } catch {}
          const toNumber = msg.call?.to_number || null;
          tenant = getTenant(toNumber);
          systemPrompt = getOutboundSystemPrompt(callType, customerData, tenant?.company_name);
        }

        const transcript = msg.transcript || [];
        const messages = buildMessages(systemPrompt, transcript, msg.interaction_type);

        let assistantText = '';
        let actionData = null;

        try {
          const response = await openai.chat.completions.create({
            model: process.env.OPENAI_MODEL || 'gpt-4o',
            max_tokens: 200,
            temperature: 0.8,
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
              log(callId, `Function call: ${fnName} -> ${actionType}`);
            }
          }
        } catch (err) {
          log(callId, `OpenAI error: ${err.message}`);
          sendResponse(ws, msg.response_id, "Sorry, I had a technical issue. I'll have someone call you back shortly.", true);
          return;
        }

        // Handle end_call — say goodbye and hang up
        if (actionData?.type === 'END_CALL') {
          const goodbye = actionData.data?.closing_message || "Thanks for your time. Have a great day!";
          log(callId, `END_CALL — "${goodbye}"`);
          sendResponse(ws, msg.response_id, goodbye, true);
          return;
        }

        if (actionData?.type && actionData?.data) {
          n8n.fireWebhook(actionData.type, {
            call_id: callId,
            outbound: true,
            call_type: callType,
            caller: {
              name: actionData.data.name || customerData.customer_name,
              phone: actionData.data.phone || msg.call?.to_number,
              address: actionData.data.address,
            },
            details: actionData.data,
          }).catch(() => {});
        }

        // Programmatic end detection
        const lastUserMsg = (transcript[transcript.length - 1]?.content || '').toLowerCase().trim();
        const callerSaidBye = /\b(bye|goodbye|bye bye|good bye|take care|have a good|have a great|talk later|gotta go)\b/.test(lastUserMsg);
        if (callerSaidBye) {
          const goodbye = assistantText || "Take care! Bye!";
          log(callId, `Hard end_call — caller said bye`);
          sendResponse(ws, msg.response_id, goodbye, true);
          return;
        }
        const callerIsDone = /\b(thanks|thank you|okay|ok|alright|sounds good|perfect|that's it|that's all|that's good|no|nope|you're good|i'm good|we're good|got it|great|awesome)\b/.test(lastUserMsg);
        if (callerIsDone && assistantText) {
          const isClosing = /\b(take care|have a great|thanks for|all set|you're set|we'll|someone will|team will|reach out|call you back|bye|goodbye|great day)\b/i.test(assistantText);
          if (isClosing) {
            log(callId, `Soft end_call — caller done + closing`);
            sendResponse(ws, msg.response_id, assistantText, true);
            return;
          }
        }

        const finalResponse = assistantText || "Is there anything else I can help you with?";
        state.addTranscriptEntry(callId, 'agent', finalResponse);
        log(callId, `"${finalResponse.substring(0, 80)}"`);
        sendResponse(ws, msg.response_id, finalResponse, false);
      }

    } catch (err) {
      console.error(`[outboundWS] Error:`, err.message);
      try { sendResponse(ws, 0, "Sorry, could you say that again?", false); } catch {}
    }
  });

  ws.on('close', () => log(callId || 'unknown', 'WS closed'));
  ws.on('error', (err) => log(callId || 'unknown', `WS error: ${err.message}`));
}

module.exports = { handleOutboundWebSocket };
