const net = require('net');
const BaseDriver = require('./base');

/**
 * HEOS CLI driver (TCP 1255).
 *
 * HEOS gives playback: play state, volume/mute of the HEOS player, now playing,
 * stream URLs and QuickSelect presets. It does not control mains power or the
 * physical inputs on a PM7000N, so those come from the AVR driver.
 *
 * Protocol reference: HEOS CLI Protocol Specification (Denon/Marantz). Each
 * command is ASCII terminated by CRLF and answered with a JSON object.
 */
class HEOSDriver extends BaseDriver {
  constructor(config = {}) {
    super(config);
    this.host = config.host;
    this.port = config.port || 1255;
    this.timeout = config.timeout || 5000;
    this.pid = config.pid ? String(config.pid) : null;
    this.presets = Array.isArray(config.presets) ? config.presets : [];
    // HEOS can answer "success" and still start nothing, so playStream waits
    // briefly for a real state change. Tunable for tests.
    this.streamVerifyAttempts = Number.isFinite(config.streamVerifyAttempts) ? config.streamVerifyAttempts : 4;
    this.streamVerifyMs = Number.isFinite(config.streamVerifyMs) ? config.streamVerifyMs : 1500;
  }

  _request(command, { label = command, waitFinal = false, timeout } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let buffer = '';
      const socket = net.createConnection({ host: this.host, port: this.port });

      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (err) reject(err);
        else resolve(value);
      };

      const limit = timeout || this.timeout;
      socket.setTimeout(limit);
      socket.on('connect', () => socket.write(`${command}\r\n`));
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\r\n').filter((line) => line.trim());
        for (const line of lines) {
          let parsed;
          try {
            parsed = JSON.parse(line);
          } catch (e) {
            continue; // Partial JSON line: wait for the rest of the payload.
          }
          // Slow commands (sign-in) first answer "command under process".
          const message = parsed && parsed.heos && parsed.heos.message;
          if (waitFinal && String(message || '').startsWith('command under process')) continue;
          finish(null, parsed);
          return;
        }
      });
      // `label` keeps secrets (the sign-in password) out of error messages.
      socket.on('timeout', () => finish(new Error(`HEOS timeout after ${limit}ms (${label})`)));
      socket.on('error', (err) => finish(err));
    });
  }

  async _command(command, options) {
    const response = await this._request(command, options);
    const heos = response && response.heos;
    if (heos && heos.result && heos.result !== 'success') {
      throw new Error(heos.message || `HEOS error: ${heos.result}`);
    }
    return response;
  }

  async _ensurePid() {
    if (this.pid) return this.pid;
    const response = await this._command('heos://player/get_players');
    const players = Array.isArray(response.payload) ? response.payload : [];
    if (players.length === 0) throw new Error('HEOS reports no players');
    this.pid = String(players[0].pid);
    return this.pid;
  }

  async init() {
    try {
      await this._command('heos://system/register_for_change_events?enable=on');
      await this._ensurePid();
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---- HEOS account (needed for presets, TuneIn and other online services) ----

  static _parseAccount(message) {
    const text = String(message || '');
    if (text.startsWith('signed_in')) {
      const match = /un=([^&]*)/.exec(text);
      return { signedIn: true, username: match ? match[1] : null };
    }
    return { signedIn: false, username: null };
  }

  // The CLI only needs "&", "=" and "%" escaped inside values.
  static _encodeValue(value) {
    return String(value).replace(/%/g, '%25').replace(/&/g, '%26').replace(/=/g, '%3D');
  }

  async getAccount() {
    const response = await this._command('heos://system/check_account');
    return HEOSDriver._parseAccount(response.heos && response.heos.message);
  }

  async signIn(username, password) {
    const command = `heos://system/sign_in?un=${HEOSDriver._encodeValue(username)}&pw=${HEOSDriver._encodeValue(password)}`;
    const previousTimeout = this.timeout;
    this.timeout = Math.max(this.timeout, 15000); // the amp checks with the HEOS cloud
    let response;
    try {
      response = await this._request(command, { label: 'system/sign_in', waitFinal: true });
    } finally {
      this.timeout = previousTimeout;
    }
    const heos = (response && response.heos) || {};
    if (heos.result !== 'success') {
      // Error replies look like "eid=10&text=User not found"; keep only the text.
      const text = /text=([^&]*)/.exec(heos.message || '');
      throw new Error(`HEOS sign-in failed: ${text ? decodeURIComponent(text[1]) : 'the amp refused the sign-in'}`);
    }
    // Confirm with a fresh read rather than trusting the reply.
    const account = await this.getAccount();
    if (!account.signedIn) throw new Error('HEOS sign-in failed: the amp still reports signed out');
    return account;
  }

  async signOut() {
    await this._command('heos://system/sign_out', { waitFinal: true });
    return this.getAccount();
  }

  // ---- Internet radio (TuneIn, HEOS source id 3; needs the HEOS account) ----

  static get RADIO_SID() { return 3; }

  // Values the browser sends back must be exactly what HEOS handed out: no "&",
  // "=", spaces or line breaks that could add parameters or a second command.
  static isSafeCid(cid) { return typeof cid === 'string' && cid.length <= 1500 && /^[A-Za-z0-9%._~:/+-]+$/.test(cid); }
  static isSafeMid(mid) { return typeof mid === 'string' && mid.length <= 128 && /^[A-Za-z0-9%._~:/+-]+$/.test(mid); }

  static _decodeName(name) {
    try { return decodeURIComponent(String(name || '')); } catch (e) { return String(name || ''); }
  }

  // Only https images reach the browser. TuneIn hands out http:// logo links
  // but serves the same files over https, so upgrade those hosts only.
  static _safeImage(url) {
    const text = String(url || '');
    if (/^https:\/\//.test(text)) return text;
    const tunein = /^http:\/\/((?:cdn-profiles|cdn-radiotime-logos)\.tunein\.com\/.*)$/.exec(text);
    return tunein ? `https://${tunein[1]}` : null;
  }

  static _radioItems(response) {
    const payload = Array.isArray(response && response.payload) ? response.payload : [];
    return payload
      .filter((item) => item && (item.type === 'station' || item.container === 'yes'))
      .map((item) => ({
        name: HEOSDriver._decodeName(item.name),
        kind: item.type === 'station' ? 'station' : 'folder',
        playable: item.playable === 'yes',
        mid: item.mid || null,
        cid: item.cid || null,
        image: HEOSDriver._safeImage(item.image_url)
      }));
  }

  static _counts(response, start) {
    const message = (response && response.heos && response.heos.message) || '';
    const count = /(?:^|&)count=(\d+)/.exec(message);
    const returned = /returned=(\d+)/.exec(message);
    return { start, returned: returned ? Number(returned[1]) : 0, count: count ? Number(count[1]) : 0 };
  }

  _radioCache() {
    if (!this.radioCache) this.radioCache = new Map();
    return this.radioCache;
  }

  async radioBrowse(cid = null, start = 0) {
    if (cid !== null && !HEOSDriver.isSafeCid(cid)) throw new Error('invalid radio folder');
    const first = Math.max(0, Math.floor(Number(start) || 0));
    const key = `${cid || ''}|${first}`;
    const cached = this._radioCache().get(key);
    if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.value;

    const range = `&range=${first},${first + 49}`;
    const command = cid
      ? `heos://browse/browse?sid=${HEOSDriver.RADIO_SID}&cid=${cid}${range}`
      : `heos://browse/browse?sid=${HEOSDriver.RADIO_SID}`;
    const response = await this._command(command, { waitFinal: true, timeout: 15000, label: 'browse radio' });
    const value = { items: HEOSDriver._radioItems(response), ...HEOSDriver._counts(response, first) };
    if (!cid) value.count = value.items.length;
    if (value.items.length > 0) this._radioCache().set(key, { at: Date.now(), value });
    return value;
  }

  async radioSearch(query) {
    const text = String(query || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 60);
    if (text.length < 2) throw new Error('type at least two letters');
    const command = `heos://browse/search?sid=${HEOSDriver.RADIO_SID}&search=${HEOSDriver._encodeValue(text)}&scid=4&range=0,49`;
    const response = await this._command(command, { waitFinal: true, timeout: 15000, label: 'search radio' });
    return { items: HEOSDriver._radioItems(response), ...HEOSDriver._counts(response, 0) };
  }

  async radioPlay(mid, name, cid = null) {
    if (!HEOSDriver.isSafeMid(mid)) throw new Error('invalid station');
    if (cid !== null && !HEOSDriver.isSafeCid(cid)) throw new Error('invalid radio folder');
    const pid = await this._ensurePid();
    const label = HEOSDriver._encodeValue(String(name || 'Radio').replace(/[\r\n]/g, ' ').slice(0, 120));
    const container = cid ? `&cid=${cid}` : '';
    await this._command(`heos://browse/play_stream?pid=${pid}&sid=${HEOSDriver.RADIO_SID}${container}&mid=${mid}&name=${label}`,
      { waitFinal: true, timeout: 15000, label: 'play radio' });
    return true;
  }

  async getPlayState() {
    const pid = await this._ensurePid();
    const response = await this._command(`heos://player/get_play_state?pid=${pid}`);
    const message = (response.heos && response.heos.message) || '';
    const match = /state=(\w+)/.exec(message);
    return match ? match[1] : 'unknown';
  }

  async setPlayState(state) {
    const wanted = String(state).toLowerCase();
    if (!['play', 'pause', 'stop'].includes(wanted)) throw new Error(`unsupported play state: ${state}`);
    const pid = await this._ensurePid();
    await this._command(`heos://player/set_play_state?pid=${pid}&state=${wanted}`);
    return true;
  }

  async playPause() {
    const state = await this.getPlayState().catch(() => 'stop');
    return this.setPlayState(state === 'play' ? 'pause' : 'play');
  }

  async next() {
    const pid = await this._ensurePid();
    await this._command(`heos://player/play_next?pid=${pid}`);
    return true;
  }

  async previous() {
    const pid = await this._ensurePid();
    await this._command(`heos://player/play_previous?pid=${pid}`);
    return true;
  }

  async getVolume() {
    const pid = await this._ensurePid();
    const response = await this._command(`heos://player/get_volume?pid=${pid}`);
    const match = /level=(\d+)/.exec((response.heos && response.heos.message) || '');
    return match ? parseInt(match[1], 10) : 0;
  }

  async setVolume(level) {
    const pid = await this._ensurePid();
    const value = Math.max(0, Math.min(100, Math.round(Number(level))));
    if (!Number.isFinite(value)) throw new Error('volume must be a number');
    await this._command(`heos://player/set_volume?pid=${pid}&level=${value}`);
    return true;
  }

  async getMute() {
    const pid = await this._ensurePid();
    const response = await this._command(`heos://player/get_mute?pid=${pid}`);
    return /state=on/.test((response.heos && response.heos.message) || '');
  }

  async mute() {
    const pid = await this._ensurePid();
    await this._command(`heos://player/set_mute?pid=${pid}&state=on`);
    return true;
  }

  async unmute() {
    const pid = await this._ensurePid();
    await this._command(`heos://player/set_mute?pid=${pid}&state=off`);
    return true;
  }

  async getNowPlaying() {
    const pid = await this._ensurePid();
    const response = await this._command(`heos://player/get_now_playing_media?pid=${pid}`);
    return response.payload || null;
  }

  async playStream(url) {
    const pid = await this._ensurePid();
    await this._command(`heos://browse/play_stream?pid=${pid}&url=${encodeURIComponent(url)}`);

    // Some firmware accepts the URL and then does nothing (for example when
    // online services are unavailable because HEOS is not signed in). Do not
    // report success until the player has actually started or buffered.
    for (let attempt = 0; attempt < this.streamVerifyAttempts; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, this.streamVerifyMs));
      const state = await this.getPlayState().catch(() => 'unknown');
      if (state === 'play' || state === 'pause') return true;
    }
    throw new Error('The amp did not start playback: the address must be a direct audio stream (for example ending in .mp3 or .aac), and the amp must be online');
  }

  async playPreset(preset) {
    const pid = await this._ensurePid();
    const value = parseInt(preset, 10);
    if (!Number.isFinite(value) || value < 1) throw new Error(`invalid preset: ${preset}`);
    try {
      await this._command(`heos://browse/play_preset?pid=${pid}&preset=${value}`);
    } catch (e) {
      if (/user not logged in/i.test(e.message)) {
        throw new Error('HEOS account not signed in on the amp: sign in with the HEOS app to use presets and internet radio');
      }
      throw e;
    }
    return true;
  }

  async getPlayMode() {
    const pid = await this._ensurePid();
    const response = await this._command(`heos://player/get_play_mode?pid=${pid}`);
    const message = (response.heos && response.heos.message) || '';
    const repeat = /repeat=(\w+)/.exec(message);
    const shuffle = /shuffle=(\w+)/.exec(message);
    return { repeat: repeat ? repeat[1] : 'off', shuffle: shuffle ? shuffle[1] : 'off' };
  }

  async setPlayMode({ repeat, shuffle }) {
    if (!['off', 'on_all', 'on_one'].includes(repeat) || !['on', 'off'].includes(shuffle)) throw new Error('invalid play mode');
    const pid = await this._ensurePid();
    await this._command(`heos://player/set_play_mode?pid=${pid}&repeat=${repeat}&shuffle=${shuffle}`);
    const now = await this.getPlayMode();
    if (now.repeat !== repeat || now.shuffle !== shuffle) throw new Error('this source does not support repeat or shuffle');
    return now;
  }

  async favouriteCount() {
    const response = await this._command('heos://browse/browse?sid=1028', { waitFinal: true, timeout: 15000, label: 'favourites' });
    return HEOSDriver._counts(response, 0).count;
  }

  // "Favorites add" on the remote: add what is playing now (HEOS option 19).
  async addNowPlayingToFavourites() {
    const pid = await this._ensurePid();
    const before = await this.favouriteCount();
    await this._command(`heos://browse/set_service_option?option=19&pid=${pid}`, { waitFinal: true, timeout: 15000, label: 'add favourite' });
    const after = await this.favouriteCount();
    if (after <= before) throw new Error('HEOS did not add it to Favourites');
    return after;
  }

  getPresets() {
    return this.presets.map((preset) => ({ id: preset.id, label: preset.label }));
  }

  async getMusicSources() {
    const response = await this._command('heos://browse/get_music_sources');
    return response.payload || [];
  }

  async getStatus() {
    const results = await Promise.allSettled([
      this.getPlayState(),
      this.getVolume(),
      this.getMute(),
      this.getNowPlaying()
    ]);
    const value = (index, fallback) => (results[index].status === 'fulfilled' ? results[index].value : fallback);
    return {
      playState: value(0, 'unknown'),
      volume: value(1, null),
      mute: value(2, null),
      nowPlaying: value(3, null)
    };
  }

  capabilities() {
    return {
      power: false,
      volume: true,
      mute: true,
      inputs: false,
      presets: true,
      playStream: true,
      transport: true,
      nowPlaying: true,
      account: true,
      radio: true
    };
  }
}

module.exports = HEOSDriver;
