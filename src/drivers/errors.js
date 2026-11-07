/**
 * Errors shown to users must not reveal device addresses or ports (SC-03).
 * Network failures become a plain message; any address left in other text is
 * masked. The original stays available as `cause` for the server log.
 */
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN', 'ECONNRESET', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);
const ADDRESS = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b|\[[0-9a-f:]+\](?::\d{1,5})?/gi;

function publicError(err) {
  const original = err instanceof Error ? err : new Error(String(err));
  let message;
  if (NETWORK_CODES.has(original.code) || /^connect E[A-Z]+|^getaddrinfo E[A-Z]+/.test(original.message)) message = 'the amp is not answering';
  else if (/timeout after \d+ms/i.test(original.message)) message = 'the amp did not answer in time';
  else message = original.message.replace(ADDRESS, '[device]');
  const safe = new Error(message);
  safe.cause = original;
  return safe;
}

/** Refuse anything that would add a line to a line-based device protocol (SC-02). */
function assertSingleLine(command) {
  if (/[\r\n\u0000]/.test(String(command))) throw new Error('refused: command contains a line break');
}

module.exports = { publicError, assertSingleLine };
