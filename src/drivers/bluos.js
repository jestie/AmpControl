const http = require('http');
const BaseDriver = require('./base');

/**
 * Bluesound / NAD (BluOS): HTTP on port 11000, XML replies.
 *
 *   GET /Status                     <status> volume, mute, state, title1..3, artist, album, image
 *   GET /Volume?level=N | ?mute=1|0 <volume mute="0">N</volume>
 *   GET /Play  /Pause  /Stop  /Skip  /Back
 *   GET /Play?url=<stream address>  play a stream
 *   GET /Presets                    <presets><preset id="1" name="…"/>…
 *   GET /Preset?id=N
 * BluOS players have no standby command in this API, so power is not offered.
 *
 * EXPERIMENTAL: written from the published protocol and tested against a fake
 * device; not yet confirmed on real hardware.
 */
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
const decode = (s) => String(s || '').replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, k) => ENTITIES[k]);
function tag(xml, name) {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decode(m[1]).trim() : '';
}
function attrs(fragment) {
  const out = {};
  for (const m of fragment.matchAll(/([a-zA-Z_][\w-]*)="([^"]*)"/g)) out[m[1]] = decode(m[2]);
  return out;
}

class BluOSDriver extends BaseDriver {
  constructor(config = {}) {
    super(config);
    this.host = config.host;
    this.port = config.port || 11000;
    this.timeout = config.timeout || 4000;
    this.presets = Array.isArray(config.presets) ? config.presets : [];
  }

  _get(pathAndQuery) {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: this.host, port: this.port, path: pathAndQuery, timeout: this.timeout }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; if (body.length > 1_000_000) req.destroy(new Error('reply too large')); });
        res.on('end', () => (res.statusCode === 200 ? resolve(body) : reject(new Error(`the player answered ${res.statusCode}`))));
      });
      req.on('timeout', () => req.destroy(new Error(`timeout after ${this.timeout}ms`)));
      req.on('error', reject);
    });
  }

  async init() {
    try {
      await this._get('/Status');
      if (!this.presets.length) {
        const xml = await this._get('/Presets').catch(() => '');
        this.presets = [...xml.matchAll(/<preset\s([^>]*?)\/?>/g)].map((m) => attrs(m[1]))
          .filter((p) => /^\d{1,3}$/.test(p.id || '')).map((p) => ({ id: Number(p.id), label: p.name || `Preset ${p.id}` }));
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  async _status() { return this._get('/Status'); }

  async getVolume() {
    const v = parseInt(tag(await this._status(), 'volume'), 10);
    if (!Number.isFinite(v)) throw new Error('unexpected volume reply');
    return Math.max(0, Math.min(100, v));
  }
  async setVolume(percent) {
    const p = Number(percent);
    if (!Number.isFinite(p)) throw new Error('volume must be a number');
    await this._get(`/Volume?level=${Math.max(0, Math.min(100, Math.round(p)))}`);
    return true;
  }

  async getMute() { return tag(await this._status(), 'mute') === '1'; }
  async mute() { await this._get('/Volume?mute=1'); return true; }
  async unmute() { await this._get('/Volume?mute=0'); return true; }

  async getPlayState() {
    const s = tag(await this._status(), 'state');
    return s === 'play' || s === 'stream' ? 'play' : s === 'pause' ? 'pause' : 'stop';
  }
  async setPlayState(state) {
    const map = { play: '/Play', pause: '/Pause', stop: '/Stop' };
    if (!map[state]) throw new Error(`unsupported play state: ${state}`);
    await this._get(map[state]);
    return true;
  }
  async playPause() { return this.setPlayState((await this.getPlayState()) === 'play' ? 'pause' : 'play'); }
  async next() { await this._get('/Skip'); return true; }
  async previous() { await this._get('/Back'); return true; }

  async playStream(url) {
    const u = String(url || '');
    if (!/^https?:\/\//i.test(u) || /[\r\n]/.test(u)) throw new Error('invalid stream address');
    await this._get(`/Play?url=${encodeURIComponent(u)}`);
    return true;
  }

  getPresets() { return this.presets.map((p) => ({ id: p.id, label: p.label })); }
  async playPreset(preset) {
    const n = parseInt(preset, 10);
    if (!Number.isInteger(n) || n < 1 || n > 999) throw new Error(`invalid preset: ${preset}`);
    await this._get(`/Preset?id=${n}`);
    return true;
  }

  async getNowPlaying() {
    const x = await this._status();
    const song = tag(x, 'title1') || tag(x, 'name');
    if (!song) return null;
    const image = tag(x, 'image');
    return {
      type: 'song',
      song,
      artist: tag(x, 'artist') || tag(x, 'title2'),
      album: tag(x, 'album') || tag(x, 'title3'),
      station: '',
      // Relative artwork paths live on the player's own address: not passed to the browser.
      image_url: /^https:\/\//i.test(image) ? image : null
    };
  }

  async getStatus() {
    const x = await this._status().catch(() => '');
    const v = parseInt(tag(x, 'volume'), 10);
    return { power: x ? 'on' : 'unknown', volume: Number.isFinite(v) ? v : null, mute: tag(x, 'mute') === '1', input: null };
  }

  capabilities() {
    return { power: false, volume: true, mute: true, inputs: false, presets: this.presets.length > 0, playStream: true, transport: true, nowPlaying: true };
  }
}

module.exports = BluOSDriver;
module.exports.tag = tag;
