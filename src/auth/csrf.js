const crypto = require('crypto');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function tokenFor(session) {
  if (!session.csrfToken) {
    session.csrfToken = crypto.randomBytes(32).toString('base64url');
  }
  return session.csrfToken;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Synchroniser-token CSRF check for every state-changing request. The token is
 * created in the session, injected into the page and sent back in the
 * X-CSRF-Token header by the UI.
 */
function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const sent = req.get('x-csrf-token') || (req.body && req.body._csrf);
  const expected = req.session && req.session.csrfToken;
  if (!expected || !sent || !safeEqual(sent, expected)) {
    return res.status(403).json({ error: 'invalid or missing CSRF token' });
  }
  return next();
}

module.exports = { tokenFor, csrfProtection, safeEqual };
