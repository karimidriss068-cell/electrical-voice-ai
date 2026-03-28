const REQUIRED_FIELDS = {
  EMERGENCY: {
    common: ['name', 'phone', 'address'],
    specific: ['issue', 'anyone_in_danger', 'power_out'],
  },
  BOOKING: {
    common: ['name', 'phone', 'address'],
    specific: ['service_needed', 'preferred_date', 'preferred_time', 'access_notes'],
  },
  QUOTE: {
    common: ['name', 'phone', 'address'],
    specific: ['job_description', 'property_type', 'building_age', 'panel_info'],
  },
  JOB_STATUS: {
    common: ['name', 'phone'],
    specific: ['booking_name', 'approximate_date'],
  },
  HUMAN_TRANSFER: {
    common: ['name', 'phone'],
    specific: ['reason'],
  },
};

/**
 * Validates and enriches the raw action data extracted from Claude's response.
 *
 * @param {Array} transcript - The full conversation transcript [{role, content}]
 * @param {object} actionData - The parsed action: { type: string, data: object }
 * @returns {{ isValid: boolean, missingFields: string[], enrichedData: object }}
 */
function classifyAndEnrich(transcript, actionData) {
  const { type, data } = actionData || {};

  if (!type || !data) {
    return { isValid: false, missingFields: ['type', 'data'], enrichedData: {} };
  }

  const schema = REQUIRED_FIELDS[type];
  if (!schema) {
    return { isValid: false, missingFields: [`unknown_type:${type}`], enrichedData: data };
  }

  // Check all required fields
  const allRequired = [...schema.common, ...schema.specific];
  const missingFields = [];

  for (const field of allRequired) {
    const value = data[field];
    if (value === undefined || value === null || value === '') {
      missingFields.push(field);
    }
  }

  // Build the enriched data object
  const rawTranscript = formatTranscript(transcript);

  const enrichedData = {
    type,
    caller: {
      name: data.name || null,
      phone: data.phone || null,
      address: data.address || null,
    },
    details: {},
    priority: type === 'EMERGENCY' ? 'URGENT' : 'NORMAL',
    raw_transcript: rawTranscript,
  };

  // Populate intent-specific details (everything that isn't a common field)
  for (const field of schema.specific) {
    enrichedData.details[field] = data[field] !== undefined ? data[field] : null;
  }

  return {
    isValid: missingFields.length === 0,
    missingFields,
    enrichedData,
  };
}

/**
 * Converts a transcript array into a plain text string.
 */
function formatTranscript(transcript) {
  if (!transcript || !Array.isArray(transcript) || transcript.length === 0) {
    return '';
  }
  return transcript
    .map((t) => {
      const label = t.role === 'agent' ? 'Volt' : 'Caller';
      return `${label}: ${t.content}`;
    })
    .join('\n');
}

module.exports = { classifyAndEnrich, formatTranscript };
