const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
require('dotenv').config();

const { PORT, COMPANY_NAME } = require('../config/constants');
const retellHandler = require('./retellHandler');
const { handleRetellWebSocket } = require('./retellWebSocket');
const { handleOutboundWebSocket } = require('./outboundWebSocket');
const callLog = require('./callLog');
const { triggerOutboundCall, CALL_TYPES } = require('./outboundCaller');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

// Serve admin dashboard
app.use(express.static(path.join(__dirname, '..', 'public')));

// Dashboard API
app.get('/api/dashboard', (req, res) => {
  res.json({
    stats: callLog.getStats(),
    recent_calls: callLog.getRecentCalls(50),
    server_uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'electrical-voice-ai',
    company: COMPANY_NAME,
    timestamp: new Date().toISOString(),
    config: {
      openai_key_set: !!process.env.OPENAI_API_KEY,
      retell_key_set: !!process.env.RETELL_API_KEY,
      company: process.env.COMPANY_NAME || 'NOT SET',
    },
  });
});

// Outbound call trigger
// POST /api/outbound-call { toNumber, callType, customerData }
// callType options: APPOINTMENT_REMINDER | JOB_FOLLOWUP | QUOTE_FOLLOWUP | EMERGENCY_FOLLOWUP | LEAD_NURTURE | PAYMENT_REMINDER
app.post('/api/outbound-call', async (req, res) => {
  const { toNumber, callType, customerData } = req.body;
  if (!toNumber || !callType) {
    return res.status(400).json({ error: 'toNumber and callType are required' });
  }
  try {
    const result = await triggerOutboundCall({ toNumber, callType, customerData: customerData || {} });
    res.json({ success: true, call_id: result.call_id, call_type: callType });
  } catch (err) {
    console.error('[outbound-call]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// List available outbound call types
app.get('/api/outbound-call/types', (_req, res) => {
  res.json({ call_types: Object.keys(CALL_TYPES) });
});

// HTTP POST fallback for Retell webhook
app.use('/retell-webhook', retellHandler);

// WebSocket server — handle ALL paths (Retell appends call_id to the path)
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws, req) => {
  const pathname = req.url || '';
  console.log(`[WebSocket] New connection on path: ${pathname}`);
  if (pathname.startsWith('/llm-websocket/outbound')) {
    handleOutboundWebSocket(ws);
  } else {
    handleRetellWebSocket(ws);
  }
});

// Handle WebSocket upgrade manually to accept any path
server.on('upgrade', (request, socket, head) => {
  const pathname = request.url;
  console.log(`[WebSocket] Upgrade request on path: ${pathname}`);

  if (pathname.startsWith('/llm-websocket') || pathname.startsWith('/retell-webhook')) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    console.log(`[WebSocket] Rejecting upgrade on unknown path: ${pathname}`);
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`[electrical-voice-ai] ${COMPANY_NAME} voice server running on port ${PORT}`);
  console.log(`[electrical-voice-ai] WebSocket: /llm-websocket/* and /retell-webhook/*`);
  console.log(`[electrical-voice-ai] HTTP POST: /retell-webhook`);
});
