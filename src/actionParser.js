/**
 * Strip ALL action blocks from AI response so nothing leaks to caller.
 * Shared between WebSocket and HTTP handlers.
 */
function stripAndExtractAction(text) {
  let spokenResponse = text;
  let actionData = null;

  const patterns = [
    /ACTIONSTART\s*(\{[\s\S]*?\})\s*ACTIONEND/,
    /ACTIONSTART\s*(\{[\s\S]*\})\s*$/,
    /##\s*ACTION\s*:\s*(\{[\s\S]*?\})\s*##/,
    /##\s*ACTION\s*:\s*(\{[\s\S]*\})\s*$/,
    /ACTION\s*:\s*(\{[\s\S]*?"type"\s*:\s*"[A-Z_]+?"[\s\S]*?\})\s*$/,
  ];

  for (const pattern of patterns) {
    const match = spokenResponse.match(pattern);
    if (match) {
      try {
        actionData = JSON.parse(match[1]);
        spokenResponse = spokenResponse.replace(match[0], '').trim();
        break;
      } catch (e) {
        try {
          let fixed = match[1];
          const open = (fixed.match(/\{/g) || []).length;
          const close = (fixed.match(/\}/g) || []).length;
          for (let i = 0; i < open - close; i++) fixed += '}';
          actionData = JSON.parse(fixed);
          spokenResponse = spokenResponse.replace(match[0], '').trim();
          break;
        } catch (e2) {
          spokenResponse = spokenResponse.replace(match[0], '').trim();
        }
      }
    }
  }

  // Safety: strip any remaining action-like text
  spokenResponse = spokenResponse
    .replace(/ACTIONSTART[\s\S]*/g, '')
    .replace(/ACTIONEND[\s\S]*/g, '')
    .replace(/##ACTION[\s\S]*/g, '')
    .replace(/##\s*$/g, '')
    .trim();

  // Remove trailing JSON leak
  const jsonLeak = spokenResponse.match(/\{"type"\s*:/);
  if (jsonLeak) {
    spokenResponse = spokenResponse.substring(0, jsonLeak.index).trim();
  }

  return { spokenResponse, actionData };
}

module.exports = { stripAndExtractAction };
