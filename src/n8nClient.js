const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { N8N_WEBHOOK_SECRET, COMPANY_NAME } = require('../config/constants');
const { sendConfirmationSMS } = require('./smsClient');

const RETRY_COUNT = 3;
const RETRY_DELAY_MS = 2000;
const LOGS_DIR = path.resolve(__dirname, '..', 'logs');
const FAILED_WEBHOOKS_FILE = path.join(LOGS_DIR, 'failed-webhooks.json');

// ── Your existing n8n workflow webhook URLs ──────────────────────────────
const N8N_BASE = 'https://kortexaitrigger8899.app.n8n.cloud/webhook';

const WORKFLOW_URLS = {
  EMERGENCY:      `${N8N_BASE}/retell-outbound-call`,       // Make Outbound Call workflow — triggers callback to caller
  BOOKING:        `${N8N_BASE}/n8n-retell-booking-caller`,  // Appointment Booking Functions workflow
  QUOTE:          `${N8N_BASE}/get-leads-details`,           // Get Lead Details workflow — creates lead record
  JOB_STATUS:     `${N8N_BASE}/get-leads-details`,           // Get Lead Details workflow — looks up by caller info
  HUMAN_TRANSFER: `${N8N_BASE}/retell-outbound-call`,       // Make Outbound Call workflow — triggers human callback
  CALL_COMPLETE:  `${N8N_BASE}/n8n-ssw-engine`,             // Text Engine workflow — logs call, sends follow-up SMS
};

// Redundant emergency channel for urgent alerts
const EMERGENCY_SMS_URL = `${N8N_BASE}/n8n-ssw-engine`;

function ensureLogsDir() {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logFailedWebhook(payload) {
  ensureLogsDir();

  let existing = [];
  if (fs.existsSync(FAILED_WEBHOOKS_FILE)) {
    try {
      existing = JSON.parse(fs.readFileSync(FAILED_WEBHOOKS_FILE, 'utf-8'));
    } catch {
      existing = [];
    }
  }

  existing.push({
    failed_at: new Date().toISOString(),
    payload,
  });

  fs.writeFileSync(FAILED_WEBHOOKS_FILE, JSON.stringify(existing, null, 2));
  console.error(`[n8nClient] Payload saved to ${FAILED_WEBHOOKS_FILE}`);
}

/**
 * Post to a URL with retry logic. Returns the response data on success, null on failure.
 */
async function postWithRetry(url, payload, label) {
  for (let attempt = 1; attempt <= RETRY_COUNT; attempt++) {
    try {
      const response = await axios.post(url, payload, {
        headers: {
          'Content-Type': 'application/json',
          ...(N8N_WEBHOOK_SECRET && { 'X-Webhook-Secret': N8N_WEBHOOK_SECRET }),
        },
        timeout: 10000,
      });

      console.log(`[n8nClient] ${label} — attempt ${attempt} succeeded (${response.status})`);
      return response.data;
    } catch (err) {
      console.error(`[n8nClient] ${label} — attempt ${attempt}/${RETRY_COUNT} failed: ${err.message}`);
      if (attempt < RETRY_COUNT) {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
  return null;
}

/**
 * Fires a webhook to the correct n8n workflow based on actionType.
 *
 * Routing:
 *   EMERGENCY      → Make Outbound Call (triggers on-call technician callback)
 *   BOOKING        → Appointment Booking Functions (creates appointment in GHL)
 *   QUOTE          → Get Lead Details (creates/finds lead in GHL)
 *   JOB_STATUS     → Get Lead Details (looks up existing job by caller)
 *   HUMAN_TRANSFER → Make Outbound Call (triggers human callback to caller)
 *   CALL_COMPLETE  → Text Engine (logs call, sends follow-up SMS)
 *
 * @param {string} actionType - "EMERGENCY"|"BOOKING"|"QUOTE"|"JOB_STATUS"|"HUMAN_TRANSFER"|"CALL_COMPLETE"
 * @param {object} data - Must include: call_id, caller {name, phone, address}, details, raw_transcript.
 */
async function fireWebhook(actionType, data) {
  const webhookUrl = WORKFLOW_URLS[actionType];

  if (!webhookUrl) {
    console.warn(`[n8nClient] No workflow URL mapped for action type: ${actionType}`);
    return null;
  }

  // Build standardized payload that all workflows receive
  const payload = {
    event: actionType,
    timestamp: new Date().toISOString(),
    call_id: data.call_id || null,
    company: COMPANY_NAME,
    caller: {
      name: data.caller?.name || null,
      phone: data.caller?.phone || null,
      address: data.caller?.address || null,
    },
    details: data.details || {},
    priority: actionType === 'EMERGENCY' ? 'URGENT' : 'NORMAL',
    raw_transcript: data.raw_transcript || '',
  };

  // For workflows that expect Retell-style payloads (Make Outbound Call, Appointment Booking),
  // also include the fields they need
  if (actionType === 'EMERGENCY' || actionType === 'HUMAN_TRANSFER') {
    // Make Outbound Call workflow expects: body.name, body.phone, body.email
    payload.name = data.caller?.name || '';
    payload.phone = data.caller?.phone || '';
    payload.email = data.caller?.email || '';
    payload.agent_number = '1'; // default to Agent 1
  }

  if (actionType === 'BOOKING') {
    // Appointment Booking workflow expects caller info + booking details
    payload.name = data.caller?.name || '';
    payload.phone = data.caller?.phone || '';
    payload.email = data.caller?.email || '';
    payload.preferred_date = data.details?.preferred_date || '';
    payload.time_window = data.details?.time_window || '';
    payload.issue_description = data.details?.issue_description || '';
    payload.access_notes = data.details?.access_notes || '';
  }

  if (actionType === 'QUOTE' || actionType === 'JOB_STATUS') {
    // Get Lead Details workflow expects: body.call_inbound.from_number
    payload.call_inbound = {
      from_number: data.caller?.phone || '',
    };
  }

  const label = `${actionType} → ${webhookUrl.split('/webhook/')[1]} (call ${payload.call_id})`;

  console.log(`[n8nClient] Routing ${actionType} to: ${webhookUrl}`);
  const result = await postWithRetry(webhookUrl, payload, label);

  if (result === null) {
    console.error(`[n8nClient] All ${RETRY_COUNT} retries failed for ${label} — logging to disk`);
    logFailedWebhook(payload);
  }

  // Send SMS confirmation in background
  sendConfirmationSMS(actionType, data, data.call_id).catch(err =>
    console.log(`[n8n] SMS error: ${err.message}`)
  );

  // For EMERGENCY, also fire SMS alert via Text Engine as redundant channel
  if (actionType === 'EMERGENCY') {
    console.log(`[n8nClient] Firing redundant emergency SMS via Text Engine`);
    const smsPayload = {
      event: 'EMERGENCY_SMS',
      timestamp: new Date().toISOString(),
      call_id: data.call_id,
      company: COMPANY_NAME,
      message: `URGENT: Emergency call from ${data.caller?.name || 'Unknown'} at ${data.caller?.address || 'Unknown address'}. Issue: ${data.details?.issue_description || 'Electrical emergency'}. Callback: ${data.caller?.phone || 'N/A'}`,
      phone: data.caller?.phone || '',
      name: data.caller?.name || '',
    };
    const smsResult = await postWithRetry(EMERGENCY_SMS_URL, smsPayload, `emergency-sms (call ${data.call_id})`);
    if (smsResult === null) {
      console.error(`[n8nClient] Emergency SMS channel also failed`);
    }
  }

  return result;
}

module.exports = { fireWebhook };
