const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { N8N_WEBHOOK_URL, N8N_WEBHOOK_SECRET, COMPANY_NAME } = require('../config/constants');

const RETRY_COUNT = 3;
const RETRY_DELAY_MS = 2000;
const LOGS_DIR = path.resolve(__dirname, '..', 'logs');
const FAILED_WEBHOOKS_FILE = path.join(LOGS_DIR, 'failed-webhooks.json');

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
 * Fires a webhook to n8n with a standardized payload.
 *
 * @param {string} actionType - "EMERGENCY"|"BOOKING"|"QUOTE"|"JOB_STATUS"|"HUMAN_TRANSFER"|"CALL_COMPLETE"
 * @param {object} data - Must include: call_id, caller {name, phone, address}, details, raw_transcript.
 *                        Optionally pre-built by classifyAndEnrich's enrichedData.
 */
async function fireWebhook(actionType, data) {
  if (!N8N_WEBHOOK_URL) {
    console.warn('[n8nClient] N8N_WEBHOOK_URL not configured, skipping webhook');
    return null;
  }

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

  const label = `webhook ${actionType} (call ${payload.call_id})`;
  const result = await postWithRetry(N8N_WEBHOOK_URL, payload, label);

  if (result === null) {
    console.error(`[n8nClient] All ${RETRY_COUNT} retries failed for ${label} — logging to disk`);
    logFailedWebhook(payload);
  }

  // For EMERGENCY, also fire to the redundant emergency channel
  if (actionType === 'EMERGENCY') {
    const emergencyUrl = N8N_WEBHOOK_URL.replace(/\/?$/, '/emergency');
    const emergLabel = `emergency-channel (call ${payload.call_id})`;
    const emergResult = await postWithRetry(emergencyUrl, payload, emergLabel);
    if (emergResult === null) {
      console.error(`[n8nClient] Emergency channel also failed for ${emergLabel}`);
    }
  }

  return result;
}

module.exports = { fireWebhook };
