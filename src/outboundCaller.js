const { CALL_TYPES } = require('../prompts/outboundPrompt');

const RETELL_API = 'https://api.retellai.com';

/**
 * Trigger an outbound call via Retell AI
 *
 * @param {object} options
 * @param {string} options.toNumber       - Customer phone number (E.164, e.g. "+19731234567")
 * @param {string} options.callType       - One of CALL_TYPES (e.g. "APPOINTMENT_REMINDER")
 * @param {object} options.customerData   - Data passed to the agent (name, appointment_date, etc.)
 * @param {string} [options.fromNumber]   - Override the caller ID (defaults to env var)
 * @param {string} [options.agentId]      - Override the Retell agent ID (defaults to env var)
 */
async function triggerOutboundCall({ toNumber, callType, customerData = {}, fromNumber, agentId }) {
  const retellApiKey = process.env.RETELL_API_KEY;
  if (!retellApiKey) throw new Error('RETELL_API_KEY not set');

  const from = fromNumber || process.env.RETELL_PHONE_NUMBER;
  if (!from) throw new Error('No from_number — set RETELL_PHONE_NUMBER env var');

  const agent = agentId || process.env.RETELL_AGENT_ID;
  if (!agent) throw new Error('No agent_id — set RETELL_AGENT_ID env var');

  if (!toNumber) throw new Error('toNumber is required');
  if (!CALL_TYPES[callType]) throw new Error(`Invalid callType: ${callType}. Must be one of: ${Object.keys(CALL_TYPES).join(', ')}`);

  const payload = {
    from_number: from,
    to_number: toNumber,
    override_agent_id: agent,
    retell_llm_dynamic_variables: {
      call_type: callType,
      customer_data: JSON.stringify(customerData),
    },
    metadata: {
      call_type: callType,
      outbound: true,
      customer_data: customerData,
    },
  };

  console.log(`[outboundCaller] Triggering ${callType} call to ${toNumber}`);

  const res = await fetch(`${RETELL_API}/v2/create-phone-call`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${retellApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Retell API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  console.log(`[outboundCaller] Call initiated — call_id: ${data.call_id}`);
  return data;
}

module.exports = { triggerOutboundCall, CALL_TYPES };
