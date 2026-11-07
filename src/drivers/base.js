/**
 * Common driver contract.
 *
 * A driver talks one protocol to one device (HEOS CLI, Denon/Marantz AVR,
 * Chromecast, UPnP, ...). It declares what it can do through capabilities();
 * the UI and the API only expose what is declared. Methods that are not
 * implemented throw, and are never called when the capability is false.
 */
class BaseDriver {
  constructor(config = {}) {
    this.config = config;
    this.name = config.name || 'unknown';
    this.id = config.id || 'unknown';
  }

  async init() { return true; }
  async close() { return true; }

  async getStatus() { throw new Error('not implemented'); }

  async getPowerState() { throw new Error('not implemented'); }
  async powerOn() { throw new Error('not implemented'); }
  async powerOff() { throw new Error('not implemented'); }

  async getVolume() { throw new Error('not implemented'); }
  async setVolume(level) { throw new Error('not implemented'); }

  async getMute() { throw new Error('not implemented'); }
  async mute() { throw new Error('not implemented'); }
  async unmute() { throw new Error('not implemented'); }

  getInputs() { return []; }
  async getInput() { throw new Error('not implemented'); }
  async setInput(input) { throw new Error('not implemented'); }

  getPresets() { return []; }
  async playPreset(preset) { throw new Error('not implemented'); }
  async playStream(url) { throw new Error('not implemented'); }

  async setPlayState(state) { throw new Error('not implemented'); }
  async getPlayState() { throw new Error('not implemented'); }
  async next() { throw new Error('not implemented'); }
  async previous() { throw new Error('not implemented'); }

  async getNowPlaying() { return null; }

  capabilities() {
    return {
      power: false,
      volume: false,
      mute: false,
      inputs: false,
      presets: false,
      playStream: false,
      transport: false,
      nowPlaying: false
    };
  }
}

module.exports = BaseDriver;
