/**
 * The Marantz RC004PM handset, button by button.
 *
 * The browser only names a button; this file decides what it does. Nothing
 * the browser sends is passed to the amp as a command. Each result says
 * whether the amp confirmed it (`verified`), so the page never claims a change
 * the amp did not make.
 */

// Source buttons that are not in the device config are tried and read back.
const SOURCE_CODES = {
  src_aux: 'ANALOG1',
  src_bluetooth: 'BT',
  src_usb: 'USB',
  src_servers: 'SERVER',
  src_recorder: 'RECORDER',
  src_optcoax: ['OPT1', 'OPT2', 'COAX'],   // manual p.38: cycles on each press
  src_cd: 'CD',
  src_phono: 'PHONO'
};

const MENU_KEYS = {
  up: 'MNCUP',
  down: 'MNCDN',
  left: 'MNCLT',
  right: 'MNCRT',
  enter: 'MNENT',
  back: 'MNRTN',
  setup: 'MNMEN ON',
  option: 'MNOPT',
  info: 'MNINF',
  dimmer: 'DIM SEL'
};

// Manual p.69: SLEEP steps up to 90 minutes in 10-minute steps, then off.
const SLEEP_STEPS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90];
const REPEAT_STEPS = ['off', 'on_all', 'on_one'];

const KEYS = new Set([
  'amp_power', 'vol_up', 'vol_down', 'mute', 'source_direct', 'input',
  'play_pause', 'stop', 'next', 'previous', 'sleep', 'random', 'repeat', 'fav_add',
  ...Object.keys(SOURCE_CODES), ...Object.keys(MENU_KEYS),
  ...Array.from({ length: 9 }, (_, i) => `num_${i + 1}`)
]);

function isRemoteKey(key) {
  return typeof key === 'string' && KEYS.has(key);
}

function done(message, verified = true, extra = {}) {
  return { ok: true, verified, message, ...extra };
}

async function pressRemoteKey(driver, key, { volumeCap }) {
  const avr = typeof driver.driverOf === 'function' ? driver.driverOf('denon_avr') : null;
  const heos = typeof driver.driverOf === 'function' ? driver.driverOf('heos') : null;

  switch (key) {
    case 'amp_power': {
      const on = (await driver.getPowerState()) === 'on';
      if (on) await driver.powerOff(); else await driver.powerOn();
      return done(on ? 'Standby' : 'Power on');
    }
    case 'vol_up':
    case 'vol_down': {
      const current = Number(await driver.getVolume()) || 0;
      const next = Math.max(0, Math.min(volumeCap, current + (key === 'vol_up' ? 1 : -1)));
      if (next === current && key === 'vol_up') return done(`Volume ${current} (max ${volumeCap})`, true, { capped: true });
      await driver.setVolume(next);
      return done(`Volume ${next}`);
    }
    case 'mute': {
      const muted = Boolean(await driver.getMute());
      if (muted) await driver.unmute(); else await driver.mute();
      return done(muted ? 'Mute off' : 'Mute on');
    }
    case 'source_direct': {
      const on = Boolean(await driver.getSourceDirect());
      await driver.setSourceDirect(!on);
      return done(`Source Direct ${on ? 'off' : 'on'}`);
    }
    case 'input': {
      const inputs = driver.getInputs();
      if (inputs.length === 0) throw new Error('no inputs configured');
      const current = String(await driver.getInput() || '').toUpperCase();
      const index = inputs.findIndex((entry) => String(entry.id).toUpperCase() === current);
      const next = inputs[(index + 1) % inputs.length];
      await driver.setInput(next.id);
      return done(next.label);
    }
    case 'play_pause': await driver.playPause(); return done('Play / pause');
    case 'stop': await driver.setPlayState('stop'); return done('Stop');
    case 'next': await driver.next(); return done('Next');
    case 'previous': await driver.previous(); return done('Previous');
    case 'sleep': {
      if (!avr) throw new Error('sleep timer not supported');
      const now = await avr.getSleep();
      const next = SLEEP_STEPS.find((value) => value > now) || 0;
      const value = await avr.setSleep(next);
      return done(value === 0 ? 'Sleep timer off' : `Sleep in ${value} min`, true, { sleep: value });
    }
    case 'random':
    case 'repeat': {
      if (!heos) throw new Error('not supported');
      const mode = await heos.getPlayMode();
      const wanted = key === 'random'
        ? { repeat: mode.repeat, shuffle: mode.shuffle === 'on' ? 'off' : 'on' }
        : { repeat: REPEAT_STEPS[(REPEAT_STEPS.indexOf(mode.repeat) + 1) % REPEAT_STEPS.length], shuffle: mode.shuffle };
      const now = await heos.setPlayMode(wanted);
      return key === 'random'
        ? done(`Random ${now.shuffle}`)
        : done(`Repeat ${now.repeat === 'on_all' ? 'all' : now.repeat === 'on_one' ? 'one' : 'off'}`);
    }
    case 'fav_add': {
      if (!heos) throw new Error('not supported');
      const count = await heos.addNowPlayingToFavourites();
      return done(`Added to HEOS Favourites (${count})`);
    }
    default:
      break;
  }

  if (SOURCE_CODES[key]) {
    if (!avr) throw new Error('not supported');
    let code = SOURCE_CODES[key];
    if (Array.isArray(code)) {
      const current = String(await driver.getInput() || '').toUpperCase();
      const index = code.indexOf(current);
      code = code[(index + 1) % code.length];
    }
    const accepted = await avr.trySource(code);
    if (!accepted) throw new Error(`The amp ignored ${code}: that source is switched off in the amp's setup`);
    return done(`Input ${code}`);
  }
  if (MENU_KEYS[key]) {
    if (!avr) throw new Error('not supported');
    await avr.sendKey(MENU_KEYS[key]);
    return done('Sent: check the amp display', false);
  }
  const number = /^num_(\d)$/.exec(key);
  if (number) {
    await driver.playPreset(Number(number[1]));
    return done(`Favourite ${number[1]}`);
  }
  throw new Error('unknown button');
}

module.exports = { isRemoteKey, pressRemoteKey, SOURCE_CODES, MENU_KEYS };
