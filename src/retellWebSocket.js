const OpenAI = require('openai');
const { getSystemPrompt } = require('../prompts/systemPrompt');
const { classifyAndEnrich, formatTranscript } = require('./intentRouter');
const state = require('./conversationState');
const n8n = require('./n8nClient');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

const ACTION_REGEX = /##ACTION:(.*?)##/s;

function log(callId, message) {
  console.log(`[${new Date().toISOString()}] [retellWS] [${callId}] ${message}`);
}

function handleRetellWebSocket(ws) {
  let callId = null;
  let callState = null;

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // First message from Retell contains config
      if (msg.interaction_type === 'update_only') {
        // Config/update message — extract call info
        if (msg.call) {
          callId = msg.call.call_id || callId;
          log(callId || 'unknown', `Config update received`);
        }
        return;
      }

      // Extract call_id from message
      callId = msg.call_id || msg.call?.call_id || callId || 'unknown';

      // Handle call_ended
      if (msg.interaction_type === 'call_ended') {
        log(callId, 'Call ended');
        await handleCallEnded(callId, msg.transcript, msg.call);
        return;
      }

      // Handle response_required and reminder_required
      if (msg.interaction_type === 'response_required' || msg.interaction_type === 'reminder_required' || msg.interaction_type === 'call_details') {
        // Get or create state
        if (!callState) {
          callState = state.create(callId);
          if (msg.call?.from_number) {
            state.update(callId, { callerPhone: msg.call.from_number });
          }
          log(callId, `New call from ${msg.call?.from_number || 'unknown'}`);
        }

        const transcript = msg.transcript || [];
        const interactionType = msg.interaction_type;

        log(callId, `${interactionType} — ${transcript.length} transcript entries`);

        // Build OpenAI messages
        const systemPrompt = getSystemPrompt();
        const messages = buildMessages(systemPrompt, transcript, interactionType);

        // Call OpenAI
        let assistantText;
        try {
          const response = await openai.chat.completions.create({
            model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
            max_tokens: 512,
            messages,
          });
          assistantText = response.choices[0]?.message?.content || '';
        } catch (err) {
          log(callId, `OpenAI error: ${err.message}`);
          sendResponse(ws, msg.response_id, "I'm sorry, I'm having a brief technical issue. Let me have someone call you right back.", true);
          return;
        }

        // Parse action block if present
        let spokenResponse = assistantText;
        let endCall = false;
        const actionMatch = assistantText.match(ACTION_REGEX);

        if (actionMatch) {
          spokenResponse = assistantText.replace(ACTION_REGEX, '').trim();
          try {
            const action = JSON.parse(actionMatch[1]);
            await handleAction(callId, action, callState);
            if (action.type === 'HUMAN_TRANSFER') {
              state.update(callId, { handedOff: true });
            }
          } catch (parseErr) {
            log(callId, `Failed to parse action: ${parseErr.message}`);
          }
        }

        state.addTranscriptEntry(callId, 'agent', spokenResponse);
        log(callId, `Response: "${spokenResponse.substring(0, 80)}..."`);

        sendResponse(ws, msg.response_id, spokenResponse, endCall);
      }
    } catch (err) {
      console.error(`[retellWS] Error processing message:`, err.message);
      // Try to send a fallback response
      try {
        sendResponse(ws, 0, "I'm sorry, could you repeat that?", false);
      } catch (e) {
        // ws might be closed
      }
    }
  });

  ws.on('close', () => {
    log(callId || 'unknown', 'WebSocket closed');
    if (callId) {
      setTimeout(() => state.remove(callId), 5 * 60 * 1000);
    }
  });

  ws.on('error', (err) => {
    log(callId || 'unknown', `WebSocket error: ${err.message}`);
  });
}

// Send response back to Retell via WebSocket
function sendResponse(ws, responseId, content, endCall) {
  const response = {
    response_id: responseId || 0,
    content: content,
    content_complete: true,
    end_call: endCall || false,
  };

  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(response));
  }
}

// Build OpenAI messages from transcript
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
    messages.push({ role: 'user', content: '[Call connected. Greet the caller.]' });
  } else if (interactionType === 'reminder_required') {
    const lastRole = messages[messages.length - 1].role;
    if (lastRole === 'assistant') {
      messages.push({ role: 'user', content: '[Caller is silent. Gently check if they are still there or need help.]' });
    }
  }

  return messages;
}

// Handle call ended
async function handleCallEnded(callId, transcript, call) {
  const callState = state.get(callId);
  const rawTranscript = formatTranscript(transcript || callState?.transcript || []);

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
  });

  log(callId, `Fired CALL_COMPLETE — intent: ${callState?.intent}`);
}

// Handle action blocks from AI response
async function handleAction(callId, action, callState) {
  const { type, data } = action;
  if (!type || !data) return;

  log(callId, `Action detected: ${type}`);

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
  const { isValid, missingFields, enrichedData } = classifyAndEnrich(transcript, action);

  if (!isValid) {
    log(callId, `Missing fields: ${missingFields.join(', ')} — firing anyway`);
  }

  await n8n.fireWebhook(type, {
    call_id: callId,
    caller: enrichedData.caller,
    details: enrichedData.details,
    raw_transcript: enrichedData.raw_transcript,
  });

  log(callId, `Fired ${type} webhook`);
}

module.exports = { handleRetellWebSocket };
