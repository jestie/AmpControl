const net = require('net');
const BaseDriver = require('./base');
const { assertSingleLine } = require('./errors');

/**
 * Onkyo / Pioneer (2016+) / Integra: eISCP over TCP 60128.
 *
 * Every message is a 16-byte header ("ISCP", header size 16, data size,
 * version 1, 3 reserved bytes) followed by "!1" + command + CR. Commands are
 * three letters plus a parameter, e.g. PWR01 (on), PWR00 (standby), PWRQSTN
 * (query), MVL28 (volume, hex), AMT01 (mute on), SLI2B (input NET). Replies
 * use the same framing and end in EOF (0x1A) and/or CR/LF.
 *
 * Volume is hex; most models use 0..80 (0x50), some 0..100 or 0..200 in half
 * steps: set `volumeMax` in the device config if yours differs.
 *
 * EXPERIMENTAL: written from the published protocol and tested against a fake
 * device; not yet confirmed on real hardware.
 */
const DEFAULT_INPUTS = [
  { id: '10', label: 'BD/DVD' }, { id: '01', label: 'CBL/SAT' }, { id: '02', label: 'Game' },
  { id: '05', label: 'PC' }, { id: '03', label: 'AUX' }, { id: '23', label: 'CD' },
  { id: '22', label: 'Phono' }, { id: '12', label: 'TV' }, { id: '24', label: 'FM' },
  { id: '2B', label: 'Network' }, { id: '2E', label: 'Bluetooth' }, { id: '29', label: 'USB' }
];

function frame(command) {
  const data = Buffer.from(`!1${command}\r`, 'ascii');
  const header = Buffer.alloc(16);
  header.write('ISCP', 0, 'ascii');
  header.writeUInt32BE(16, 4);
  header.writeUInt32BE(data.length, 8);
  header.writeUInt8(1, 12);
  return Buffer.concat([header, data]);
}

// Pull complete "!1XXX..." messages out of a byte stream.
function parseMessages(buffer) {
  const messages = [];
  let rest = buffer;
  while (rest.length >= 16 && rest.toString('ascii', 0, 4) === 'ISCP') {
    const headerSize = rest.readUInt32BE(4);
    const dataSize = rest.readUInt32BE(8);
    if (rest.length < headerSize + dataSize) break;
    const text = rest.toString('utf8', headerSize, headerSize + dataSize).replace(/[\x1a\r\n]+$/g, '');
    if (text.startsWith('!1')) messages.push(text.slice(2));
    rest = rest.subarray(headerSize + dataSize);
  }
  return { messages, rest };
}

class OnkyoDriver extends BaseDriver {
  constructor(config = {}) {
    super(config);
    this.host = config.host;
    this.port = config.port || 60128;
    this.timeout = config.timeout || 3000;
    this.volumeMax = Number(config.volumeMax) || 80;
    this.inputs = (Array.isArray(config.inputs) && config.inputs.length ? config.inputs : DEFAULT_INPUTS)
      .filter((i) => /^[0-9A-F]{2}$/i.test(String(i.id)))
      .map((i) => ({ id: String(i.id).toUpperCase(), label: i.label || i.id }));
    this.queue = Promise.resolve();
  }

  // One command at a time; wait for the reply whose prefix matches (e.g. PWR).
  _send(command, { expect = command.slice(0, 3), wait = true } = {}) {
    try { assertSingleLine(command); } catch (e) { return Promise.reject(e); }
    if (!/^[A-Z]{3}[A-Za-z0-9 _.-]{0,60}$/.test(command)) return Promise.reject(new Error('invalid command'));
    const run = () => new Promise((resolve, reject) => {
      let settled = false;
      let buffer = Buffer.alloc(0);
      const socket = net.createConnection({ host: this.host, port: this.port });
      const finish = (err, value) => { if (settled) return; settled = true; socket.destroy(); if (err) reject(err); else resolve(value); };
      socket.setTimeout(this.timeout);
      socket.on('connect', () => {
        socket.write(frame(command));
        if (!wait) setTimeout(() => finish(null, ''), 150);
      });
      socket.on('data', (chunk) => {
        const parsed = parseMessages(Buffer.concat([buffer, chunk]));
        buffer = parsed.rest;
        const hit = parsed.messages.find((m) => m.startsWith(expect));
        if (hit) finish(null, hit);
      });
      socket.on('timeout', () => finish(new Error(`timeout after ${this.timeout}ms (${command.slice(0, 3)})`)));
      socket.on('error', (err) => finish(err));
    });
    const result = this.queue.then(run, run);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async init() {
    try { return (await this._send('PWRQSTN')).startsWith('PWR'); } catch (e) { return false; }
  }

  async getPowerState() {
    const r = await this._send('PWRQSTN');
    return r === 'PWR01' ? 'on' : r === 'PWR00' ? 'standby' : 'unknown';
  }
  async powerOn() { await this._send('PWR01'); return true; }
  async powerOff() { await this._send('PWR00'); return true; }

  async getVolume() {
    const r = await this._send('MVLQSTN');
    const raw = parseInt(r.slice(3), 16);
    if (!Number.isFinite(raw)) throw new Error('unexpected volume reply');
    return Math.round((raw / this.volumeMax) * 100);
  }
  async setVolume(percent) {
    const p = Number(percent);
    if (!Number.isFinite(p)) throw new Error('volume must be a number');
    const raw = Math.max(0, Math.min(this.volumeMax, Math.round((p / 100) * this.volumeMax)));
    await this._send(`MVL${raw.toString(16).toUpperCase().padStart(2, '0')}`);
    return true;
  }

  async getMute() { return (await this._send('AMTQSTN')) === 'AMT01'; }
  async mute() { await this._send('AMT01'); return true; }
  async unmute() { await this._send('AMT00'); return true; }

  getInputs() { return this.inputs.map((i) => ({ id: i.id, label: i.label })); }
  async getInput() {
    const r = await this._send('SLIQSTN');
    return r.slice(3).toUpperCase() || null;
  }
  async setInput(input) {
    const id = String(input || '').toUpperCase();
    if (!this.inputs.some((i) => i.id === id)) throw new Error(`unknown input: ${input}`);
    await this._send(`SLI${id}`);
    return true;
  }

  // Network playback (NET input): NTC = transport, NTI/NAT/NAL = title/artist/album.
  async setPlayState(state) {
    const map = { play: 'PLAY', pause: 'PAUSE', stop: 'STOP' };
    if (!map[state]) throw new Error(`unsupported play state: ${state}`);
    await this._send(`NTC${map[state]}`, { wait: false });
    return true;
  }
  async playPause() { await this._send('NTCPAUSE', { wait: false }); return true; }
  async next() { await this._send('NTCTRUP', { wait: false }); return true; }
  async previous() { await this._send('NTCTRDN', { wait: false }); return true; }
  async getPlayState() {
    const r = await this._send('NSTQSTN');   // NSTprs: p = P(lay) S(top) p(ause) F(F) R(EW)
    const c = r.charAt(3);
    return c === 'P' ? 'play' : c === 'p' ? 'pause' : 'stop';
  }

  async getNowPlaying() {
    const [title, artist, album] = await Promise.all([
      this._send('NTIQSTN').then((r) => r.slice(3)).catch(() => ''),
      this._send('NATQSTN').then((r) => r.slice(3)).catch(() => ''),
      this._send('NALQSTN').then((r) => r.slice(3)).catch(() => '')
    ]);
    if (!title && !artist) return null;
    return { type: 'song', song: title, artist, album, station: '', image_url: null };
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
    return { power: true, volume: true, mute: true, inputs: this.inputs.length > 0, presets: false, playStream: false, transport: true, nowPlaying: true };
  }
}

module.exports = OnkyoDriver;
module.exports.frame = frame;
module.exports.parseMessages = parseMessages;
