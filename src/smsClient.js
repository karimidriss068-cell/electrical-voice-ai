const axios = require('axios');

function log(msg) {
  console.log(`[${new Date().toISOString()}] [SMS] ${msg}`);
}

/**
 * Send SMS via n8n webhook (n8n handles Twilio).
 * This keeps Twilio credentials in n8n, not in this backend.
 */
async function sendSMS(to, message, callId) {
  const webhookUrl = process.env.N8N_WEBHOOK_URL;
  if (!webhookUrl) {
    log(`No N8N_WEBHOOK_URL set — skipping SMS to ${to}`);
    return;
  }

  const smsWebhookUrl = webhookUrl.replace(/\/webhook\/.*$/, '/webhook/sms-outbound');

  try {
    await axios.post(smsWebhookUrl, {
      event: 'SEND_SMS',
      to: to,
      message: message,
      call_id: callId,
      company: process.env.COMPANY_NAME || 'FES Electrical Services',
      timestamp: new Date().toISOString(),
    }, {
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Secret': process.env.N8N_WEBHOOK_SECRET || '',
      },
      timeout: 10000,
    });
    log(`SMS queued for ${to}: "${message.substring(0, 50)}..."`);
  } catch (err) {
    log(`SMS failed for ${to}: ${err.message}`);
  }
}

/**
 * Generate and send the right SMS based on action type
 */
async function sendConfirmationSMS(actionType, data, callId) {
  const phone = data.phone || data.caller?.phone;
  if (!phone) return;

  const company = process.env.COMPANY_NAME || 'FES Electrical Services';
  const companyPhone = process.env.COMPANY_PHONE || '';
  let message = '';

  switch (actionType) {
    case 'BOOKING':
      message = `Hi ${data.name || 'there'}! This is ${company}. Your appointment request has been received. `;
      if (data.preferred_date) message += `We have you down for ${data.preferred_date}`;
      if (data.preferred_time) message += ` (${data.preferred_time})`;
      message += `. Our team will confirm the exact time shortly.`;
      if (companyPhone) message += ` Questions? Call us at ${companyPhone}.`;
      break;

    case 'QUOTE':
      message = `Hi ${data.name || 'there'}! ${company} received your quote request. Our estimator will reach out within 2 business hours to discuss your project. `;
      if (companyPhone) message += `Questions? Call ${companyPhone}.`;
      break;

    case 'EMERGENCY':
      message = `URGENT: ${company} has dispatched a technician to ${data.address || 'your location'}. You will receive a call within 15 minutes. `;
      message += `If you are in immediate danger, call 911. `;
      if (process.env.EMERGENCY_PHONE) message += `Emergency line: ${process.env.EMERGENCY_PHONE}`;
      break;

    case 'HUMAN_TRANSFER':
      message = `Hi ${data.name || 'there'}! ${company} is connecting you with a team member. If the call dropped, we'll call you back shortly at this number.`;
      break;

    case 'CALL_COMPLETE':
      // Only send for calls that had an action
      return;

    default:
      return;
  }

  if (message) {
    await sendSMS(phone, message, callId);
  }
}

module.exports = { sendSMS, sendConfirmationSMS };
