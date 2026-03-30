const { Router } = require('express');
const OpenAI = require('openai');
const { RETELL_API_KEY } = require('../config/constants');
const { getSystemPrompt } = require('../prompts/systemPrompt');
const { classifyAndEnrich, formatTranscript } = require('./intentRouter');
const state = require('./conversationState');
const n8n = require('./n8nClient');

const router = Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

// Pre-cache system prompt
let cachedSystemPrompt = null;
function getOrCachePrompt() {
  if (!cachedSystemPrompt) cachedSystemPrompt = getSystemPrompt();
  return cachedSystemPrompt;
}

let responseCounter = 0;

function log(callId, message) {
  console.log(`[${new Date().toISOString()}] [retellHTTP] [${callId}] ${message}`);
}

// Verify Retell webhook signature
function verifyRetell(req, res, next) {
  const sig = req.headers['x-retell-signature'];
  if (RETELL_API_KEY && sig && sig !== RETELL_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.use(verifyRetell);

router.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'retell-webhook', ready: true });
});

// Reuse same stripAndExtractAction from WebSocket module
const { stripAndExtractAction } = require('./actionParser');

router.post('/', async (req, res) => {
  const { call_id, interaction_type, transcript, call } = req.body;
  const callId = call_id || call?.call_id;

  if (!callId) {
    return res.status(400).json({ error: 'Missing call_id' });
  }

  try {
    if (interaction_type === 'call_ended') {
      log(callId, 'Call ended');
      const callState = state.get(callId);
      const rawTranscript = formatTranscript(transcript || callState?.transcript || []);

      // Fire in background
      n8n.fireWebhook('CALL_COMPLETE', {
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
      }).catch(err => log(callId, `CALL_COMPLETE error: ${err.message}`));

      setTimeout(() => state.remove(callId), 5 * 60 * 1000);
      return res.json({ response_id: ++responseCounter, content: '', content_complete: true, end_call: false });
    }

    if (interaction_type === 'response_required' || interaction_type === 'reminder_required') {
      let callState = state.get(callId);
      if (!callState) {
        callState = state.create(callId);
        if (call?.from_number) state.update(callId, { callerPhone: call.from_number });
      }

      const systemPrompt = getOrCachePrompt();
      const messages = buildMessages(systemPrompt, transcript, interaction_type);

      let assistantText;
      try {
        const response = await openai.chat.completions.create({
          model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
          max_tokens: 150,
          temperature: 0.7,
          messages,
        });
        assistantText = response.choices[0]?.message?.content || '';
      } catch (err) {
        log(callId, `OpenAI error: ${err.message}`);
        return res.json({
          response_id: ++responseCounter,
          content: "Technical issue on our end. Someone'll call you right back.",
          content_complete: true,
          end_call: true,
        });
      }

      const { spokenResponse, actionData } = stripAndExtractAction(assistantText);

      if (actionData && actionData.type && actionData.data) {
        log(callId, `Action: ${actionData.type}`);
        // Fire in background
        handleAction(callId, actionData, callState).catch(err =>
          log(callId, `Action error: ${err.message}`)
        );
      }

      const finalResponse = spokenResponse || "How can I help you?";
      state.addTranscriptEntry(callId, 'agent', finalResponse);

      return res.json({
        response_id: ++responseCounter,
        content: finalResponse,
        content_complete: true,
        end_call: false,
        ...(callState.handedOff && { metadata: { transfer_requested: true } }),
      });
    }

    return res.json({ response_id: ++responseCounter, content: '', content_complete: true, end_call: false });
  } catch (err) {
    console.error(`[retellHTTP] [${callId}] Error:`, err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

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
      messages.push({ role: 'user', content: '[Caller is quiet.]' });
    }
  }

  return messages;
}

async function handleAction(callId, action, callState) {
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
  });

  log(callId, `${type} webhook fired`);
}

module.exports = router;
