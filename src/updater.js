const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { compareSemver, parseSemver } = require('./updates');

/**
 * One-click update to the latest SIGNED release.
 *
 *   1. preflight: git install, clean tracked files, on main, origin is the
 *      configured repository, trusted signers file present, not switched off
 *   2. git fetch --tags; pick the newest release tag (vX.Y.Z) newer than us
 *   3. verify the tag's SSH signature against release/allowed_signers FROM THE
 *      VERSION ALREADY INSTALLED (never from the download), and that it is a
 *      fast-forward from what we run now
 *   4. back up config/, data/ (without old backups) and .env
 *   5. git merge --ff-only <tag>; npm ci; npm test
 *   6. any failure after step 5 started: git reset --hard back + npm ci
 *      (the running server keeps the old code in memory meanwhile)
 *   7. success: restart into the new version (systemd, or a detached relaunch)
 *
 * Commands run with execFile and argument arrays (no shell); tag names are
 * validated as vX.Y.Z. Admin-only, CSRF-protected (see api.js).
 * UPDATE_INSTALL=off hides the button.
 */
const TAG_RE = /^v\d+\.\d+\.\d+$/;

function run(cmd, args, { cwd, timeout = 120000, env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout, env: env || process.env, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr || ''}`.trim();
      if (err) { err.output = out; reject(err); } else resolve(out);
    });
  });
}

class Updater {
  constructor({ root = path.join(__dirname, '..'), currentVersion, repo = process.env.UPDATE_REPO || 'jestie/AmpControl', enabled = process.env.UPDATE_INSTALL !== 'off', logger, runner = run, restart } = {}) {
    this.root = root;
    this.current = currentVersion;
    this.repo = repo;
    this.enabled = enabled;
    this.logger = logger || { info() {}, error() {} };
    this.run = runner;
    this.restart = restart || (() => Updater.relaunch(this.root));
    this.signers = path.join(this.root, 'release', 'allowed_signers');
    // Read the trusted signers NOW (from the installed version), so a download cannot replace them.
    try { this.trustedSigners = fs.readFileSync(this.signers, 'utf8'); } catch (e) { this.trustedSigners = null; }
    this.job = null;
  }

  git(args, opts = {}) { return this.run('git', args, { cwd: this.root, ...opts }); }

  /** Can this install update itself? Returns { possible, reason }. */
  async preflight() {
    if (!this.enabled) return { possible: false, reason: 'One-click update is switched off on this server (UPDATE_INSTALL=off).' };
    if (!fs.existsSync(path.join(this.root, '.git'))) return { possible: false, reason: 'This copy was not installed with git (for example from a ZIP): please update by hand (Help → Updating).' };
    if (!this.trustedSigners) return { possible: false, reason: 'This version has no trusted release signers yet: update by hand once (Help → Updating).' };
    try {
      const branch = await this.git(['rev-parse', '--abbrev-ref', 'HEAD']);
      if (branch !== 'main') return { possible: false, reason: `This copy is on "${branch}", not "main": please update by hand.` };
      const dirty = await this.git(['status', '--porcelain', '--untracked-files=no']);
      if (dirty) return { possible: false, reason: 'This copy has local code changes: please update by hand so nothing is lost.' };
      const origin = await this.git(['remote', 'get-url', 'origin']);
      if (!origin.replace(/\.git$/, '').toLowerCase().endsWith(this.repo.toLowerCase())) return { possible: false, reason: 'This copy does not come from the official repository: please update by hand.' };
    } catch (e) {
      return { possible: false, reason: 'git is not available to check this copy: please update by hand.' };
    }
    return { possible: true, reason: '' };
  }

  status() {
    if (!this.job) return { state: 'idle' };
    const { state, from, to, log, startedAt, finishedAt, error } = this.job;
    return { state, from, to, log: log.slice(-200), startedAt, finishedAt, error };
  }

  /** Start the update in the background. `expected` must be the version the admin saw. */
  async start(expected, { user } = {}) {
    if (this.job && ['running', 'restarting'].includes(this.job.state)) throw new Error('an update is already running');
    const pre = await this.preflight();
    if (!pre.possible) throw new Error(pre.reason);
    if (!parseSemver(expected)) throw new Error('invalid version');
    const job = { state: 'running', from: this.current, to: String(expected).replace(/^v/, ''), log: [], startedAt: new Date().toISOString(), user };
    this.job = job;
    this.logger.info({ action: 'update_start', from: job.from, to: job.to, user });
    this._work(job).catch(() => {});
    return this.status();
  }

  log(job, line) { job.log.push(`${new Date().toISOString().slice(11, 19)}  ${line}`); }

  async _work(job) {
    const tag = `v${job.to}`;
    let previous = null;
    let changed = false;
    try {
      if (!TAG_RE.test(tag)) throw new Error('invalid version');
      this.log(job, 'Fetching releases from GitHub…');
      await this.git(['fetch', '--tags', '--force', 'origin'], { timeout: 120000 });
      const tags = (await this.git(['tag', '--list', 'v*'])).split('\n').map((t) => t.trim()).filter((t) => TAG_RE.test(t));
      tags.sort((a, b) => compareSemver(b, a));
      if (tags[0] !== tag) throw new Error(`the newest release is ${tags[0] || 'unknown'}, not ${tag}; refresh and try again`);
      if (compareSemver(tag, this.current) <= 0) throw new Error(`${tag} is not newer than v${this.current}`);

      this.log(job, `Checking the signature of ${tag}…`);
      const trusted = path.join(this.root, 'data', 'update-trusted-signers');
      fs.mkdirSync(path.dirname(trusted), { recursive: true });
      fs.writeFileSync(trusted, this.trustedSigners, { mode: 0o600 });
      let verify;
      try {
        verify = await this.git(['-c', 'gpg.format=ssh', '-c', `gpg.ssh.allowedSignersFile=${trusted}`, 'verify-tag', tag]);
      } catch (e) {
        throw new Error(`${tag} is not signed by a trusted release key: update refused`);
      }
      if (!/Good "git" signature for /.test(verify)) throw new Error(`${tag} is not signed by a trusted release key: update refused`);
      this.log(job, '✓ Signature verified (trusted release key).');

      const target = await this.git(['rev-parse', `${tag}^{commit}`]);
      previous = await this.git(['rev-parse', 'HEAD']);
      try { await this.git(['merge-base', '--is-ancestor', previous, target]); } catch (e) { throw new Error(`${tag} does not continue from the installed version: please update by hand`); }

      this.log(job, 'Backing up settings (config, data, .env)…');
      const backups = path.join(this.root, 'data', 'backups');
      fs.mkdirSync(backups, { recursive: true });
      const archive = path.join(backups, `before-v${job.to}-${new Date().toISOString().replace(/[:.]/g, '-')}.tgz`);
      const items = ['config', 'data', '.env'].filter((p) => fs.existsSync(path.join(this.root, p)));
      await this.run('tar', ['czf', archive, '--exclude=data/backups', '-C', this.root, ...items], { cwd: this.root });
      fs.chmodSync(archive, 0o600);
      this.log(job, `✓ Backup: data/backups/${path.basename(archive)}`);

      this.log(job, `Moving to ${tag}…`);
      changed = true;
      await this.git(['merge', '--ff-only', target]);
      this.log(job, 'Installing packages (npm ci)…');
      await this.run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: this.root, timeout: 15 * 60 * 1000 });
      this.log(job, 'Running the tests (npm test)…');
      const tests = await this.run('npm', ['test'], { cwd: this.root, timeout: 10 * 60 * 1000 });
      const pass = /# pass (\d+)/.exec(tests);
      const fail = /# fail (\d+)/.exec(tests);
      if (fail && Number(fail[1]) > 0) throw new Error(`${fail[1]} test(s) failed`);
      this.log(job, `✓ Tests passed${pass ? ` (${pass[1]})` : ''}.`);

      job.state = 'restarting';
      job.finishedAt = new Date().toISOString();
      this.log(job, `Restarting into ${tag}…`);
      this.logger.info({ action: 'update_done', from: job.from, to: job.to, user: job.user });
      setTimeout(() => this.restart(), 1500);
    } catch (e) {
      const reason = (e && e.message) || 'update failed';
      this.log(job, `✗ ${reason}`);
      if (changed && previous) {
        this.log(job, 'Rolling back to the version you had…');
        try {
          await this.git(['reset', '--hard', previous]);
          await this.run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: this.root, timeout: 15 * 60 * 1000 });
          this.log(job, `✓ Rolled back to v${job.from}; nothing changed for you.`);
        } catch (rollbackError) {
          this.log(job, `✗ Rollback needs a hand: ${rollbackError.message}. Your backup is in data/backups.`);
        }
      }
      job.state = 'failed';
      job.error = reason;
      job.finishedAt = new Date().toISOString();
      this.logger.error({ action: 'update_failed', from: job.from, to: job.to, error: reason, user: job.user });
    }
  }

  /** Restart: systemd restarts us (exit 75); otherwise start a detached copy first. */
  static relaunch(root) {
    if (process.env.INVOCATION_ID) process.exit(75);   // systemd: Restart=on-failure brings the new code up
    const logFile = path.join(root, 'logs', 'app.log');
    const script = `setTimeout(() => { const fs = require('fs'); const out = fs.openSync(${JSON.stringify(logFile)}, 'a');
      require('child_process').spawn(process.execPath, ['src/server.js'], { cwd: ${JSON.stringify(root)}, detached: true, stdio: ['ignore', out, out] }).unref(); }, 2500);`;
    spawn(process.execPath, ['-e', script], { cwd: root, detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => process.exit(0), 300);
  }
}

module.exports = { Updater };
