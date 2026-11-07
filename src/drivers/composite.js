const BaseDriver = require('./base');
const { publicError } = require('./errors');

/**
 * One logical device, several protocol drivers.
 *
 * A Marantz PM7000N needs HEOS for playback and the AVR protocol for power,
 * volume, mute and physical inputs. This class presents both as a single
 * driver: each capability is routed to the first driver that supports it
 * (configurable via `precedence` in devices.json), with a fallback to the
 * other drivers when one is unreachable.
 */
const DEFAULT_PRECEDENCE = {
  power: ['denon_avr', 'marantz', 'avr', 'heos'],
  volume: ['denon_avr', 'marantz', 'avr', 'heos'],
  mute: ['denon_avr', 'marantz', 'avr', 'heos'],
  inputs: ['denon_avr', 'marantz', 'avr', 'heos'],
  presets: ['heos', 'denon_avr', 'marantz'],
  playStream: ['heos', 'cast', 'upnp'],
  transport: ['heos', 'cast', 'upnp'],
  nowPlaying: ['heos', 'cast', 'upnp']
};

class CompositeDriver extends BaseDriver {
  /**
   * @param {object} config device entry from config/devices.json
   * @param {Array<{type: string, driver: BaseDriver}>} entries
   */
  constructor(config = {}, entries = []) {
    super(config);
    this.entries = entries;
    this.precedence = { ...DEFAULT_PRECEDENCE, ...(config.precedence || {}) };
  }

  _ordered(capability) {
    const preferred = this.precedence[capability] || [];
    const rank = (entry) => {
      const index = preferred.indexOf(entry.type);
      return index === -1 ? preferred.length : index;
    };
    return this.entries
      .filter((entry) => {
        try {
          return entry.driver.capabilities()[capability] === true;
        } catch (e) {
          return false;
        }
      })
      .sort((a, b) => rank(a) - rank(b));
  }

  _candidates(capability, method) {
    return this._ordered(capability).filter((entry) => typeof entry.driver[method] === 'function');
  }

  async _call(capability, method, ...args) {
    const candidates = this._candidates(capability, method);
    if (candidates.length === 0) throw new Error(`${capability} is not supported by this device`);
    const failures = [];
    for (const entry of candidates) {
      try {
        return await entry.driver[method](...args);
      } catch (e) {
        failures.push({ type: entry.type, error: e });
      }
    }
    // Users see a plain message; the original (with addresses) stays in .cause for the log.
    const shown = failures.map((f) => `${f.type}: ${publicError(f.error).message}`).join('; ') || `${method} failed`;
    const err = new Error(shown);
    err.cause = failures.length ? failures.map((f) => `${f.type}: ${f.error.message}`).join('; ') : undefined;
    throw err;
  }

  async _read(capability, method) {
    const candidates = this._candidates(capability, method);
    for (const entry of candidates) {
      try {
        return await entry.driver[method]();
      } catch (e) {
        // Try the next protocol driver.
      }
    }
    return null;
  }

  async init() {
    const results = await Promise.allSettled(this.entries.map((entry) => entry.driver.init()));
    return results.some((result) => result.status === 'fulfilled' && result.value === true);
  }

  async close() {
    await Promise.allSettled(this.entries.map((entry) => entry.driver.close()));
  }

  capabilities() {
    const merged = {
      power: false,
      volume: false,
      mute: false,
      inputs: false,
      sourceDirect: false,
      account: false,
      radio: false,
      webRadio: false,
      presets: false,
      playStream: false,
      transport: false,
      nowPlaying: false
    };
    for (const entry of this.entries) {
      try {
        const caps = entry.driver.capabilities() || {};
        for (const key of Object.keys(merged)) {
          if (caps[key] === true) merged[key] = true;
        }
      } catch (e) {
        // A broken driver must not take the device down.
      }
    }
    if (merged.inputs && this.getInputs().length === 0) merged.inputs = false;
    if (merged.presets && this.getPresets().length === 0) merged.presets = false;
    return merged;
  }

  getInputs() {
    const seen = new Set();
    const merged = [];
    for (const entry of this._ordered('inputs')) {
      let inputs = [];
      try {
        inputs = entry.driver.getInputs() || [];
      } catch (e) {
        inputs = [];
      }
      for (const input of inputs) {
        if (!input || !input.id || seen.has(input.id)) continue;
        seen.add(input.id);
        merged.push({ id: input.id, label: input.label || input.id });
      }
    }
    return merged;
  }

  getPresets() {
    const seen = new Set();
    const merged = [];
    for (const entry of this._ordered('presets')) {
      let presets = [];
      try {
        presets = entry.driver.getPresets() || [];
      } catch (e) {
        presets = [];
      }
      for (const preset of presets) {
        if (!preset || preset.id === undefined || seen.has(String(preset.id))) continue;
        seen.add(String(preset.id));
        merged.push({ id: preset.id, label: preset.label || `Preset ${preset.id}` });
      }
    }
    return merged;
  }

  async getStatus() {
    const [power, volume, mute, input, playState, nowPlaying, sourceDirect] = await Promise.all([
      this._read('power', 'getPowerState'),
      this._read('volume', 'getVolume'),
      this._read('mute', 'getMute'),
      this._read('inputs', 'getInput'),
      this._read('transport', 'getPlayState'),
      this._read('nowPlaying', 'getNowPlaying'),
      this._read('sourceDirect', 'getSourceDirect')
    ]);

    return {
      power,
      volume,
      mute,
      input,
      playState,
      nowPlaying,
      sourceDirect,
      inputs: this.getInputs(),
      presets: this.getPresets(),
      capabilities: this.capabilities()
    };
  }

  async getPowerState() { return this._read('power', 'getPowerState'); }
  async powerOn() { return this._call('power', 'powerOn'); }
  async powerOff() { return this._call('power', 'powerOff'); }

  async getVolume() { return this._read('volume', 'getVolume'); }
  async setVolume(level) { return this._call('volume', 'setVolume', level); }

  async getMute() { return this._read('mute', 'getMute'); }
  async mute() { return this._call('mute', 'mute'); }
  async unmute() { return this._call('mute', 'unmute'); }

  async getInput() { return this._read('inputs', 'getInput'); }
  async setInput(input) {
    // Validate against the advertised list before touching the device.
    const known = this.getInputs().find((entry) => entry.id === input);
    if (!known) throw new Error(`unknown input: ${input}`);
    return this._call('inputs', 'setInput', input);
  }

  async playPreset(preset) {
    return this._call('presets', 'playPreset', preset);
  }

  async playStream(url) {
    return this._call('playStream', 'playStream', url);
  }

  async setPlayState(state) {
    return this._call('transport', 'setPlayState', state);
  }

  async playPause() {
    return this._call('transport', 'playPause');
  }

  async next() { return this._call('transport', 'next'); }
  async previous() { return this._call('transport', 'previous'); }

  async getNowPlaying() { return this._read('nowPlaying', 'getNowPlaying'); }

  async radioBrowse(cid, start) { return this._call('radio', 'radioBrowse', cid, start); }
  async radioSearch(query) { return this._call('radio', 'radioSearch', query); }
  async radioPlay(mid, name, cid) { return this._call('radio', 'radioPlay', mid, name, cid); }

  /** The protocol driver of one type (e.g. 'heos', 'denon_avr'), or null. */
  driverOf(type) {
    const entry = this.entries.find((item) => item.type === type);
    return entry ? entry.driver : null;
  }

  async getAccount() { return this._read('account', 'getAccount'); }
  async signIn(username, password) { return this._call('account', 'signIn', username, password); }
  async signOut() { return this._call('account', 'signOut'); }

  async getSourceDirect() { return this._read('sourceDirect', 'getSourceDirect'); }
  async setSourceDirect(on) { return this._call('sourceDirect', 'setSourceDirect', on); }
}

module.exports = CompositeDriver;
module.exports.DEFAULT_PRECEDENCE = DEFAULT_PRECEDENCE;
