const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

  assert.deepEqual(await verifyUser('jestie', 'correct horse battery'), { id: created.id, username: 'jestie' });
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
