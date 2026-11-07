const https = require('https');
const { parseChangelog } = require('./version');

/**
 * "Is there a newer SoundControl?" — compares the running version with the
 * latest release tag on GitHub, and reads that release's CHANGELOG so the app
 * can show what is new.
 *
 * Privacy: only the public GitHub API and raw files are contacted, with a
 * generic User-Agent; nothing about the install, user or network is sent.
 * Switch off with UPDATE_CHECK=off. Results are cached (default 6 hours).
 * Only fixed GitHub hosts are used; the repository comes from the server's own
 * configuration, never from a request.
 */
const REPO_RE = /^[A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_.-]{1,100}$/;

function parseSemver(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim());
  return m ? m.slice(1).map(Number) : null;
}

function compareSemver(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

function httpsGet(host, path, { accept = 'application/json', timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get({ host, path, timeout, headers: { 'User-Agent': 'SoundControl-update-check', Accept: accept } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 2000000) req.destroy(new Error('reply too large')); });
      res.on('end', () => (res.statusCode === 200 ? resolve(body) : reject(new Error(`GitHub answered ${res.statusCode}`))));
    });
    req.on('timeout', () => req.destroy(new Error('GitHub did not answer in time')));
    req.on('error', reject);
  });
}

class UpdateChecker {
  constructor({ currentVersion, repo = process.env.UPDATE_REPO || 'jestie/AmpControl', enabled = process.env.UPDATE_CHECK !== 'off', cacheMs = 6 * 3600 * 1000, get = httpsGet, logger } = {}) {
    this.current = currentVersion;
    this.repo = REPO_RE.test(repo) ? repo : 'jestie/AmpControl';
    this.enabled = enabled;
    this.cacheMs = cacheMs;
    this.get = get;
    this.logger = logger || { info() {} };
    this.result = null;
    this.checkedAt = 0;
    this.pending = null;
  }

  async check({ force = false } = {}) {
    if (!this.enabled) return { enabled: false, current: this.current };
    if (!force && this.result && Date.now() - this.checkedAt < this.cacheMs) return this.result;
    if (this.pending) return this.pending;
    this.pending = this._fetch().finally(() => { this.pending = null; });
    return this.pending;
  }

  async _fetch() {
    try {
      const tags = JSON.parse(await this.get('api.github.com', `/repos/${this.repo}/tags?per_page=100`));
      const versions = (Array.isArray(tags) ? tags : []).map((t) => t && t.name).filter((n) => parseSemver(n));
      versions.sort((a, b) => compareSemver(b, a));
      const latest = versions[0] || null;
      const updateAvailable = Boolean(latest && compareSemver(latest, this.current) > 0);
      let changes = [];
      if (updateAvailable) {
        // What changed between the running version and the latest one.
        const md = await this.get('raw.githubusercontent.com', `/${this.repo}/${encodeURIComponent(latest)}/CHANGELOG.md`, { accept: 'text/plain' }).catch(() => '');
        changes = parseChangelog(md).filter((r) => compareSemver(r.version, this.current) > 0).slice(0, 10);
      }
      this.result = {
        enabled: true,
        current: this.current,
        latest: latest ? latest.replace(/^v/, '') : null,
        updateAvailable,
        changes,
        releaseUrl: latest ? `https://github.com/${this.repo}/releases/tag/${encodeURIComponent(latest)}` : null,
        checkedAt: new Date().toISOString()
      };
      this.checkedAt = Date.now();
      if (updateAvailable) this.logger.info({ action: 'update_available', current: this.current, latest: this.result.latest });
      return this.result;
    } catch (e) {
      // Offline or rate-limited: try again in 30 minutes, keep any older answer.
      this.checkedAt = Date.now() - this.cacheMs + 30 * 60 * 1000;
      this.result = { ...(this.result || { enabled: true, current: this.current, latest: null, updateAvailable: false, changes: [] }), error: e.message };
      return this.result;
    }
  }
}

module.exports = { UpdateChecker, compareSemver, parseSemver };
