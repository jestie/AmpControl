const net = require('net');
const BaseDriver = require('./base');
const { assertSingleLine } = require('./errors');

/**
 * Denon/Marantz network control protocol (the "AVR" protocol on TCP 23).
 *
 * Used for what HEOS CLI cannot do on this hardware: mains power, the
 * hardware volume/mute and physical input selection. Commands and replies are
 * plain ASCII terminated by CR (e.g. "PW?" -> "PWSTANDBY").
 *
 * App volume is always 0-100 percent; the amp uses its own 0..volumeMax scale
 * (100 on the PM7000N, where raw MV matches the HEOS level 1:1), so levels are
 * converted at this boundary.
 */
class DenonAVRDriver extends BaseDriver {
  constructor(config = {}) {
    super(config);
    this.host = config.host;
    this.port = config.port || 23;
    this.timeout = config.timeout || 2500;
    this.volumeMax = Number.isFinite(config.volumeMax) ? config.volumeMax : 100;
    this.inputs = Array.isArray(config.inputs) ? config.inputs : [];
    // The amp accepts one control connection at a time: queue commands.
    this.queue = Promise.resolve();
  }

  _request(cmd, options = {}) {
    try { assertSingleLine(cmd); } catch (e) { return Promise.reject(e); }
    const run = () => this._requestNow(cmd, options);
    const result = this.queue.then(run, run);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  _requestNow(cmd, { expectReply = true } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let data = '';
      const socket = net.createConnection({ host: this.host, port: this.port });

      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (err) reject(err);
        else resolve(value);
      };

      socket.setTimeout(this.timeout);
      socket.on('connect', () => {
        socket.write(`${cmd}\r`);
        // Set commands often produce no reply at all; do not hold the request open.
        if (!expectReply) setTimeout(() => finish(null, ''), 120);
      });
      socket.on('data', (chunk) => {
        data += chunk.toString('latin1');
        if (data.includes('\r')) finish(null, data.replace(/\r/g, '').trim());
      });
      socket.on('timeout', () => finish(new Error(`AVR timeout after ${this.timeout}ms (${cmd})`)));
      socket.on('error', (err) => finish(err));
    });
  }

  async init() {
    // No handshake in this protocol. Prove the device answers a cheap query.
    const reply = await this._request('PW?');
    return reply.startsWith('PW');
  }

  async getPowerState() {
    const reply = await this._request('PW?');
    if (reply.startsWith('PWON')) return 'on';
    if (reply.startsWith('PWSTANDBY')) return 'standby';
    return 'unknown';
  }

  async powerOn() {
    await this._request('PWON', { expectReply: false });
    return true;
  }

  async powerOff() {
    await this._request('PWSTANDBY', { expectReply: false });
    return true;
  }

  async getVolume() {
    const reply = await this._request('MV?');
    const match = /^MV(\d{1,3})$/.exec(reply);
    if (!match) throw new Error(`unexpected volume reply: ${reply}`);
    return Math.round((parseInt(match[1], 10) / this.volumeMax) * 100);
  }

  async setVolume(percent) {
    const requested = Number(percent);
    if (!Number.isFinite(requested)) throw new Error('volume must be a number');
    const raw = Math.max(0, Math.min(this.volumeMax, Math.round((requested / 100) * this.volumeMax)));
    await this._request(`MV${String(raw).padStart(2, '0')}`, { expectReply: false });
    return true;
  }

  async getMute() {
    const reply = await this._request('MU?');
    return reply.startsWith('MUON');
  }

  async mute() {
    await this._request('MUON', { expectReply: false });
    return true;
  }

  async unmute() {
    await this._request('MUOFF', { expectReply: false });
    return true;
  }

  getInputs() {
    return this.inputs.map((input) => ({ id: input.id, label: input.label }));
  }

  async getInput() {
    const reply = await this._request('SI?');
    if (!reply.startsWith('SI')) return null;
    const code = reply.slice(2).toUpperCase();
    const known = this.inputs.find((input) => String(input.id).toUpperCase() === code);
    return known ? known.id : code.toLowerCase();
  }

  async setInput(input) {
    const wanted = String(input || '').toUpperCase();
    const known = this.inputs.find((entry) => String(entry.id).toUpperCase() === wanted);
    if (!known) throw new Error(`unknown input: ${input}`);
    await this._request(`SI${known.id.toUpperCase()}`, { expectReply: false });
    return true;
  }

  // Source Direct bypasses the tone controls. Verified 2026-11-07: "PSSDI ?"
  // answers "PSSDI ON" even in standby.
  async getSourceDirect() {
    const reply = await this._request('PSSDI ?');
    const match = /^PSSDI (ON|OFF)$/.exec(reply);
    if (!match) throw new Error(`unexpected source direct reply: ${reply}`);
    return match[1] === 'ON';
  }

  async setSourceDirect(on) {
    const wanted = Boolean(on);
    await this._request(`PSSDI ${wanted ? 'ON' : 'OFF'}`, { expectReply: false });
    // Never report a change the amp did not make: read it back.
    const actual = await this.getSourceDirect();
    if (actual !== wanted) throw new Error(`the amp kept Source Direct ${actual ? 'on' : 'off'}`);
    return true;
  }

  // ---- Handset (RC004PM) helpers ----

  static _sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  // Try a source code the config does not list; read SI? back to see if the
  // amp took it (this unit ignores sources that are disabled in its setup).
  async trySource(code) {
    const wanted = String(code).toUpperCase();
    if (!/^[A-Z0-9]{2,12}$/.test(wanted)) throw new Error('invalid source code');
    await this._request(`SI${wanted}`, { expectReply: false });
    await DenonAVRDriver._sleep(600);
    const reply = await this._request('SI?');
    return reply.toUpperCase() === `SI${wanted}`;
  }

  async getSleep() {
    const reply = await this._request('SLP?');
    if (reply === 'SLPOFF') return 0;
    const match = /^SLP(\d{3})$/.exec(reply);
    if (!match) throw new Error(`unexpected sleep reply: ${reply}`);
    return parseInt(match[1], 10);
  }

  // Verified 2026-11-07: SLP030/SLP060/SLPOFF work, but a command sent right
  // after another can be dropped, so read back and retry before reporting.
  async setSleep(minutes) {
    const value = Number(minutes);
    // Manual p.69: up to 90 minutes in steps of 10.
    if (!Number.isInteger(value) || value < 0 || value > 90 || value % 10 !== 0) throw new Error('sleep must be 0-90 minutes in steps of 10');
    const cmd = value === 0 ? 'SLPOFF' : `SLP${String(value).padStart(3, '0')}`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this._request(cmd, { expectReply: false });
      await DenonAVRDriver._sleep(500);
      if (await this.getSleep().catch(() => null) === value) return value;
    }
    throw new Error('the amp did not change the sleep timer');
  }

  // Menu keys and the dimmer: the amp gives no reply to these, so the result
  // cannot be read back. Sent as-is; check the amp's display.
  async sendKey(cmd) {
    const allowed = new Set(['MNCUP', 'MNCDN', 'MNCLT', 'MNCRT', 'MNENT', 'MNRTN', 'MNMEN ON', 'MNOPT', 'MNINF', 'DIM SEL']);
    if (!allowed.has(cmd)) throw new Error('key not allowed');
    await this._request(cmd, { expectReply: false });
    return true;
  }

  async getStatus() {
    const [power, volume, mute, input] = await Promise.all([
      this.getPowerState().catch(() => 'unknown'),
      this.getVolume().catch(() => null),
      this.getMute().catch(() => null),
      this.getInput().catch(() => null)
    ]);
    return { power, volume, mute, input };
  }

  capabilities() {
    return {
      power: true,
      volume: true,
      mute: true,
      inputs: this.inputs.length > 0,
      sourceDirect: true,
      presets: false,
      playStream: false,
      transport: false,
      nowPlaying: false
    };
  }
}

module.exports = DenonAVRDriver;
