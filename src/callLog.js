const MAX_LOG_SIZE = 500;
const callLog = [];
const dailyStats = {
  date: new Date().toDateString(),
  total: 0,
  emergencies: 0,
  bookings: 0,
  quotes: 0,
  transfers: 0,
  avgResponseMs: 0,
  responseTimes: [],
};

function resetDailyIfNeeded() {
  const today = new Date().toDateString();
  if (dailyStats.date !== today) {
    dailyStats.date = today;
    dailyStats.total = 0;
    dailyStats.emergencies = 0;
    dailyStats.bookings = 0;
    dailyStats.quotes = 0;
    dailyStats.transfers = 0;
    dailyStats.avgResponseMs = 0;
    dailyStats.responseTimes = [];
  }
}

function logCall(entry) {
  resetDailyIfNeeded();

  const record = {
    id: callLog.length + 1,
    timestamp: new Date().toISOString(),
    call_id: entry.call_id || 'unknown',
    caller_name: entry.caller_name || 'Unknown',
    caller_phone: entry.caller_phone || '',
    intent: entry.intent || 'UNKNOWN',
    status: entry.status || 'active',
    duration_seconds: entry.duration_seconds || 0,
    address: entry.address || '',
    summary: entry.summary || '',
  };

  callLog.unshift(record);
  if (callLog.length > MAX_LOG_SIZE) callLog.pop();

  dailyStats.total++;
  if (record.intent === 'EMERGENCY') dailyStats.emergencies++;
  if (record.intent === 'BOOKING') dailyStats.bookings++;
  if (record.intent === 'QUOTE') dailyStats.quotes++;
  if (record.intent === 'HUMAN_TRANSFER') dailyStats.transfers++;

  return record;
}

function logResponseTime(ms) {
  resetDailyIfNeeded();
  dailyStats.responseTimes.push(ms);
  if (dailyStats.responseTimes.length > 0) {
    dailyStats.avgResponseMs = Math.round(
      dailyStats.responseTimes.reduce((a, b) => a + b, 0) / dailyStats.responseTimes.length
    );
  }
}

function getRecentCalls(limit = 50) {
  return callLog.slice(0, limit);
}

function getStats() {
  resetDailyIfNeeded();
  const state = require('./conversationState');
  const active = state.getAllActive();

  return {
    active_calls: active.count,
    active_call_ids: active.callIds,
    today: {
      total: dailyStats.total,
      emergencies: dailyStats.emergencies,
      bookings: dailyStats.bookings,
      quotes: dailyStats.quotes,
      transfers: dailyStats.transfers,
      avg_response_ms: dailyStats.avgResponseMs,
    },
  };
}

module.exports = { logCall, logResponseTime, getRecentCalls, getStats };
