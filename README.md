# electrical-voice-ai

Voice AI receptionist backend for an electrical services company, powered by Retell AI.

## Architecture

```
Caller → Retell AI → /retell/webhook → intentRouter → n8nClient → n8n workflows
                           ↓
                   conversationState (in-memory per-call state)
                           ↓
                    systemPrompt (Volt persona)
```

### Components

| File | Purpose |
|------|---------|
| `src/server.js` | Express app — mounts middleware and routes |
| `src/retellHandler.js` | Handles Retell webhook events: `call_started`, `call_ended`, `agent_response_required` |
| `src/intentRouter.js` | Classifies caller intent from transcript text and routes to the appropriate action |
| `src/n8nClient.js` | Fires webhooks to n8n for booking requests, quotes, emergencies, summaries, and handoffs |
| `src/conversationState.js` | In-memory per-call state store with auto-cleanup |
| `prompts/systemPrompt.js` | Builds the full system prompt for Volt, the AI receptionist |
| `config/constants.js` | All configuration — services list, business hours, env vars |

### Webhook Events Sent to n8n

| Event | Trigger |
|-------|---------|
| `new_booking_request` | Caller wants to book and provided name + phone |
| `quote_request` | Caller wants a quote and provided name |
| `emergency_alert` | Caller describes an electrical emergency |
| `call_summary` | Every call end — full transcript and collected data |
| `human_handoff` | Caller requests to speak with a real person |

## Setup

```bash
cp .env.example .env
# Fill in your API keys and config values
npm install
npm start
```

## Development

```bash
npm run dev   # uses --watch for auto-restart
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/retell/webhook` | Main Retell AI webhook |
