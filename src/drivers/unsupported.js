const BaseDriver = require('./base');

/**
 * Placeholder for devices that are listed but have no network control
 * (Bluetooth / HDMI-CEC / IR only, or a driver we have not written yet).
 * It reports no capabilities instead of pretending, so the UI shows nothing.
 */
class UnsupportedDriver extends BaseDriver {
  async init() { return true; }

  async getStatus() {
    return { power: null, volume: null, mute: null, input: null, playState: null, nowPlaying: null };
  }

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

module.exports = UnsupportedDriver;
