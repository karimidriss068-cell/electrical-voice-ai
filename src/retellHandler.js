const { Router } = require('express');
const OpenAI = require('openai');
const { RETELL_API_KEY } = require('../config/constants');
const { getSystemPrompt } = require('../prompts/systemPrompt');
const { classifyAndEnrich, formatTranscript } = require('./intentRouter');
const state = require('./conversationState');
const n8n = require('./n8nClient');

const router = Router();

// Initialize OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

const ACTION_REGEX = /##ACTION:(.*?)##/s;

let responseCounter = 0;

function log(callId, message) {
  console.log(`[${new Date().toISOString()}] [retellHandler] [${callId}] ${message}`);
}

// Verify Retell webhook signature (skip if no signature header sent)
function verifyRetell(req, res, next) {
  const sig = req.headers['x-retell-signature'];
  if (RETELL_API_KEY && sig && sig !== RETELL_API_KEY) {
    console.warn(`[retellHandler] Signature mismatch — rejecting request`);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.use(verifyRetell);

// POST /retell-webhook — main Retell LLM webhook endpoint
router.post('/', async (req, res) => {
  const { call_id, interaction_type, transcript, call } = req.body;
  const callId = call_id || call?.call_id;

  if (!callId) {
    return res.status(400).json({ error: 'Missing call_id' });
  }

  try {
    switch (interaction_type) {
      case 'call_ended':
        return await handleCallEnded(callId, transcript, call, res);

      case 'response_required':
      case 'reminder_required':
        return await handleResponseRequired(callId, interaction_type, transcript, call, res);

      default:
        log(callId, `Unhandled interaction_type: ${interaction_type}`);
        return res.json({ response_id: ++responseCounter, content: '', content_complete: true, end_call: false });
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [retellHandler] [${callId}] Unhandled error:`, err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// --- call_ended ---
async function handleCallEnded(callId, transcript, call, res) {
  log(callId, 'Call ended');

  const callState = state.get(callId);

  if (callState && transcript) {
    state.update(callId, { transcript });
  }

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
      from_number: call?.from_number || null,
      to_number: call?.to_number || null,
      metadata: call?.metadata || null,
    },
    raw_transcript: rawTranscript,
  });
  log(callId, `Fired CALL_COMPLETE webhook — intent: ${callState?.intent}`);

  setTimeout(() => state.remove(callId), 5 * 60 * 1000);

  return res.json({ response_id: ++responseCounter, content: '', content_complete: true, end_call: false });
}

// --- response_required / reminder_required ---
async function handleResponseRequired(callId, interactionType, transcript, call, res) {
  let callState = state.get(callId);
  if (!callState) {
    callState = state.create(callId);
    if (call?.from_number) {
      state.update(callId, { callerPhone: call.from_number });
    }
    log(callId, `New call from ${call?.from_number || 'unknown'}`);
  }

  const systemPrompt = getSystemPrompt();
  const messages = buildOpenAIMessages(systemPrompt, transcript, interactionType);

  log(callId, `${interactionType} — ${messages.length} messages, calling OpenAI`);

  let assistantText;
  try {
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      max_tokens: 512,
      messages,
    });

    assistantText = response.choices[0]?.message?.content || '';
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [retellHandler] [${callId}] OpenAI API error:`, err.message);
    log(callId, `OpenAI call failed: ${err.message}`);

    return res.json({
      response_id: ++responseCounter,
      content: "I'm sorry, I'm having a brief technical issue. Let me have someone call you right back.",
      content_complete: true,
      end_call: true,
      _debug_error: err.message,
    });
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
    } catch (parseErr) {
      console.error(`[${new Date().toISOString()}] [retellHandler] [${callId}] Failed to parse action JSON:`, parseErr.message);
    }
  }

  state.addTranscriptEntry(callId, 'agent', spokenResponse);

  const isTransfer = callState.handedOff;

  return res.json({
    response_id: ++responseCounter,
    content: spokenResponse,
    content_complete: true,
    end_call: endCall,
    ...(isTransfer && { metadata: { transfer_requested: true } }),
  });
}

// Build OpenAI messages array from Retell transcript
function buildOpenAIMessages(systemPrompt, transcript, interactionType) {
  const messages = [{ role: 'system', content: systemPrompt }];

  if (transcript && transcript.length > 0) {
    for (const turn of transcript) {
      const role = turn.role === 'agent' ? 'assistant' : 'user';
      const content = turn.content;
      if (!content) continue;

      // Merge consecutive same-role messages
      if (messages.length > 1 && messages[messages.length - 1].role === role) {
        messages[messages.length - 1].content += ' ' + content;
      } else {
        messages.push({ role, content });
      }
    }
  }

  // If no transcript yet, add initial prompt
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

// Handle parsed action blocks
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
  if (data.preferred_date) updates.preferredDate = data.preferred_date;
  if (data.preferred_time) updates.preferredTime = data.preferred_time;
  if (data.access_notes) updates.notes = data.access_notes;
  if (type === 'EMERGENCY') updates.urgency = 'emergency';
  if (type === 'HUMAN_TRANSFER') updates.handedOff = true;
  state.update(callId, updates);

  const transcript = callState.transcript || [];
  const { isValid, missingFields, enrichedData } = classifyAndEnrich(transcript, action);

  if (!isValid) {
    log(callId, `Action ${type} has missing fields: ${missingFields.join(', ')} — firing anyway with available data`);
  }

  await n8n.fireWebhook(type, {
    call_id: callId,
    caller: enrichedData.caller,
    details: enrichedData.details,
    raw_transcript: enrichedData.raw_transcript,
  });

  log(callId, `Fired ${type} webhook — ${data.name || 'unknown'}${data.address ? ' at ' + data.address : ''}`);
}

module.exports = router;
