const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');
require('dotenv').config();

const { PORT, COMPANY_NAME } = require('../config/constants');
const retellHandler = require('./retellHandler');
const { handleRetellWebSocket } = require('./retellWebSocket');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

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

// HTTP POST fallback for Retell webhook
app.use('/retell-webhook', retellHandler);

// WebSocket server — handle ALL paths (Retell appends call_id to the path)
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws, req) => {
  console.log(`[WebSocket] New connection on path: ${req.url}`);
  handleRetellWebSocket(ws);
});

// Handle WebSocket upgrade manually to accept any path
server.on('upgrade', (request, socket, head) => {
  const pathname = request.url;
  console.log(`[WebSocket] Upgrade request on path: ${pathname}`);

  // Accept WebSocket connections on any path containing llm-websocket or retell-webhook
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
