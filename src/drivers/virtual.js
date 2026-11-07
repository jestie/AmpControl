const BaseDriver = require('./base');

/**
 * A virtual amplifier: no hardware, just state. It lets anyone without a
 * network amp use the whole app (faces, clock, remote, alarms), and pairs with
 * browser radio (src/webradio.js): the sound plays on the phone or PC, and the
 * amp's power, volume and mute decide what you hear.
 */
class VirtualDriver extends BaseDriver {
  constructor(config = {}) {
    super(config);
    this.state = {
      power: 'standby',
      volume: Number.isFinite(config.startVolume) ? config.startVolume : 12,
      mute: false,
      input: 'RADIO',
      sourceDirect: false,
      playState: 'stop',
      nowPlaying: null
    };
    this.inputs = Array.isArray(config.inputs) && config.inputs.length
      ? config.inputs
      : [
        { id: 'RADIO', label: 'Internet radio' },
        { id: 'BT', label: 'Bluetooth' },
        { id: 'AUX', label: 'AUX' }
      ];
  }

  async init() { return true; }

  async getPowerState() { return this.state.power; }
  async powerOn() { this.state.power = 'on'; return true; }
  async powerOff() { this.state.power = 'standby'; this.state.playState = 'stop'; return true; }

  async getVolume() { return this.state.volume; }
  async setVolume(level) {
    const v = Number(level);
    if (!Number.isFinite(v)) throw new Error('volume must be a number');
    this.state.volume = Math.max(0, Math.min(100, Math.round(v)));
    return true;
  }

  async getMute() { return this.state.mute; }
  async mute() { this.state.mute = true; return true; }
  async unmute() { this.state.mute = false; return true; }

  getInputs() { return this.inputs.map((i) => ({ id: i.id, label: i.label })); }
  async getInput() { return this.state.input; }
  async setInput(input) {
    if (!this.inputs.some((i) => i.id === input)) throw new Error(`unknown input: ${input}`);
    this.state.input = input;
    if (input !== 'RADIO') this.state.playState = 'stop';
    return true;
  }

  async getSourceDirect() { return this.state.sourceDirect; }
  async setSourceDirect(on) { this.state.sourceDirect = Boolean(on); return true; }

  async getPlayState() { return this.state.playState; }
  async setPlayState(state) {
    if (!['play', 'pause', 'stop'].includes(state)) throw new Error(`unsupported play state: ${state}`);
    this.state.playState = state;
    return true;
  }
  async playPause() { return this.setPlayState(this.state.playState === 'play' ? 'pause' : 'play'); }

  /** Browser radio tells the virtual amp what it is playing. */
  setWebStation(station) {
    this.state.power = 'on';
    this.state.input = 'RADIO';
    this.state.playState = 'play';
    this.state.nowPlaying = { type: 'webradio', station: station.name, song: station.name, image_url: station.favicon || '', uuid: station.uuid };
  }

  /** Wake-up alarms: the open page starts the stream; the amp shows the station. */
  async radioPlay(uuid, name) {
    this.setWebStation({ uuid, name, favicon: '' });
    return true;
  }

  async getNowPlaying() { return this.state.nowPlaying; }

  async getStatus() {
    return { ...this.state };
  }

  capabilities() {
    return {
      power: true,
      volume: true,
      mute: true,
      inputs: true,
      sourceDirect: true,
      // Play/stop for browser radio happens in the page itself.
      transport: false,
      nowPlaying: true,
      webRadio: true,
      presets: false,
      playStream: false
    };
  }
}

module.exports = VirtualDriver;
