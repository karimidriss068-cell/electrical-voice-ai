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

// HTTP POST fallback for Retell webhook (older versions)
app.use('/retell-webhook', retellHandler);

// WebSocket server for Retell Custom LLM
const wss = new WebSocketServer({ server, path: '/llm-websocket' });
wss.on('connection', (ws, req) => {
  console.log(`[WebSocket] New connection from ${req.socket.remoteAddress}`);
  handleRetellWebSocket(ws);
});

// Also handle WebSocket on /retell-webhook path for flexibility
const wss2 = new WebSocketServer({ server, path: '/retell-webhook' });
wss2.on('connection', (ws, req) => {
  console.log(`[WebSocket] New connection on /retell-webhook from ${req.socket.remoteAddress}`);
  handleRetellWebSocket(ws);
});

server.listen(PORT, () => {
  console.log(`[electrical-voice-ai] ${COMPANY_NAME} voice server running on port ${PORT}`);
  console.log(`[electrical-voice-ai] WebSocket endpoints: /llm-websocket and /retell-webhook`);
  console.log(`[electrical-voice-ai] HTTP POST endpoint: /retell-webhook`);
});
