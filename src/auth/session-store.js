const fs = require('fs');
const path = require('path');
const { Store } = require('express-session');

/**
 * Small file-backed session store (SC-06): sessions survive a restart and
 * expired ones are pruned, instead of express-session's MemoryStore which is
 * never pruned. Kept in memory, written to disk (mode 600) shortly after a
 * change. Fine for a household; no extra dependency.
 */
class FileSessionStore extends Store {
  constructor({ file, pruneEveryMs = 10 * 60 * 1000, maxSessions = 500 } = {}) {
    super();
    this.file = file || process.env.SESSIONS_FILE || path.join(__dirname, '../../data/sessions.json');
    this.maxSessions = maxSessions;
    this.sessions = new Map();
    this.timer = null;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [sid, sess] of Object.entries(data || {})) this.sessions.set(sid, sess);
    } catch (e) { /* first run */ }
    this.prune();
    this.pruner = setInterval(() => this.prune(), pruneEveryMs);
    if (this.pruner.unref) this.pruner.unref();
  }

  static expiry(sess) {
    const at = sess && sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : NaN;
    return Number.isFinite(at) ? at : Infinity;
  }

  prune() {
    const now = Date.now();
    let changed = false;
    for (const [sid, sess] of this.sessions) {
      if (FileSessionStore.expiry(sess) <= now) { this.sessions.delete(sid); changed = true; }
    }
    // Hard cap: drop the oldest-expiring sessions first.
    if (this.sessions.size > this.maxSessions) {
      const sorted = [...this.sessions.entries()].sort((a, b) => FileSessionStore.expiry(a[1]) - FileSessionStore.expiry(b[1]));
      for (const [sid] of sorted.slice(0, this.sessions.size - this.maxSessions)) this.sessions.delete(sid);
      changed = true;
    }
    if (changed) this.scheduleWrite();
  }

  scheduleWrite() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 300);
    if (this.timer.unref) this.timer.unref();
  }

  flush() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.sessions)), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) { /* the in-memory copy still works */ }
  }

  get(sid, cb) {
    const sess = this.sessions.get(sid);
    if (!sess) return cb(null, null);
    if (FileSessionStore.expiry(sess) <= Date.now()) { this.destroy(sid, () => cb(null, null)); return undefined; }
    return cb(null, JSON.parse(JSON.stringify(sess)));
  }

  set(sid, sess, cb) {
    this.sessions.set(sid, JSON.parse(JSON.stringify(sess)));
    this.scheduleWrite();
    if (cb) cb(null);
  }

  touch(sid, sess, cb) {
    const cur = this.sessions.get(sid);
    if (cur) { cur.cookie = JSON.parse(JSON.stringify(sess.cookie)); this.scheduleWrite(); }
    if (cb) cb(null);
  }

  destroy(sid, cb) {
    this.sessions.delete(sid);
    this.scheduleWrite();
    if (cb) cb(null);
  }

  length(cb) { cb(null, this.sessions.size); }

  clear(cb) { this.sessions.clear(); this.scheduleWrite(); if (cb) cb(null); }

  close() { clearInterval(this.pruner); if (this.timer) { clearTimeout(this.timer); this.timer = null; } this.flush(); }
}

module.exports = { FileSessionStore };
