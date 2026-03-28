# n8n Integration Guide for electrical-voice-ai

This document explains how to connect your n8n workflow to the electrical-voice-ai backend. The backend sends standardized webhook payloads to n8n whenever a call event occurs, and n8n handles all downstream actions (SMS, email, calendar, database).

---

## Webhook Trigger Setup

### 1. Create the Webhook Node

In n8n, add a **Webhook** node as your workflow trigger:

- **HTTP Method**: POST
- **Path**: Choose a path (e.g., `/voice-ai-webhook`). Copy the resulting Production URL.
- Set your backend's `N8N_WEBHOOK_URL` environment variable to this URL.

### 2. Payload Shape

Every webhook from the backend sends this exact JSON structure:

```json
{
  "event": "EMERGENCY",
  "timestamp": "2026-03-28T14:30:00.000Z",
  "call_id": "call_abc123def456",
  "company": "Volt Electrical Services",
  "caller": {
    "name": "Jane Rodriguez",
    "phone": "5559876543",
    "address": "456 Oak Avenue, Austin TX 78701"
  },
  "details": {},
  "priority": "URGENT",
  "raw_transcript": "Volt: Thank you for calling...\nCaller: I smell burning..."
}
```

The `event` field will be one of: `EMERGENCY`, `BOOKING`, `QUOTE`, `JOB_STATUS`, `HUMAN_TRANSFER`, `CALL_COMPLETE`.

The `priority` field is `URGENT` for EMERGENCY events and `NORMAL` for everything else.

The `details` object contains different fields depending on the event type. Each event type's details are shown below.

### 3. EMERGENCY Payload

```json
{
  "event": "EMERGENCY",
  "timestamp": "2026-03-28T14:30:00.000Z",
  "call_id": "call_emg_001",
  "company": "Volt Electrical Services",
  "caller": {
    "name": "Jane Rodriguez",
    "phone": "5559876543",
    "address": "456 Oak Avenue, Austin TX 78701"
  },
  "details": {
    "issue": "Burning smell coming from the electrical panel in the garage",
    "anyone_in_danger": false,
    "power_out": false
  },
  "priority": "URGENT",
  "raw_transcript": "Volt: Thank you for calling Volt Electrical Services, this is Volt. How can I help you today?\nCaller: I smell something burning near my breaker box in the garage.\nVolt: I'm flagging this as an emergency right now..."
}
```

### 4. BOOKING Payload

```json
{
  "event": "BOOKING",
  "timestamp": "2026-03-28T15:00:00.000Z",
  "call_id": "call_book_002",
  "company": "Volt Electrical Services",
  "caller": {
    "name": "Mike Chen",
    "phone": "5551234567",
    "address": "789 Elm Street, Austin TX 78704"
  },
  "details": {
    "service_needed": "Panel upgrade from one hundred amps to two hundred amps",
    "preferred_date": "next Monday",
    "preferred_time": "morning",
    "access_notes": "Gate code is four five six seven. Dog is friendly."
  },
  "priority": "NORMAL",
  "raw_transcript": "..."
}
```

### 5. QUOTE Payload

```json
{
  "event": "QUOTE",
  "timestamp": "2026-03-28T15:15:00.000Z",
  "call_id": "call_qt_003",
  "company": "Volt Electrical Services",
  "caller": {
    "name": "Sarah Thompson",
    "phone": "5552223333",
    "address": "1200 Congress Ave, Austin TX 78701"
  },
  "details": {
    "job_description": "Full rewire of a nineteen sixty two ranch home, knob and tube still in the attic",
    "property_type": "residential",
    "building_age": "1962",
    "panel_info": "Original one hundred amp panel, Federal Pacific breakers"
  },
  "priority": "NORMAL",
  "raw_transcript": "..."
}
```

### 6. JOB_STATUS Payload

```json
{
  "event": "JOB_STATUS",
  "timestamp": "2026-03-28T16:00:00.000Z",
  "call_id": "call_js_004",
  "company": "Volt Electrical Services",
  "caller": {
    "name": "Tom Williams",
    "phone": "5554445555",
    "address": null
  },
  "details": {
    "booking_name": "Tom Williams",
    "approximate_date": "last Wednesday"
  },
  "priority": "NORMAL",
  "raw_transcript": "..."
}
```

### 7. HUMAN_TRANSFER Payload

```json
{
  "event": "HUMAN_TRANSFER",
  "timestamp": "2026-03-28T16:30:00.000Z",
  "call_id": "call_ht_005",
  "company": "Volt Electrical Services",
  "caller": {
    "name": "Lisa Park",
    "phone": "5556667777",
    "address": null
  },
  "details": {
    "reason": "Caller wants to discuss a large commercial build-out and needs a project manager"
  },
  "priority": "NORMAL",
  "raw_transcript": "..."
}
```

### 8. CALL_COMPLETE Payload

Sent at the end of every call regardless of intent. Use this for logging and analytics.

```json
{
  "event": "CALL_COMPLETE",
  "timestamp": "2026-03-28T17:00:00.000Z",
  "call_id": "call_cc_006",
  "company": "Volt Electrical Services",
  "caller": {
    "name": "Mike Chen",
    "phone": "5551234567",
    "address": "789 Elm Street, Austin TX 78704"
  },
  "details": {
    "intent": "booking",
    "service_requested": "Panel upgrade",
    "urgency": null,
    "handed_off": false,
    "from_number": "+15551234567",
    "to_number": "+15550001111",
    "metadata": null
  },
  "priority": "NORMAL",
  "raw_transcript": "Volt: Thank you for calling...\nCaller: Hi, I need to schedule a panel upgrade...\nVolt: I'd be happy to help with that..."
}
```

### 9. Verifying X-Webhook-Secret

Your backend sends `X-Webhook-Secret` on every request. Verify it in n8n to ensure only your backend can trigger the workflow.

After the Webhook trigger node, add an **IF** node:

- **Condition**: Expression
- **Value 1**: `{{ $json.headers['x-webhook-secret'] }}`

  If your Webhook node does not expose headers in `$json.headers`, use the alternate expression:
  `{{ $request.headers['x-webhook-secret'] }}`

- **Operation**: equal
- **Value 2**: your secret string (the same value you set in `N8N_WEBHOOK_SECRET`)

Connect the **true** output to the rest of your workflow. Connect the **false** output to a **Respond to Webhook** node that returns status 401 with body `{"error": "Unauthorized"}`.

---

## Routing by Event Type

After the IF node (secret verified), add a **Switch** node to branch on the event type.

- **Mode**: Rules
- **Routing Property**: `{{ $json.body.event }}`

  If your Webhook node puts the body at the root level, use `{{ $json.event }}` instead.

Create these six outputs:

| Output | Condition | Value |
|--------|-----------|-------|
| Output 0 | equal | `EMERGENCY` |
| Output 1 | equal | `BOOKING` |
| Output 2 | equal | `QUOTE` |
| Output 3 | equal | `JOB_STATUS` |
| Output 4 | equal | `HUMAN_TRANSFER` |
| Output 5 | equal | `CALL_COMPLETE` |

Set **Fallback Output** to a **NoOp** or logging node so unrecognized events do not silently fail.

---

## EMERGENCY Branch

This branch must execute as fast as possible. Wire the following nodes in sequence from the EMERGENCY output of the Switch node.

### Node 1: Twilio — Send SMS to On-Call Technician

- **Node type**: Twilio (Send SMS)
- **To**: Your on-call technician's phone number (set as an n8n credential or variable)
- **From**: Your Twilio phone number
- **Message**:
  ```
  EMERGENCY DISPATCH

  Caller: {{ $json.caller.name }}
  Phone: {{ $json.caller.phone }}
  Address: {{ $json.caller.address }}

  Issue: {{ $json.details.issue }}
  Anyone in danger: {{ $json.details.anyone_in_danger }}
  Power out: {{ $json.details.power_out }}

  Call back within 15 minutes.
  ```

### Node 2: HTTP Request — Push Notification to Owner

Send a push notification via ntfy.sh (or Pushover, Pushbullet, etc.):

- **Node type**: HTTP Request
- **Method**: POST
- **URL**: `https://ntfy.sh/your-company-emergencies`
- **Headers**:
  - `Title`: `EMERGENCY — {{ $json.caller.name }}`
  - `Priority`: `urgent`
  - `Tags`: `rotating_light,zap`
- **Body (raw text)**:
  ```
  {{ $json.details.issue }}

  Address: {{ $json.caller.address }}
  Phone: {{ $json.caller.phone }}
  ```

Replace `your-company-emergencies` with your own private ntfy.sh topic.

### Node 3: Google Sheets / Database — Log Emergency

- **Node type**: Google Sheets (Append Row) or your database node
- **Spreadsheet**: "Emergency Calls" or table `emergency_calls`
- **Columns to map**:

| Column | Value |
|--------|-------|
| timestamp | `{{ $json.timestamp }}` |
| call_id | `{{ $json.call_id }}` |
| caller_name | `{{ $json.caller.name }}` |
| caller_phone | `{{ $json.caller.phone }}` |
| address | `{{ $json.caller.address }}` |
| issue | `{{ $json.details.issue }}` |
| anyone_in_danger | `{{ $json.details.anyone_in_danger }}` |
| power_out | `{{ $json.details.power_out }}` |
| status | `dispatched` |

### Node 4: Google Sheets / Database — Create Urgent Job Record

- **Node type**: Google Sheets (Append Row) or your database node
- **Spreadsheet**: "Jobs" or table `jobs`
- **Columns**:

| Column | Value |
|--------|-------|
| call_id | `{{ $json.call_id }}` |
| type | `EMERGENCY` |
| caller_name | `{{ $json.caller.name }}` |
| caller_phone | `{{ $json.caller.phone }}` |
| address | `{{ $json.caller.address }}` |
| description | `{{ $json.details.issue }}` |
| priority | `URGENT` |
| status | `pending_dispatch` |
| created_at | `{{ $json.timestamp }}` |

---

## BOOKING Branch

### Node 1: Google Calendar — Create Event

- **Node type**: Google Calendar (Create Event)
- **Calendar**: Your scheduling calendar
- **Title**: `{{ $json.details.service_needed }} — {{ $json.caller.name }}`
- **Start/End**: Parse `{{ $json.details.preferred_date }}` and `{{ $json.details.preferred_time }}` into a datetime. Since callers give natural language dates like "next Monday morning", use a **Code** node before this to resolve the date:
  ```javascript
  const preferred = $json.details.preferred_date;
  const timeWindow = $json.details.preferred_time;

  // Map time windows to hours
  const windows = { morning: '09:00', afternoon: '13:00', evening: '17:00' };
  const startHour = windows[timeWindow] || '09:00';

  // For production, use a date parsing library or let your team adjust manually
  // This creates a placeholder event that the office can move
  const startDate = new Date();
  startDate.setDate(startDate.getDate() + 1); // default to tomorrow
  const [h, m] = startHour.split(':');
  startDate.setHours(parseInt(h), parseInt(m), 0, 0);

  const endDate = new Date(startDate.getTime() + 2 * 60 * 60 * 1000); // 2 hour window

  return {
    ...$json,
    resolved_start: startDate.toISOString(),
    resolved_end: endDate.toISOString()
  };
  ```
- **Description**:
  ```
  Service: {{ $json.details.service_needed }}
  Customer: {{ $json.caller.name }}
  Phone: {{ $json.caller.phone }}
  Address: {{ $json.caller.address }}
  Time preference: {{ $json.details.preferred_time }}
  Access notes: {{ $json.details.access_notes }}
  ```
- **Location**: `{{ $json.caller.address }}`

### Node 2: Google Sheets / Database — Create Job Record

- **Spreadsheet**: "Jobs" or table `jobs`
- **Columns**:

| Column | Value |
|--------|-------|
| call_id | `{{ $json.call_id }}` |
| type | `BOOKING` |
| caller_name | `{{ $json.caller.name }}` |
| caller_phone | `{{ $json.caller.phone }}` |
| address | `{{ $json.caller.address }}` |
| service | `{{ $json.details.service_needed }}` |
| preferred_date | `{{ $json.details.preferred_date }}` |
| preferred_time | `{{ $json.details.preferred_time }}` |
| access_notes | `{{ $json.details.access_notes }}` |
| status | `pending_confirmation` |
| created_at | `{{ $json.timestamp }}` |

### Node 3: Twilio — SMS Confirmation to Caller

- **To**: `{{ $json.caller.phone }}`
- **Message**:
  ```
  Hi {{ $json.caller.name }}, thanks for calling {{ $json.company }}! We've received your booking request for {{ $json.details.service_needed }}. Our team will call you shortly to confirm your {{ $json.details.preferred_time }} appointment. Questions? Call us anytime.
  ```

### Node 4: Gmail / SMTP — Email Confirmation to Caller

If you collected an email (available in `raw_transcript` or future `details.email` field), send a confirmation. If no email is available, skip this node by adding an IF check: `{{ $json.caller.email }}` is not empty.

- **To**: Caller's email (extract from transcript or add to collected data)
- **Subject**: `Booking Confirmation — {{ $json.company }}`
- **Body**:
  ```
  Hi {{ $json.caller.name }},

  Thank you for scheduling service with {{ $json.company }}.

  Service requested: {{ $json.details.service_needed }}
  Preferred date: {{ $json.details.preferred_date }}
  Preferred time: {{ $json.details.preferred_time }}
  Service address: {{ $json.caller.address }}

  A team member will contact you to confirm the exact appointment time.

  Thank you,
  {{ $json.company }}
  ```

---

## QUOTE Branch

### Node 1: Google Sheets / Database — Create Lead Record

- **Spreadsheet**: "Leads" or table `leads`
- **Columns**:

| Column | Value |
|--------|-------|
| call_id | `{{ $json.call_id }}` |
| caller_name | `{{ $json.caller.name }}` |
| caller_phone | `{{ $json.caller.phone }}` |
| address | `{{ $json.caller.address }}` |
| job_description | `{{ $json.details.job_description }}` |
| property_type | `{{ $json.details.property_type }}` |
| building_age | `{{ $json.details.building_age }}` |
| panel_info | `{{ $json.details.panel_info }}` |
| status | `new_lead` |
| created_at | `{{ $json.timestamp }}` |

### Node 2: Gmail / SMTP — Notify Estimator

- **To**: Your estimator or sales team email
- **Subject**: `New Quote Request — {{ $json.caller.name }} — {{ $json.details.property_type }}`
- **Body**:
  ```
  New quote request from a phone call.

  Customer: {{ $json.caller.name }}
  Phone: {{ $json.caller.phone }}
  Address: {{ $json.caller.address }}

  Job Description:
  {{ $json.details.job_description }}

  Property Type: {{ $json.details.property_type }}
  Building Age: {{ $json.details.building_age }}
  Panel Info: {{ $json.details.panel_info }}

  Please follow up within 2 business hours.

  Full transcript:
  {{ $json.raw_transcript }}
  ```

### Node 3: Twilio — SMS to Caller

- **To**: `{{ $json.caller.phone }}`
- **Message**:
  ```
  Hi {{ $json.caller.name }}, we received your quote request at {{ $json.company }}. Expect a call from our estimator within 2 business hours. Thanks for reaching out!
  ```

---

## JOB_STATUS Branch

Job status lookups require querying your actual job records, which will vary depending on your database or spreadsheet setup.

### Node 1: Google Sheets / Database — Look Up Job

- **Operation**: Search / Get rows
- **Filter**: Match `caller_name` = `{{ $json.details.booking_name }}` or `caller_phone` = `{{ $json.caller.phone }}`

### Node 2: IF — Record Found?

- Check if the lookup returned results.

### Node 3 (if found): Twilio — SMS Status to Caller

- **To**: `{{ $json.caller.phone }}`
- **Message**: Include the job status from your records.

### Node 3 (if not found): Flag for Human Callback

Since job lookups often need a human to verify details, the safest approach is to create a callback task:

- **Google Sheets / Database — Append Row** to a "Callbacks" sheet:

| Column | Value |
|--------|-------|
| call_id | `{{ $json.call_id }}` |
| caller_name | `{{ $json.caller.name }}` |
| caller_phone | `{{ $json.caller.phone }}` |
| booking_name | `{{ $json.details.booking_name }}` |
| approximate_date | `{{ $json.details.approximate_date }}` |
| reason | `Job status inquiry — needs manual lookup` |
| created_at | `{{ $json.timestamp }}` |

---

## HUMAN_TRANSFER Branch

### Node 1: Google Sheets / Database — Log Transfer Request

- **Spreadsheet**: "Callbacks" or table `callbacks`

| Column | Value |
|--------|-------|
| call_id | `{{ $json.call_id }}` |
| caller_name | `{{ $json.caller.name }}` |
| caller_phone | `{{ $json.caller.phone }}` |
| reason | `{{ $json.details.reason }}` |
| status | `needs_callback` |
| created_at | `{{ $json.timestamp }}` |

### Node 2: Twilio — SMS to Office Manager

- **To**: Office manager's phone number
- **Message**:
  ```
  Callback needed: {{ $json.caller.name }} ({{ $json.caller.phone }})
  Reason: {{ $json.details.reason }}
  ```

---

## CALL_COMPLETE Branch

This fires at the end of every call. Use it for analytics and record-keeping.

### Node 1: Google Sheets / Database — Log to Call History

- **Spreadsheet**: "Call History" or table `call_history`

| Column | Value |
|--------|-------|
| call_id | `{{ $json.call_id }}` |
| timestamp | `{{ $json.timestamp }}` |
| caller_name | `{{ $json.caller.name }}` |
| caller_phone | `{{ $json.caller.phone }}` |
| caller_address | `{{ $json.caller.address }}` |
| intent | `{{ $json.details.intent }}` |
| service_requested | `{{ $json.details.service_requested }}` |
| from_number | `{{ $json.details.from_number }}` |
| to_number | `{{ $json.details.to_number }}` |
| handed_off | `{{ $json.details.handed_off }}` |
| transcript | `{{ $json.raw_transcript }}` |
| resolved | Set to `true` if intent is booking/quote/emergency (action was taken), `false` if handed_off or unknown |

---

## Emergency Redundancy Channel

The backend also sends EMERGENCY events to a second endpoint: your `N8N_WEBHOOK_URL` with `/emergency` appended.

To use this, create a separate n8n workflow with a second Webhook node:

- **Path**: Same as your main webhook path but with `/emergency` appended (e.g., `/voice-ai-webhook/emergency`)
- This workflow should only contain the EMERGENCY branch logic (SMS to tech, push notification, log).

This ensures emergencies are processed even if the main workflow is down or slow.

---

## Environment Variables and Credentials Needed in n8n

### Credentials to Configure

| Credential | Used For | n8n Credential Type |
|------------|----------|---------------------|
| Twilio | Sending SMS to callers and technicians | Twilio API |
| Gmail or SMTP | Sending email confirmations and estimator notifications | Gmail OAuth2 or SMTP |
| Google Calendar | Creating booking events | Google Calendar OAuth2 |
| Google Sheets | Logging calls, jobs, leads, emergencies | Google Sheets OAuth2 |
| ntfy.sh (or Pushover) | Emergency push notifications to owner | HTTP Request (no credential needed for ntfy.sh, just the topic URL) |

### Variables to Set in n8n Settings

Set these as n8n workflow variables or environment variables so you can reference them across nodes:

| Variable | Example Value | Used In |
|----------|--------------|---------|
| `WEBHOOK_SECRET` | `your-secret-here` | IF node for auth verification |
| `ONCALL_TECH_PHONE` | `+15559991234` | Emergency SMS |
| `OFFICE_MANAGER_PHONE` | `+15559995678` | Human transfer SMS |
| `ESTIMATOR_EMAIL` | `estimator@yourcompany.com` | Quote notification |
| `TWILIO_FROM_NUMBER` | `+15550001111` | All outbound SMS |
| `NTFY_TOPIC` | `your-company-emergencies` | Emergency push notifications |
| `SCHEDULING_CALENDAR_ID` | `primary` or a specific calendar ID | Booking calendar events |

---

## Testing with Sample Payloads

n8n lets you test workflows by manually triggering the Webhook node with sample data. Use the **Test URL** (not the Production URL) during development.

### Method 1: curl from Terminal

Test each event type by sending curl requests to your n8n test webhook URL:

**Test EMERGENCY:**
```bash
curl -X POST https://your-n8n-instance.com/webhook-test/voice-ai-webhook \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: your-secret-here" \
  -d '{
    "event": "EMERGENCY",
    "timestamp": "2026-03-28T14:30:00.000Z",
    "call_id": "test_emg_001",
    "company": "Volt Electrical Services",
    "caller": {
      "name": "Test Emergency Caller",
      "phone": "5559999999",
      "address": "123 Test Street, Austin TX 78701"
    },
    "details": {
      "issue": "Burning smell from electrical panel",
      "anyone_in_danger": false,
      "power_out": false
    },
    "priority": "URGENT",
    "raw_transcript": "Volt: How can I help?\nCaller: I smell something burning near my panel."
  }'
```

**Test BOOKING:**
```bash
curl -X POST https://your-n8n-instance.com/webhook-test/voice-ai-webhook \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: your-secret-here" \
  -d '{
    "event": "BOOKING",
    "timestamp": "2026-03-28T15:00:00.000Z",
    "call_id": "test_book_001",
    "company": "Volt Electrical Services",
    "caller": {
      "name": "Test Booking Caller",
      "phone": "5558888888",
      "address": "456 Test Ave, Austin TX 78704"
    },
    "details": {
      "service_needed": "Panel upgrade",
      "preferred_date": "next Monday",
      "preferred_time": "morning",
      "access_notes": "Ring doorbell, dog in backyard"
    },
    "priority": "NORMAL",
    "raw_transcript": "Volt: How can I help?\nCaller: I need to schedule a panel upgrade."
  }'
```

**Test QUOTE:**
```bash
curl -X POST https://your-n8n-instance.com/webhook-test/voice-ai-webhook \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: your-secret-here" \
  -d '{
    "event": "QUOTE",
    "timestamp": "2026-03-28T15:15:00.000Z",
    "call_id": "test_qt_001",
    "company": "Volt Electrical Services",
    "caller": {
      "name": "Test Quote Caller",
      "phone": "5557777777",
      "address": "789 Test Blvd, Austin TX 78702"
    },
    "details": {
      "job_description": "Full rewire of 1960s home",
      "property_type": "residential",
      "building_age": "1962",
      "panel_info": "100 amp Federal Pacific"
    },
    "priority": "NORMAL",
    "raw_transcript": "Volt: How can I help?\nCaller: I need a quote for rewiring my house."
  }'
```

**Test CALL_COMPLETE:**
```bash
curl -X POST https://your-n8n-instance.com/webhook-test/voice-ai-webhook \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: your-secret-here" \
  -d '{
    "event": "CALL_COMPLETE",
    "timestamp": "2026-03-28T17:00:00.000Z",
    "call_id": "test_cc_001",
    "company": "Volt Electrical Services",
    "caller": {
      "name": "Test Caller",
      "phone": "5556666666",
      "address": "321 Test Ln, Austin TX 78703"
    },
    "details": {
      "intent": "booking",
      "service_requested": "Panel upgrade",
      "urgency": null,
      "handed_off": false,
      "from_number": "+15556666666",
      "to_number": "+15550001111",
      "metadata": null
    },
    "priority": "NORMAL",
    "raw_transcript": "Volt: Thank you for calling...\nCaller: I need a panel upgrade...\nVolt: Great, let me get your details..."
  }'
```

### Method 2: n8n Manual Trigger

1. Open your workflow in n8n.
2. Click **Test Workflow** at the top.
3. n8n will wait for a request to the Test URL.
4. Run one of the curl commands above against the Test URL.
5. Watch the execution trace to verify each node receives the correct data and produces the expected output.
6. Check that SMS, email, calendar, and database nodes all fire correctly.

### Checklist

- [ ] EMERGENCY: SMS sent to on-call tech, push notification received, emergency row logged, job record created
- [ ] BOOKING: Calendar event created, job record logged, SMS sent to caller, email sent if email available
- [ ] QUOTE: Lead record created, estimator email sent, SMS sent to caller
- [ ] JOB_STATUS: Lookup attempted, callback task created if not found
- [ ] HUMAN_TRANSFER: Callback logged, SMS sent to office manager
- [ ] CALL_COMPLETE: Call history row logged with transcript and intent
- [ ] X-Webhook-Secret: Requests without the correct secret are rejected with 401
- [ ] Emergency redundancy: Separate `/emergency` workflow receives and processes EMERGENCY events independently
