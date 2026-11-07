const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Tests never touch the real data/ files.
process.env.SESSIONS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-sess-')), 'sessions.json');

const { clampVolume, validateStreamUrl } = require('../src/utils/volume');
const CompositeDriver = require('../src/drivers/composite');
const { tokenFor, csrfProtection } = require('../src/auth/csrf');
const { LoginLimiter } = require('../src/auth/limit');

function tempUsersFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soundcontrol-test-'));
  return path.join(dir, 'users.json');
}

function fakeDriver(overrides = {}) {
  const calls = [];
  const capabilities = () => ({
    power: true, volume: true, mute: true, inputs: true,
    presets: true, playStream: true, transport: true, nowPlaying: true,
    ...(overrides.capabilities || {})
  });
  const driver = {
    calls,
    capabilities,
    init: async () => true,
    close: async () => true,
    getPowerState: async () => 'on',
    powerOn: async () => { calls.push(['powerOn']); return true; },
    powerOff: async () => { calls.push(['powerOff']); return true; },
    getVolume: async () => 12,
    setVolume: async (level) => { calls.push(['setVolume', level]); return true; },
    getMute: async () => false,
    mute: async () => { calls.push(['mute']); return true; },
    unmute: async () => { calls.push(['unmute']); return true; },
    getInputs: () => [{ id: 'ANALOG1', label: 'Analog 1' }],
    getInput: async () => 'ANALOG1',
    setInput: async (input) => { calls.push(['setInput', input]); return true; },
    getPresets: () => [{ id: 1, label: 'Preset 1' }],
    playPreset: async (id) => { calls.push(['playPreset', id]); return true; },
    playStream: async (url) => { calls.push(['playStream', url]); return true; },
    getPlayState: async () => 'stop',
    setPlayState: async (state) => { calls.push(['setPlayState', state]); return true; },
    playPause: async () => { calls.push(['playPause']); return true; },
    next: async () => { calls.push(['next']); return true; },
    previous: async () => { calls.push(['previous']); return true; },
    getNowPlaying: async () => ({ song: 'Test', artist: 'Band' }),
    getStatus: async () => ({
      power: 'on',
      volume: 12,
      mute: false,
      input: 'ANALOG1',
      playState: 'stop',
      nowPlaying: { song: 'Test', artist: 'Band' },
      inputs: [{ id: 'ANALOG1', label: 'Analog 1' }],
      presets: [{ id: 1, label: 'Preset 1' }],
      capabilities: capabilities()
    }),
    ...overrides,
    capabilities
  };
  return driver;
}

test('clampVolume keeps levels inside the per-device cap', () => {
  assert.deepEqual(clampVolume(12, 40), { level: 12, capped: false });
  assert.deepEqual(clampVolume(95, 40), { level: 40, capped: true });
  assert.deepEqual(clampVolume('17', 40), { level: 17, capped: false });
  assert.deepEqual(clampVolume(-5, 40), { level: 0, capped: false });
  assert.deepEqual(clampVolume(41, 40), { level: 40, capped: true });
  assert.throws(() => clampVolume('loud', 40), /number/);
  assert.throws(() => clampVolume(NaN, 40), /number/);
});

test('stream URL box explains music-service links instead of failing', () => {
  assert.throws(() => validateStreamUrl('https://open.spotify.com/playlist/abc'), /Spotify Connect/);
  assert.throws(() => validateStreamUrl('https://youtu.be/abc'), /YouTube/);
  assert.throws(() => validateStreamUrl('https://music.apple.com/gb/album/x'), /AirPlay/);
  assert.equal(validateStreamUrl('https://stream.example.org/radio.mp3'), 'https://stream.example.org/radio.mp3');
});

test('validateStreamUrl only accepts http and https', () => {
  assert.equal(validateStreamUrl('http://stream.example/radio.mp3'), 'http://stream.example/radio.mp3');
  assert.match(validateStreamUrl('https://stream.example/a'), /^https:\/\/stream\.example\/a$/);
  assert.throws(() => validateStreamUrl('file:///etc/passwd'), /http or https/);
  assert.throws(() => validateStreamUrl('javascript:alert(1)'), /http or https/);
  assert.throws(() => validateStreamUrl(''), /required/);
});

test('denon_avr maps app percent 1:1 to the raw MV scale', async () => {
  const DenonAVRDriver = require('../src/drivers/denon_avr');
  const driver = new DenonAVRDriver({ host: '127.0.0.1' });
  assert.equal(driver.volumeMax, 100);

  driver._request = async () => 'MV40';
  assert.equal(await driver.getVolume(), 40);

  const sent = [];
  driver._request = async (cmd) => { sent.push(cmd); return ''; };
  await driver.setVolume(10);
  await driver.setVolume(100);
  await driver.setVolume(150);
  assert.deepEqual(sent, ['MV10', 'MV100', 'MV100']);
});

test('denon_avr source direct reads, sets and verifies the amp state', async () => {
  const DenonAVRDriver = require('../src/drivers/denon_avr');
  const driver = new DenonAVRDriver({ host: '127.0.0.1' });
  assert.equal(driver.capabilities().sourceDirect, true);

  let state = 'ON';
  const sent = [];
  driver._request = async (cmd) => {
    sent.push(cmd);
    if (cmd === 'PSSDI ?') return `PSSDI ${state}`;
    return '';
  };
  assert.equal(await driver.getSourceDirect(), true);
  state = 'OFF';
  assert.equal(await driver.getSourceDirect(), false);

  // The amp follows the command.
  driver._request = async (cmd) => {
    sent.push(cmd);
    if (cmd === 'PSSDI ON') state = 'ON';
    if (cmd === 'PSSDI ?') return `PSSDI ${state}`;
    return '';
  };
  await driver.setSourceDirect(true);
  assert.ok(sent.includes('PSSDI ON'));

  // The amp ignores the command: report failure, never a false success.
  driver._request = async (cmd) => (cmd === 'PSSDI ?' ? 'PSSDI ON' : '');
  await assert.rejects(() => driver.setSourceDirect(false), /kept Source Direct on/);
});

test('heos sign-in escapes the password, waits for the final reply and never leaks it', async () => {
  const net = require('net');
  const HEOSDriver = require('../src/drivers/heos');
  const secret = 'p&ss=w%rd';
  let received = '';
  let signedIn = false;
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      const cmd = chunk.toString().trim();
      if (cmd.startsWith('heos://system/sign_in')) {
        received = cmd;
        socket.write('{"heos": {"command": "system/sign_in", "result": "success", "message": "command under process&un=dad@example.com"}}\r\n');
        setTimeout(() => {
          signedIn = true;
          socket.write('{"heos": {"command": "system/sign_in", "result": "success", "message": "signed_in&un=dad@example.com"}}\r\n');
        }, 50);
      } else if (cmd === 'heos://system/check_account') {
        const message = signedIn ? 'signed_in&un=dad@example.com' : 'signed_out';
        socket.write(`{"heos": {"command": "system/check_account", "result": "success", "message": "${message}"}}\r\n`);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const driver = new HEOSDriver({ host: '127.0.0.1', port: server.address().port });
  try {
    assert.deepEqual(await driver.getAccount(), { signedIn: false, username: null });
    const account = await driver.signIn('dad@example.com', secret);
    assert.deepEqual(account, { signedIn: true, username: 'dad@example.com' });
    assert.equal(received, 'heos://system/sign_in?un=dad@example.com&pw=p%26ss%3Dw%25rd');

    // A refused sign-in reports the amp's reason, never the password.
    driver._request = async () => ({ heos: { command: 'system/sign_in', result: 'fail', message: 'eid=10&text=User not found' } });
    await assert.rejects(() => driver.signIn('dad@example.com', secret), (err) => {
      assert.match(err.message, /User not found/);
      assert.ok(!err.message.includes(secret));
      return true;
    });
  } finally {
    server.close();
  }
});

test('heos radio: browse, search and play build safe commands', async () => {
  const HEOSDriver = require('../src/drivers/heos');
  const driver = new HEOSDriver({ host: '127.0.0.1', pid: '42' });
  const sent = [];
  driver._request = async (cmd) => {
    sent.push(cmd);
    if (cmd.startsWith('heos://browse/search')) {
      return { heos: { result: 'success', message: 'sid=3&search=jazz&scid=4&returned=1&count=7' },
        payload: [{ type: 'station', playable: 'yes', name: 'Jazz FM', mid: 's45300', image_url: 'https://img/x.png' }] };
    }
    if (cmd.startsWith('heos://browse/browse')) {
      return { heos: { result: 'success', message: 'sid=3&returned=1&count=25' },
        payload: [{ container: 'yes', type: 'container', playable: 'no', name: 'Soul %26 R%26B', cid: 'http%3A//opml.radiotime.com/x', image_url: 'http://insecure' }] };
    }
    return { heos: { result: 'success', message: '' } };
  };

  const search = await driver.radioSearch('jazz & blues\r\nheos://system/sign_out');
  assert.equal(search.items[0].name, 'Jazz FM');
  assert.equal(search.count, 7);
  assert.ok(!sent[0].includes('\r') && !sent[0].includes('\n'));
  assert.ok(sent[0].includes('search=jazz %26 blues  heos://system/sign_out'), 'the & is escaped and line breaks removed');

  const browse = await driver.radioBrowse('http%3A//opml.radiotime.com/x', 50);
  assert.equal(browse.items[0].name, 'Soul & R&B');
  assert.equal(browse.items[0].kind, 'folder');
  assert.equal(browse.items[0].image, null, 'only https images are passed on');
  assert.equal(HEOSDriver._safeImage('http://cdn-profiles.tunein.com/s1/images/logoq.png'), 'https://cdn-profiles.tunein.com/s1/images/logoq.png');
  assert.equal(HEOSDriver._safeImage('http://evil.example/x.png'), null);
  assert.ok(sent[1].endsWith('&range=50,99'));

  await driver.radioPlay('s45300', 'Jazz FM & more');
  assert.equal(sent[2], 'heos://browse/play_stream?pid=42&sid=3&mid=s45300&name=Jazz FM %26 more');

  await assert.rejects(() => driver.radioPlay('s1&pid=9', 'x'), /invalid station/);
  await assert.rejects(() => driver.radioBrowse('abc\r\nheos://system/sign_out'), /invalid radio folder/);
  assert.equal(sent.length, 3, 'rejected values never reach the amp');
});

test('remote: only known buttons, sleep steps, capped volume, honest menu keys', async () => {
  const { isRemoteKey, pressRemoteKey } = require('../src/remote');
  assert.equal(isRemoteKey('vol_up'), true);
  assert.equal(isRemoteKey('PWON'), false);
  assert.equal(isRemoteKey('__proto__'), false);

  const sent = [];
  let sleep = 0;
  let volume = 40;
  const avr = {
    getSleep: async () => sleep,
    setSleep: async (value) => { sleep = value; return value; },
    sendKey: async (cmd) => { sent.push(cmd); return true; },
    trySource: async (code) => { sent.push(`SI${code}`); return code === 'BT'; }
  };
  const driver = {
    driverOf: (type) => (type === 'denon_avr' ? avr : null),
    getVolume: async () => volume,
    setVolume: async (v) => { volume = v; },
    getInput: async () => 'OPT1'
  };

  assert.equal((await pressRemoteKey(driver, 'sleep', { volumeCap: 40 })).sleep, 10);
  sleep = 90;
  assert.equal((await pressRemoteKey(driver, 'sleep', { volumeCap: 40 })).sleep, 0, '90 wraps to off');

  const up = await pressRemoteKey(driver, 'vol_up', { volumeCap: 40 });
  assert.equal(volume, 40, 'never above the cap');
  assert.equal(up.capped, true);

  const menu = await pressRemoteKey(driver, 'enter', { volumeCap: 40 });
  assert.equal(menu.verified, false, 'the amp cannot confirm menu keys');
  assert.ok(sent.includes('MNENT'));

  await pressRemoteKey(driver, 'src_bluetooth', { volumeCap: 40 });
  await assert.rejects(() => pressRemoteKey(driver, 'src_optcoax', { volumeCap: 40 }), /ignored OPT2/);
});

test('clock: alarms fire once on the right days, capped and faded; timers and reminders ring', async () => {
  const os = require('os');
  const { Scheduler } = require('../src/schedule');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-sched-')), 'schedule.json');
  let now = new Date(2026, 10, 9, 6, 59, 30);   // Monday 06:59:30 local time
  const calls = [];
  const driver = {
    getInputs: () => [{ id: 'BT', label: 'Bluetooth' }],
    getPowerState: async () => 'standby',
    powerOn: async () => calls.push('on'),
    powerOff: async () => calls.push('standby'),
    unmute: async () => calls.push('unmute'),
    setVolume: async (v) => calls.push(`vol ${v}`),
    radioPlay: async (mid) => calls.push(`radio ${mid}`),
    setInput: async (id) => calls.push(`input ${id}`)
  };
  const manager = {
    getDevices: () => [{ id: 'amp' }],
    getDriver: () => driver,
    getVolumeCap: () => 40
  };
  const sched = new Scheduler({ file, manager, now: () => now, wait: async () => {} });

  assert.throws(() => sched.addAlarm({ time: '7:00' }), /HH:MM/);
  assert.throws(() => sched.addAlarm({ time: '07:00', action: { type: 'radio', mid: 's1&pid=2' } }), /station/);
  assert.throws(() => sched.addAlarm({ time: '07:00', action: { type: 'shell' } }), /chime, radio or input/);

  const weekday = sched.addAlarm({ time: '07:00', days: [1, 2, 3, 4, 5], volume: 90, action: { type: 'radio', mid: 's24940', name: 'BBC Radio 2' } });
  assert.equal(weekday.volume, 40, 'alarm volume is capped');
  const weekend = sched.addAlarm({ time: '07:00', days: [0, 6], action: { type: 'chime' } });

  await sched.tick();
  assert.equal(calls.length, 0, 'not yet');

  now = new Date(2026, 10, 9, 7, 0, 5);
  await sched.tick();
  await new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 50 && !calls.includes('vol 40'); i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.slice(0, 4), ['on', 'vol 4', 'unmute', 'radio s24940']);
  assert.equal(calls[calls.length - 1], 'vol 40', 'fades up to the alarm volume');
  assert.ok(calls.filter((c) => c.startsWith('vol')).every((c) => Number(c.split(' ')[1]) <= 40));
  assert.equal(sched.list().rings.filter((r) => r.kind === 'alarm').length, 1, 'the weekend alarm stays quiet on a Monday');

  const before = calls.length;
  now = new Date(2026, 10, 9, 7, 0, 40);
  await sched.tick();
  assert.equal(calls.length, before, 'fires only once per day');
  assert.equal(sched.list().alarms.find((a) => a.id === weekend.id).lastFired, null);

  // A one-off alarm switches itself off after ringing.
  const once = sched.addAlarm({ time: '07:01', action: { type: 'chime' } });
  now = new Date(2026, 10, 9, 7, 1, 0);
  await sched.tick();
  assert.equal(sched.list().alarms.find((a) => a.id === once.id).enabled, false);

  // Timer with standby, and a reminder.
  sched.addTimer({ seconds: 60, label: 'Tea', action: 'standby' });
  sched.addReminder({ at: new Date(2026, 10, 9, 7, 1, 30).toISOString(), text: 'Call <b>Dad</b>' });
  assert.throws(() => sched.addTimer({ seconds: 2 }), /5 seconds/);
  assert.throws(() => sched.addReminder({ at: new Date(2020, 0, 1).toISOString(), text: 'x' }), /passed/);
  now = new Date(2026, 10, 9, 7, 2, 5);
  await sched.tick();
  const kinds = sched.list().rings.map((r) => r.kind);
  assert.ok(kinds.includes('timer') && kinds.includes('reminder'));
  assert.ok(calls.includes('standby'), 'the timer put the amp in standby');
  assert.equal(sched.list().rings.find((r) => r.kind === 'reminder').label, 'Call <b>Dad</b>', 'stored as text; the page renders it as text');

  // Survives a restart.
  const again = new Scheduler({ file, manager, now: () => now, wait: async () => {} });
  assert.equal(again.list().alarms.length, 3);
});

test('browser radio: only directory stations, never private addresses', async () => {
  const { WebRadio, isPrivateAddress } = require('../src/webradio');
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.50', '172.20.0.1', '169.254.1.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.1.1', '0.0.0.0']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '151.101.1.1', '2a00:1450::1']) assert.equal(isPrivateAddress(ip), false, ip);

  const uuid = '11111111-2222-3333-4444-555555555555';
  const radio = new WebRadio({ fetchJson: async (p) => {
    assert.ok(p.startsWith('/json/stations/'), p);
    return [
      { stationuuid: uuid, name: 'Jazz One', url_resolved: 'http://stream.example/jazz', favicon: 'http://insecure/logo.png', tags: 'jazz,smooth', hls: 0 },
      { stationuuid: '22222222-2222-3333-4444-555555555555', name: 'HLS', url_resolved: 'https://x.example/live.m3u8', hls: 1 },
      { stationuuid: 'not-a-uuid', name: 'Bad', url_resolved: 'http://x' },
      { stationuuid: '33333333-2222-3333-4444-555555555555', name: 'File', url_resolved: 'file:///etc/passwd' }
    ];
  } });
  const list = await radio.search({ q: 'jazz' });
  assert.deepEqual(list.map((s) => s.name), ['Jazz One'], 'HLS, bad ids and non-http streams are dropped');
  assert.equal(list[0].favicon, '', 'only https logos');
  assert.ok(!('url' in list[0]), 'the stream address is never sent to the browser');
  await assert.rejects(() => radio.search({ tag: 'evil' }), /unknown genre/);
  assert.deepEqual(WebRadio.plan('asot of trance'), { phrase: 'a state of trance', words: ['trance'] });
  assert.equal(WebRadio.plan('ASOT').phrase, 'a state of trance');
  assert.deepEqual(WebRadio.plan('jazz radio fm').words, ['jazz'], 'useful words only, no filler like radio or fm');
  await assert.rejects(() => radio.station('../../etc'), /invalid station/);
});

test('virtual amp keeps state and is the default without a config', async () => {
  const VirtualDriver = require('../src/drivers/virtual');
  const { loadDevices } = require('../src/config/devices');
  const amp = new VirtualDriver({});
  assert.equal(await amp.getPowerState(), 'standby');
  await amp.powerOn();
  await amp.setVolume(150);
  assert.equal(await amp.getVolume(), 100);
  await assert.rejects(() => amp.setInput('HDMI'), /unknown input/);
  amp.setWebStation({ uuid: 'u', name: 'Jazz One', favicon: '' });
  assert.equal((await amp.getNowPlaying()).station, 'Jazz One');
  const saved = process.env.DEVICES_CONFIG;
  process.env.DEVICES_CONFIG = '/nonexistent/devices.json';
  try {
    assert.equal(loadDevices()[0].type, 'virtual');
  } finally {
    if (saved === undefined) delete process.env.DEVICES_CONFIG; else process.env.DEVICES_CONFIG = saved;
  }
});

test('spotify: links, PKCE sign-in, token refresh, tokens never leave the server', async () => {
  const os = require('os');
  const { Spotify, parseLink } = require('../src/spotify');
  assert.deepEqual(parseLink('https://open.spotify.com/playlist/2Ps64TVbfmfX6jxWJnlX1j?si=abc').body, { context_uri: 'spotify:playlist:2Ps64TVbfmfX6jxWJnlX1j' });
  assert.deepEqual(parseLink('https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC').body, { uris: ['spotify:track:4uLU6hMCjMI75M1A2tKUQC'] });
  assert.deepEqual(parseLink('spotify:album:1DFixLWuPkv3KT3TnV35m3').body, { context_uri: 'spotify:album:1DFixLWuPkv3KT3TnV35m3' });
  assert.throws(() => parseLink('https://evil.example/playlist/2Ps64TVbfmfX6jxWJnlX1j'), /not a Spotify link/);
  assert.throws(() => parseLink('https://open.spotify.com/user/someone'), /playlist, album or track/);

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-spot-')), 'spotify.json');
  const calls = [];
  let tokenCount = 0;
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (url.endsWith('/api/token')) {
      tokenCount += 1;
      const form = new URLSearchParams(opts.body);
      assert.ok(!form.has('client_secret'), 'PKCE: no client secret');
      if (form.get('grant_type') === 'authorization_code') assert.ok(form.get('code_verifier').length >= 43);
      return { ok: true, status: 200, json: async () => ({ access_token: `at${tokenCount}`, refresh_token: 'rt', expires_in: tokenCount === 1 ? 0 : 3600 }) };
    }
    if (url.includes('/me/player/play')) return { ok: true, status: 204, json: async () => null };
    if (url.endsWith('/me')) return { ok: true, status: 200, json: async () => ({ display_name: 'Tester', product: 'premium' }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const sp = new Spotify({ file, fetchImpl, port: 8095 });
  assert.throws(() => sp.setClientId('nope'), /32 letters/);
  sp.setClientId('0123456789abcdef0123456789abcdef');
  const login = sp.beginLogin();
  const auth = new URL(login.url);
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(auth.searchParams.get('redirect_uri'), 'http://127.0.0.1:8095/spotify/callback');
  assert.equal(auth.searchParams.get('state'), login.state);
  await sp.finishLogin('code123', login.verifier);
  // The first token was already expired: the next call refreshes it.
  await sp.play('https://open.spotify.com/playlist/2Ps64TVbfmfX6jxWJnlX1j', 'abcdef0123456789');
  assert.equal(tokenCount, 2, 'refreshed before the API call');
  const play = calls.find((c) => c.url.includes('/me/player/play'));
  assert.equal(play.opts.headers.Authorization, 'Bearer at2');
  assert.equal(play.opts.method, 'PUT');
  await assert.rejects(() => sp.play('spotify:playlist:2Ps64TVbfmfX6jxWJnlX1j', 'bad id!'), /invalid speaker/);
  const status = await sp.status();
  assert.equal(status.premium, true);
  assert.ok(!JSON.stringify(status).includes('at2') && !JSON.stringify(status).includes('rt'), 'status never contains tokens');
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
});

test('version: package version and changelog releases are parsed', () => {
  const { versionInfo, parseChangelog } = require('../src/version');
  const info = versionInfo();
  assert.equal(info.version, require('../package.json').version);
  assert.equal(info.releases[0].version, info.version, 'the changelog has an entry for the current version');
  assert.ok(info.releases[0].items.length > 0);
  assert.deepEqual(parseChangelog('## [1.2.0] - 2026-01-02\n- One\n* Two\ntext'), [{ version: '1.2.0', date: '2026-01-02', items: ['One', 'Two'] }]);
});

test('file session store: persists, expires and prunes (SC-06)', async () => {
  const { FileSessionStore } = require('../src/auth/session-store');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-store-')), 'sessions.json');
  const store = new FileSessionStore({ file });
  const get = (s, sid) => new Promise((r) => s.get(sid, (e, v) => r(v)));
  store.set('live', { cookie: { expires: new Date(Date.now() + 60000).toISOString() }, userId: '1' });
  store.set('old', { cookie: { expires: new Date(Date.now() - 1000).toISOString() }, userId: '2' });
  assert.equal((await get(store, 'live')).userId, '1');
  assert.equal(await get(store, 'old'), null, 'expired sessions are not returned');
  store.close();
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
  const again = new FileSessionStore({ file });
  assert.equal((await get(again, 'live')).userId, '1', 'survives a restart');
  assert.equal(again.sessions.has('old'), false, 'pruned on load');
  again.close();
});

test('amp stream addresses refuse private and re-binding DNS answers (SC-07)', async () => {
  const { WebRadio } = require('../src/webradio');
  const radio = new WebRadio({ fetchJson: async () => [] });
  const uuid = '44444444-2222-3333-4444-555555555555';
  radio.known.set(uuid, { uuid, name: 'X', url: 'http://stream.example.org/live' });
  const fake = (answers) => ({ resolve4: async () => answers, resolve6: async () => { throw new Error('none'); } });
  assert.equal((await radio.publicStreamUrl(uuid, fake([{ address: '93.184.216.34', ttl: 300 }]))).url, 'http://stream.example.org/live');
  await assert.rejects(() => radio.publicStreamUrl(uuid, fake([{ address: '192.168.1.20', ttl: 300 }])), /private/);
  radio.dnsRecheckMs = 1;
  await assert.rejects(() => radio.publicStreamUrl(uuid, fake([{ address: '93.184.216.34', ttl: 0 }])), /keeps changing/);
  // A cached answer near expiry is fine once a second lookup returns a normal lifetime.
  let n = 0;
  const refreshing = { resolve4: async () => [{ address: '93.184.216.34', ttl: n++ === 0 ? 1 : 300 }], resolve6: async () => { throw new Error('none'); } };
  assert.ok(await radio.publicStreamUrl(uuid, refreshing));
  radio.known.set(uuid, { uuid, name: 'X', url: 'http://10.0.0.5/live' });
  await assert.rejects(() => radio.publicStreamUrl(uuid), /private/);
});

test('drivers refuse line breaks and hide device addresses (SC-02, SC-03)', async () => {
  const HEOSDriver = require('../src/drivers/heos');
  const DenonAVRDriver = require('../src/drivers/denon_avr');
  const h = new HEOSDriver({ host: '127.0.0.1', port: 9 });
  await assert.rejects(() => h.signIn('a@example.com', 'pw\r\nheos://system/sign_out'), /not allowed/);
  await assert.rejects(() => h._request('heos://system/check_account\r\nheos://system/sign_out'), /line break/);
  await assert.rejects(() => new DenonAVRDriver({ host: '127.0.0.1', port: 9 })._request('PW?\rPWSTANDBY'), /line break/);
  const comp = new CompositeDriver({}, [{ type: 'denon_avr', driver: new DenonAVRDriver({ host: '127.0.0.1', port: 9, timeout: 500 }) }]);
  const err = await comp.powerOn().then(() => null, (e) => e);
  assert.match(err.message, /not answering|did not answer/);
  assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(err.message), 'no address in the user-facing message');
  assert.match(String(err.cause), /127\.0\.0\.1|timeout/, 'details kept for the server log');
});

test('yamaha MusicCast driver against a fake YXC device', async () => {
  const http = require('http');
  const YamahaDriver = require('../src/drivers/yamaha');
  const state = { power: 'standby', volume: 40, max_volume: 161, mute: false, input: 'hdmi1' };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const q = Object.fromEntries(u.searchParams);
    const send = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ response_code: 0, ...o })); };
    switch (u.pathname.replace('/YamahaExtendedControl/v1/', '')) {
      case 'system/getFeatures': return send({ zone: [{ id: 'main', input_list: ['hdmi1', 'net_radio', 'bluetooth', 'bad id!'], range_step: [{ id: 'volume', min: 0, max: 161, step: 1 }] }] });
      case 'system/getNameText': return send({ input_list: [{ id: 'hdmi1', text: 'TV' }, { id: 'net_radio', text: 'Net Radio' }] });
      case 'main/getStatus': return send(state);
      case 'main/setPower': state.power = q.power; return send({});
      case 'main/setVolume': state.volume = Number(q.volume); return send({});
      case 'main/setMute': state.mute = q.enable === 'true'; return send({});
      case 'main/setInput': if (!['hdmi1', 'net_radio', 'bluetooth'].includes(q.input)) return send({ response_code: 3 }); state.input = q.input; return send({});
      case 'netusb/getPlayInfo': return send({ playback: 'play', artist: 'Armin van Buuren', album: 'ASOT', track: 'Track 1', albumart_url: '/YamahaRemoteControl/AlbumART/x.jpg' });
      case 'netusb/setPlayback': state.playback = q.playback; return send({});
      default: return send({ response_code: 4 });
    }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const comp = new CompositeDriver({}, [{ type: 'yamaha', driver: new YamahaDriver({ host: '127.0.0.1', port: srv.address().port }) }]);
    await comp.init();
    assert.deepEqual(comp.getInputs().map((i) => i.label), ['TV', 'Net Radio', 'bluetooth'], 'inputs discovered, unsafe ids dropped');
    await comp.powerOn();
    assert.equal(await comp.getPowerState(), 'on');
    await comp.setVolume(50);
    assert.equal(state.volume, 81, '50% of max 161');
    assert.equal(await comp.getVolume(), 50);
    await comp.mute();
    assert.equal(await comp.getMute(), true);
    await comp.setInput('net_radio');
    assert.equal(state.input, 'net_radio');
    await assert.rejects(() => comp.setInput('hdmi1&power=standby'), /unknown input/);
    const np = await comp.getNowPlaying();
    assert.equal(np.song, 'Track 1');
    assert.equal(np.image_url, null, 'amp-hosted art is not exposed');
    await comp.next();
    assert.equal(state.playback, 'next');
  } finally { srv.close(); }
});

test('onkyo/pioneer eISCP driver against a fake device', async () => {
  const net = require('net');
  const OnkyoDriver = require('../src/drivers/onkyo');
  const { frame, parseMessages } = OnkyoDriver;
  const parsed = parseMessages(Buffer.concat([frame('PWR01'), frame('MVL28')]));
  assert.deepEqual(parsed.messages, ['PWR01', 'MVL28'], 'frames round-trip');
  const state = { PWR: '00', MVL: '14', AMT: '00', SLI: '23', NTI: 'Strobe', NAT: 'deadmau5', NAL: 'For Lack', NST: 'P--' };
  const seen = [];
  const srv = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (c) => {
      const out = parseMessages(Buffer.concat([buf, c]));
      buf = out.rest;
      for (const m of out.messages) {
        seen.push(m);
        const cmd = m.slice(0, 3);
        const arg = m.slice(3);
        if (arg === 'QSTN') sock.write(frame(cmd + state[cmd]));
        else if (state[cmd] !== undefined && cmd !== 'NTC') { state[cmd] = arg; sock.write(frame(cmd + arg)); }
      }
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const d = new OnkyoDriver({ host: '127.0.0.1', port: srv.address().port });
    const comp = new CompositeDriver({}, [{ type: 'onkyo', driver: d }]);
    assert.equal(await d.init(), true);
    await comp.powerOn();
    assert.equal(await comp.getPowerState(), 'on');
    await comp.setVolume(50);
    assert.equal(state.MVL, '28', '50% of 0x50 = 0x28');
    assert.equal(await comp.getVolume(), 50);
    await comp.mute();
    assert.equal(await comp.getMute(), true);
    await comp.setInput('2B');
    assert.equal(state.SLI, '2B');
    await assert.rejects(() => comp.setInput('ZZ'), /unknown input/);
    await assert.rejects(() => d._send('PWR01\r!1PWR00'), /line break/);
    const np = await comp.getNowPlaying();
    assert.deepEqual([np.song, np.artist], ['Strobe', 'deadmau5']);
    assert.ok(!seen.some((m) => m.includes('\r')), 'every message is a single command');
  } finally { srv.close(); }
});

test('bluos (Bluesound/NAD) driver against a fake player', async () => {
  const http = require('http');
  const BluOSDriver = require('../src/drivers/bluos');
  const state = { volume: 20, mute: 0, state: 'pause', played: null };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('Content-Type', 'text/xml');
    if (u.pathname === '/Status') return res.end(`<status etag="1"><title1>Rock &amp; Roll</title1><artist>AC/DC</artist><album>Live</album><image>/Artwork?x</image><state>${state.state}</state><volume>${state.volume}</volume><mute>${state.mute}</mute></status>`);
    if (u.pathname === '/Volume') { if (u.searchParams.has('level')) state.volume = Number(u.searchParams.get('level')); if (u.searchParams.has('mute')) state.mute = Number(u.searchParams.get('mute')); return res.end(`<volume mute="${state.mute}">${state.volume}</volume>`); }
    if (u.pathname === '/Presets') return res.end('<presets><preset id="1" name="Jazz &amp; Soul" url="x"/><preset id="2" name="News"/></presets>');
    if (u.pathname === '/Play') { state.state = 'play'; state.played = u.searchParams.get('url'); return res.end('<state>play</state>'); }
    if (u.pathname === '/Pause') { state.state = 'pause'; return res.end('<state>pause</state>'); }
    res.statusCode = 404; return res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const comp = new CompositeDriver({}, [{ type: 'bluos', driver: new BluOSDriver({ host: '127.0.0.1', port: srv.address().port }) }]);
    await comp.init();
    assert.equal(comp.capabilities().power, false, 'no standby command in BluOS');
    assert.deepEqual(comp.getPresets().map((p) => p.label), ['Jazz & Soul', 'News']);
    await comp.setVolume(35);
    assert.equal(await comp.getVolume(), 35);
    await comp.mute();
    assert.equal(await comp.getMute(), true);
    const np = await comp.getNowPlaying();
    assert.equal(np.song, 'Rock & Roll');
    assert.equal(np.image_url, null, 'player-hosted art is not exposed');
    await comp.playStream('http://stream.example/live.mp3');
    assert.equal(state.played, 'http://stream.example/live.mp3');
    await assert.rejects(() => comp.playStream('file:///etc/passwd'), /invalid stream/);
  } finally { srv.close(); }
});

test('heos playStream sends the address as HEOS expects (not fully percent-encoded)', async () => {
  const HEOSDriver = require('../src/drivers/heos');
  const driver = new HEOSDriver({ host: '127.0.0.1', pid: '7', streamVerifyAttempts: 1, streamVerifyMs: 1 });
  const sent = [];
  driver._request = async (cmd) => {
    sent.push(cmd);
    if (cmd.includes('get_play_state')) return { heos: { result: 'success', message: 'pid=7&state=play' } };
    return { heos: { result: 'success', message: '' } };
  };
  await driver.playStream('http://strm.example.fm/live_mp3?id=5&q=hi');
  assert.equal(sent[0], 'heos://browse/play_stream?pid=7&url=http://strm.example.fm/live_mp3?id%3D5%26q%3Dhi');
  await assert.rejects(() => driver.playStream('http://x.example/a\r\nheos://system/sign_out'), /invalid stream address/);
});

test('heos playStream and playPreset fail clearly when HEOS cannot play', async () => {
  const HEOSDriver = require('../src/drivers/heos');
  const driver = new HEOSDriver({
    host: '127.0.0.1', pid: '1', streamVerifyAttempts: 2, streamVerifyMs: 1
  });

  const commands = [];
  driver._command = async (cmd) => { commands.push(cmd); return { heos: { result: 'success' } }; };
  driver.getPlayState = async () => 'stop';
  await assert.rejects(() => driver.playStream('http://stream.example/radio.mp3'), /did not start playback/);
  assert.match(commands[0], /browse\/play_stream/);

  driver.getPlayState = async () => 'play';
  assert.equal(await driver.playStream('http://stream.example/radio.mp3'), true);

  driver._command = async () => { throw new Error('heos: eid=8&text=User not logged in'); };
  await assert.rejects(() => driver.playPreset(1), /HEOS account not signed in/);
});

test('composite driver routes each capability to the right protocol', async () => {
  const avr = fakeDriver({
    capabilities: { presets: false, playStream: false, transport: false, nowPlaying: false },
    getNowPlaying: async () => { throw new Error('not supported'); }
  });
  const heos = fakeDriver({
    capabilities: { power: false, inputs: false },
    getInputs: () => [],
    getInput: async () => { throw new Error('not supported'); },
    getPowerState: async () => { throw new Error('not supported'); },
    getVolume: async () => 11,
    setVolume: async (level) => { heosCalls.push(['heosVolume', level]); return true; }
  });
  const heosCalls = [];

  const composite = new CompositeDriver(
    { id: 'test', volumeCap: 40 },
    [{ type: 'heos', driver: heos }, { type: 'denon_avr', driver: avr }]
  );

  assert.deepEqual(await composite.getPowerState(), 'on');
  assert.equal(await composite.getVolume(), 12);
  await composite.setVolume(30);
  assert.deepEqual(avr.calls.at(-1), ['setVolume', 30]);

  await composite.setPlayState('play');
  assert.deepEqual(heos.calls.at(-1), ['setPlayState', 'play']);

  const status = await composite.getStatus();
  assert.equal(status.power, 'on');
  assert.equal(status.volume, 12);
  assert.equal(status.playState, 'stop');
  assert.equal(status.nowPlaying.song, 'Test');
  assert.equal(status.capabilities.power, true);
  assert.equal(status.capabilities.transport, true);
  assert.equal(status.inputs.length, 1);
});

test('composite falls back when the preferred driver is unreachable', async () => {
  const broken = fakeDriver({
    getPowerState: async () => { throw new Error('ECONNREFUSED'); },
    powerOn: async () => { throw new Error('ECONNREFUSED'); }
  });
  const backup = fakeDriver({ capabilities: { power: true } });

  const composite = new CompositeDriver(
    { id: 'test' },
    [{ type: 'denon_avr', driver: broken }, { type: 'heos', driver: backup }]
  );

  assert.equal(await composite.getPowerState(), 'on');
  await composite.powerOn();
  assert.deepEqual(backup.calls.at(-1), ['powerOn']);
});

test('users are hashed and verified, and wrong passwords are refused', async () => {
  process.env.USERS_FILE = tempUsersFile();
  const { createUser, verifyUser, loadUsers } = require('../src/auth/users');

  const created = await createUser('jestie', 'correct horse battery');
  assert.equal(created.username, 'jestie');
  assert.equal(loadUsers()[0].passwordHash.startsWith('$2'), true);
  assert.notEqual(loadUsers()[0].passwordHash, 'correct horse battery');

  assert.deepEqual(await verifyUser('jestie', 'correct horse battery'), { id: created.id, username: 'jestie', role: 'admin' });
  const guest = await createUser('guest', 'another fine password', 'user');
  assert.equal((await verifyUser('guest', 'another fine password')).role, 'user');
  await assert.rejects(() => createUser('boss', 'long enough password', 'root'), /admin or user/);
  const { roleOf } = require('../src/auth/users');
  assert.equal(roleOf({ username: 'legacy' }), 'admin', 'accounts from before roles stay admin');
  assert.ok(guest.id);
  assert.equal(await verifyUser('jestie', 'wrong password'), null);
  assert.equal(await verifyUser('nobody', 'correct horse battery'), null);
  await assert.rejects(() => createUser('jestie', 'another long password'), /already exists/);
  await assert.rejects(() => createUser('x', 'short'), /3-32/);
  await assert.rejects(() => createUser('valid-name', 'short'), /at least 10/);
});

test('CSRF tokens are per session and compared in constant time', () => {
  const session = {};
  const first = tokenFor(session);
  assert.equal(tokenFor(session), first);
  assert.equal(first.length >= 40, true);

  const other = tokenFor({});
  assert.notEqual(first, other);

  const middleware = csrfProtection;
  const run = (req) => new Promise((resolve) => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { resolve({ status: this.statusCode, body }); } };
    middleware(req, res, () => resolve({ status: 200, passed: true }));
  });

  return Promise.all([
    run({ method: 'GET', session, get: () => undefined }),
    run({ method: 'POST', session, get: () => first }),
    run({ method: 'POST', session, get: () => 'wrong' }),
    run({ method: 'POST', session, get: () => undefined })
  ]).then(([get, good, bad, missing]) => {
    assert.equal(get.passed, true);
    assert.equal(good.passed, true);
    assert.equal(bad.status, 403);
    assert.equal(missing.status, 403);
  });
});

test('login limiter locks after five failures and resets', () => {
  const limiter = new LoginLimiter({ maxFailures: 3, windowMs: 60_000 });
  const now = 1_000_000;
  assert.equal(limiter.check('1.2.3.4', 'jestie', now).blocked, false);
  limiter.fail('1.2.3.4', 'jestie', now);
  limiter.fail('1.2.3.4', 'jestie', now + 1);
  assert.equal(limiter.check('1.2.3.4', 'jestie', now + 2).blocked, false);
  const third = limiter.fail('1.2.3.4', 'jestie', now + 3);
  assert.equal(third.blocked, true);
  assert.equal(limiter.check('1.2.3.4', 'jestie', now + 4).blocked, true);
  assert.equal(limiter.check('1.2.3.4', 'jestie', now + 61_000).blocked, false);
  limiter.reset('1.2.3.4', 'jestie');
  assert.equal(limiter.check('1.2.3.4', 'jestie', now).blocked, false);
});

test('HTTP API: auth, CSRF, volume cap and device privacy', async (t) => {
  process.env.USERS_FILE = tempUsersFile();
  process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-for-sessions-1234';
  const { createUser } = require('../src/auth/users');
  const createApp = require('../src/app');

  await createUser('tester', 'a-long-test-password');

  const driver = fakeDriver();
  const manager = {
    getDevices: () => [{ id: 'fake', name: 'Fake Amp', room: 'Lab', volumeCap: 40, host: '10.0.0.9' }],
    getDevice: () => ({ id: 'fake', volumeCap: 40 }),
    getVolumeCap: () => 40,
    getDriver: (id) => (id === 'fake' ? driver : null)
  };

  const app = createApp({ manager, logger: { info() {}, warn() {}, error() {} } });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const loginPage = await fetch(`${base}/login`);
  assert.equal(loginPage.status, 200);
  assert.match(await loginPage.text(), /name="password"/);

  const badLogin = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=tester&password=wrong-password',
    redirect: 'manual'
  });
  assert.equal(badLogin.status, 401);
  assert.match(await badLogin.text(), /Invalid username or password/);

  const login = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=tester&password=a-long-test-password',
    redirect: 'manual'
  });
  assert.equal(login.status, 302);
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  assert.match(cookie, /^soundcontrol\.sid=/);

  const page = await fetch(`${base}/`, { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  const html = await page.text();
  const token = /name="csrf-token" content="([^"]+)"/.exec(html)[1];
  assert.ok(token.length > 20);

  const noToken = await fetch(`${base}/api/devices/fake/power`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: 'on' })
  });
  assert.equal(noToken.status, 403);

  const powered = await fetch(`${base}/api/devices/fake/power`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token },
    body: JSON.stringify({ state: 'on' })
  });
  assert.equal(powered.status, 200);
  assert.deepEqual(driver.calls.at(-1), ['powerOn']);

  const loud = await fetch(`${base}/api/devices/fake/volume`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token },
    body: JSON.stringify({ level: 95 })
  });
  assert.equal(loud.status, 200);
  const loudBody = await loud.json();
  assert.equal(loudBody.level, 40);
  assert.equal(loudBody.capped, true);
  assert.deepEqual(driver.calls.at(-1), ['setVolume', 40]);

  const badInput = await fetch(`${base}/api/devices/fake/input`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token },
    body: JSON.stringify({ input: 'NOT_A_REAL_INPUT' })
  });
  assert.equal(badInput.status, 400);
  assert.match((await badInput.json()).error, /unknown input/);

  const listed = await fetch(`${base}/api/devices`, { headers: { Cookie: cookie } });
  const devices = await listed.json();
  assert.equal(devices[0].name, 'Fake Amp');
  assert.equal(devices[0].host, undefined);

  const status = await fetch(`${base}/api/devices/fake/status`, { headers: { Cookie: cookie } });
  assert.equal(status.status, 200);
  const statusBody = await status.json();
  assert.equal(statusBody.volumeCap, 40);
  assert.equal(statusBody.power, 'on');

  const noAuth = await fetch(`${base}/api/devices`);
  assert.equal(noAuth.status, 401);

  const logout = await fetch(`${base}/logout`, {
    method: 'POST',
    headers: { Cookie: cookie, 'X-CSRF-Token': token },
    redirect: 'manual'
  });
  assert.equal(logout.status, 302);
});
