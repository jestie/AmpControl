const http = require('http');
const BaseDriver = require('./base');

/**
 * Yamaha MusicCast (Yamaha Extended Control, "YXC"): HTTP + JSON on port 80.
 * Receivers, integrated amps, streamers and speakers with MusicCast.
 *
 *   GET /YamahaExtendedControl/v1/<zone>/getStatus      power, volume, max_volume, mute, input
 *   GET /YamahaExtendedControl/v1/<zone>/setPower?power=on|standby
 *   GET /YamahaExtendedControl/v1/<zone>/setVolume?volume=N   (0..max_volume)
 *   GET /YamahaExtendedControl/v1/<zone>/setMute?enable=true|false
 *   GET /YamahaExtendedControl/v1/<zone>/setInput?input=<id>
 *   GET /YamahaExtendedControl/v1/system/getFeatures    zone input lists
 *   GET /YamahaExtendedControl/v1/system/getNameText    friendly input names
 *   GET /YamahaExtendedControl/v1/netusb/getPlayInfo    now playing (network sources)
 *   GET /YamahaExtendedControl/v1/netusb/setPlayback?playback=play|pause|stop|next|previous
 *   GET /YamahaExtendedControl/v1/netusb/recallPreset?zone=<zone>&num=N
 * Every reply carries response_code (0 = OK).
 *
 * EXPERIMENTAL: written from the published protocol and tested against a fake
 * device; not yet confirmed on real hardware.
 */
const ID_RE = /^[a-z0-9_]{1,32}$/;

class YamahaDriver extends BaseDriver {
  constructor(config = {}) {
    super(config);
    this.host = config.host;
    this.port = config.port || 80;
    this.zone = ID_RE.test(String(config.zone || '')) ? config.zone : 'main';
    this.timeout = config.timeout || 4000;
    this.inputs = Array.isArray(config.inputs) ? config.inputs : [];   // optional override
    this.presets = Array.isArray(config.presets) ? config.presets : [];
    this.maxVolume = Number(config.maxVolume) || null;
  }

  _get(pathAndQuery) {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: this.host, port: this.port, path: `/YamahaExtendedControl/v1/${pathAndQuery}`, timeout: this.timeout, headers: { 'X-AppName': 'MusicCast/SoundControl' } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; if (body.length > 1_000_000) req.destroy(new Error('reply too large')); });
        res.on('end', () => {
          let data;
          try { data = JSON.parse(body); } catch (e) { reject(new Error('the amp sent an unreadable reply')); return; }
          if (data.response_code !== 0) { reject(new Error(`the amp refused the command (code ${data.response_code})`)); return; }
          resolve(data);
        });
      });
      req.on('timeout', () => req.destroy(new Error(`timeout after ${this.timeout}ms`)));
      req.on('error', reject);
    });
  }

  async init() {
    try {
      const features = await this._get('system/getFeatures');
      const zone = (features.zone || []).find((z) => z.id === this.zone) || {};
      const range = (zone.range_step || []).find((r) => r.id === 'volume');
      if (!this.maxVolume && range) this.maxVolume = Number(range.max) || null;
      if (!this.inputs.length) {
        let names = {};
        try {
          const text = await this._get('system/getNameText');
          for (const i of text.input_list || []) names[i.id] = i.text;
        } catch (e) { names = {}; }
        this.inputs = (zone.input_list || []).filter((id) => ID_RE.test(id)).map((id) => ({ id, label: names[id] || id }));
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  async _status() {
    const s = await this._get(`${this.zone}/getStatus`);
    if (!this.maxVolume && Number(s.max_volume)) this.maxVolume = Number(s.max_volume);
    return s;
  }

  async getPowerState() { return (await this._status()).power === 'on' ? 'on' : 'standby'; }
  async powerOn() { await this._get(`${this.zone}/setPower?power=on`); return true; }
  async powerOff() { await this._get(`${this.zone}/setPower?power=standby`); return true; }

  async getVolume() {
    const s = await this._status();
    const max = this.maxVolume || 100;
    return Math.round((Number(s.volume) / max) * 100);
  }

  async setVolume(percent) {
    const p = Number(percent);
    if (!Number.isFinite(p)) throw new Error('volume must be a number');
    if (!this.maxVolume) await this._status();
    const max = this.maxVolume || 100;
    const raw = Math.max(0, Math.min(max, Math.round((p / 100) * max)));
    await this._get(`${this.zone}/setVolume?volume=${raw}`);
    return true;
  }

  async getMute() { return Boolean((await this._status()).mute); }
  async mute() { await this._get(`${this.zone}/setMute?enable=true`); return true; }
  async unmute() { await this._get(`${this.zone}/setMute?enable=false`); return true; }

  getInputs() { return this.inputs.map((i) => ({ id: i.id, label: i.label || i.id })); }
  async getInput() { return (await this._status()).input || null; }
  async setInput(input) {
    const known = this.inputs.find((i) => i.id === input);
    if (!known || !ID_RE.test(known.id)) throw new Error(`unknown input: ${input}`);
    await this._get(`${this.zone}/setInput?input=${encodeURIComponent(known.id)}`);
    return true;
  }

  async getPlayState() {
    const p = await this._get('netusb/getPlayInfo');
    return ['play', 'pause', 'stop'].includes(p.playback) ? p.playback : 'stop';
  }
  async setPlayState(state) {
    if (!['play', 'pause', 'stop'].includes(state)) throw new Error(`unsupported play state: ${state}`);
    await this._get(`netusb/setPlayback?playback=${state}`);
    return true;
  }
  async playPause() { await this._get('netusb/setPlayback?playback=play_pause'); return true; }
  async next() { await this._get('netusb/setPlayback?playback=next'); return true; }
  async previous() { await this._get('netusb/setPlayback?playback=previous'); return true; }

  async getNowPlaying() {
    const p = await this._get('netusb/getPlayInfo');
    if (!p.track && !p.artist) return null;
    // Album art is served by the amp itself (a path on its own address); passing
    // that to the browser would expose the amp's IP (SC-03), so no art for now.
    return { type: 'song', song: p.track || '', artist: p.artist || '', album: p.album || '', station: '', image_url: null };
  }

  getPresets() { return this.presets.map((p) => ({ id: p.id, label: p.label || `Preset ${p.id}` })); }
  async playPreset(preset) {
    const n = parseInt(preset, 10);
    if (!Number.isInteger(n) || n < 1 || n > 40) throw new Error(`invalid preset: ${preset}`);
    await this._get(`netusb/recallPreset?zone=${this.zone}&num=${n}`);
    return true;
  }

  async getStatus() {
    const s = await this._status().catch(() => ({}));
    return { power: s.power === 'on' ? 'on' : (s.power ? 'standby' : 'unknown'), volume: s.volume != null ? Math.round((Number(s.volume) / (this.maxVolume || 100)) * 100) : null, mute: Boolean(s.mute), input: s.input || null };
  }

  capabilities() {
    return {
      power: true, volume: true, mute: true,
      inputs: this.inputs.length > 0,
      presets: this.presets.length > 0,
      playStream: false,
      transport: true,
      nowPlaying: true
    };
  }
}

module.exports = YamahaDriver;
