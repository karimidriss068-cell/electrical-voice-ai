const express = require('express');
const cors = require('cors');
require('dotenv').config();

const { PORT, COMPANY_NAME } = require('../config/constants');
const retellHandler = require('./retellHandler');

const app = express();

app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'electrical-voice-ai', timestamp: new Date().toISOString() });
});

// Retell AI LLM webhook
app.use('/retell-webhook', retellHandler);

app.listen(PORT, () => {
  console.log(`[electrical-voice-ai] ${COMPANY_NAME} voice server running on port ${PORT}`);
});
