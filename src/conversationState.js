// In-memory conversation state manager for concurrent calls

const calls = new Map();

const STALE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function logTransition(callId, state) {
  const intent = state.current_intent || 'none';
  const turn = state.turn_count;
  console.log(`[STATE] call_id=${callId} intent=${intent} turn=${turn}`);
}

/**
 * Returns existing state for a call, or creates a new one.
 */
function getState(callId) {
  if (calls.has(callId)) {
    return calls.get(callId);
  }

  const now = new Date();
  const state = {
    call_id: callId,
    started_at: now,
    from_number: null,
    current_intent: null,
    collected_data: {},
    action_fired: false,
    turn_count: 0,
    last_activity: now,
    // Internal fields used by retellHandler
    transcript: [],
    handedOff: false,
  };

  calls.set(callId, state);
  logTransition(callId, state);
  return state;
}

/**
 * Merges an updates object into the existing call state.
 * Creates the state if it doesn't exist.
 */
function updateState(callId, updates) {
  const state = getState(callId);
  state.last_activity = new Date();

  // Map legacy field names to the new schema
  if (updates.intent !== undefined) {
    updates.current_intent = updates.intent;
    delete updates.intent;
  }
  if (updates.n8nTriggered !== undefined) {
    updates.action_fired = updates.n8nTriggered;
    delete updates.n8nTriggered;
  }

  // Merge collected_data if updates contain caller info fields
  const dataFields = ['callerName', 'callerPhone', 'callerEmail', 'callerAddress',
    'serviceRequested', 'preferredDate', 'preferredTime', 'urgency', 'notes'];

  for (const field of dataFields) {
    if (updates[field] !== undefined) {
      state.collected_data[field] = updates[field];
      delete updates[field];
    }
  }

  Object.assign(state, updates);
  logTransition(callId, state);
  return state;
}

/**
 * Sets a single field on the call state.
 */
function setState(callId, key, value) {
  const state = getState(callId);
  state.last_activity = new Date();
  state[key] = value;
  logTransition(callId, state);
  return state;
}

/**
 * Adds a transcript entry and increments the turn count for user messages.
 */
function addTranscriptEntry(callId, role, content) {
  const state = getState(callId);
  state.last_activity = new Date();
  state.transcript.push({ role, content, timestamp: Date.now() });
  if (role === 'user') {
    state.turn_count++;
  }
  return state;
}

/**
 * Deletes state for a finished call.
 */
function clearState(callId) {
  const had = calls.has(callId);
  calls.delete(callId);
  if (had) {
    console.log(`[STATE] call_id=${callId} cleared`);
  }
  return had;
}

/**
 * Returns the count and list of all active call IDs.
 */
function getAllActive() {
  const callIds = [...calls.keys()];
  return { count: callIds.length, callIds };
}

// Cleanup stale calls every 5 minutes
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [id, state] of calls) {
    const lastActive = state.last_activity instanceof Date
      ? state.last_activity.getTime()
      : state.last_activity;
    if (now - lastActive > STALE_TTL_MS) {
      calls.delete(id);
      cleaned++;
      console.log(`[STATE] call_id=${id} expired (stale >2h)`);
    }
  }
  if (cleaned > 0) {
    console.log(`[STATE] Cleanup: removed ${cleaned} stale call(s), ${calls.size} active`);
  }
}, CLEANUP_INTERVAL_MS);

// Backward-compatible aliases used by retellHandler
const create = getState;
const get = getState;
const update = updateState;
const remove = clearState;

module.exports = {
  getState,
  updateState,
  setState,
  clearState,
  getAllActive,
  addTranscriptEntry,
  // Aliases
  create,
  get,
  update,
  remove,
};
