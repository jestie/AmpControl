/**
 * Small in-memory lockout for failed logins, per username+IP. It protects a
 * LAN app from password guessing without adding a dependency. Restarting the
 * service clears it; that is acceptable for this deployment.
 */
class LoginLimiter {
  constructor({ maxFailures = 5, windowMs = 15 * 60 * 1000 } = {}) {
    this.maxFailures = maxFailures;
    this.windowMs = windowMs;
    this.entries = new Map();
  }

  _key(ip, username) {
    return `${ip || 'unknown'}|${String(username || '').toLowerCase()}`;
  }

  _prune(now) {
    for (const [key, entry] of this.entries) {
      if (entry.lockedUntil && entry.lockedUntil <= now && now - entry.firstFailure > this.windowMs) {
        this.entries.delete(key);
      }
    }
  }

  check(ip, username, now = Date.now()) {
    this._prune(now);
    const entry = this.entries.get(this._key(ip, username));
    if (!entry) return { blocked: false, retryAfter: 0 };
    if (entry.lockedUntil > now) {
      return { blocked: true, retryAfter: Math.ceil((entry.lockedUntil - now) / 1000) };
    }
    return { blocked: false, retryAfter: 0 };
  }

  fail(ip, username, now = Date.now()) {
    const key = this._key(ip, username);
    const entry = this.entries.get(key);
    if (!entry || now - entry.firstFailure > this.windowMs) {
      this.entries.set(key, { count: 1, firstFailure: now, lockedUntil: 0 });
      return { blocked: false, remaining: this.maxFailures - 1 };
    }
    entry.count += 1;
    if (entry.count >= this.maxFailures) {
      entry.lockedUntil = now + this.windowMs;
      return { blocked: true, remaining: 0 };
    }
    return { blocked: false, remaining: this.maxFailures - entry.count };
  }

  reset(ip, username) {
    this.entries.delete(this._key(ip, username));
  }
}

module.exports = { LoginLimiter };
