const express = require('express');
const { clampVolume, validateStreamUrl } = require('../utils/volume');
const { csrfProtection } = require('../auth/csrf');
const { isRemoteKey, pressRemoteKey } = require('../remote');
const { WebRadio } = require('../webradio');

const PLAY_STATES = new Set(['play', 'pause', 'stop']);

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function createApiRouter({ manager, logger, scheduler = null, webradio = new WebRadio({ logger }), spotify = null }) {
  const router = express.Router();

  function requireAuth(req, res, next) {
    if (req.session && req.session.userId) return next();
    return res.status(401).json({ error: 'not signed in' });
  }

  function device(req, res) {
    const driver = manager.getDriver(req.params.id);
    if (!driver) {
      res.status(404).json({ error: 'device not found' });
      return null;
    }
    return driver;
  }

  function badRequest(res, message) {
    return res.status(400).json({ error: message });
  }

  router.use(requireAuth);
  router.use(csrfProtection);

  router.get('/devices', (req, res) => {
    // Whitelist the public fields: never leak addresses or credentials.
    const devices = manager.getDevices().map((device) => ({
      id: device.id,
      name: device.name,
      room: device.room || '',
      faceplate: device.faceplate || null,
      handset: device.handset || null,
      virtual: Boolean(device.virtual),
      volumeCap: manager.getVolumeCap(device.id)
    }));
    res.json(devices);
  });

  router.post('/devices/:id/label', wrap(async (req, res) => {
    if (!manager.getDevice(req.params.id)) return res.status(404).json({ error: 'device not found' });
    if (typeof manager.setLabel !== 'function') return badRequest(res, 'renaming is not supported');
    try {
      const label = manager.setLabel(req.params.id, req.body || {});
      logger.info({ action: 'rename', device: req.params.id, user: req.session.username });
      return res.json(label);
    } catch (e) {
      return badRequest(res, e.message);
    }
  }));

  router.get('/session', (req, res) => {
    res.json({ user: req.session.username });
  });

  router.get('/devices/:id/status', wrap(async (req, res) => {
    const driver = device(req, res);
    if (!driver) return;
    const status = await driver.getStatus();
    res.json({
      id: req.params.id,
      ...status,
      volumeCap: manager.getVolumeCap(req.params.id)
    });
  }));

  router.post('/devices/:id/power', wrap(async (req, res) => {
    const driver = device(req, res);
    if (!driver) return;
    const { state } = req.body || {};
    if (!['on', 'off'].includes(state)) return badRequest(res, 'state must be on or off');

    if (state === 'on') await driver.powerOn();
    else await driver.powerOff();

    logger.info({ action: 'power', device: req.params.id, state, user: req.session.username });
    res.json({ ok: true, state });
  }));

  router.post('/devices/:id/volume', wrap(async (req, res) => {
    const driver = device(req, res);
    if (!driver) return;
    const cap = manager.getVolumeCap(req.params.id);

    let clamped;
    try {
      clamped = clampVolume((req.body || {}).level, cap);
    } catch (e) {
      return badRequest(res, e.message);
    }

    await driver.setVolume(clamped.level);
    logger.info({ action: 'volume', device: req.params.id, level: clamped.level, capped: clamped.capped, user: req.session.username });
    res.json({ ok: true, level: clamped.level, cap, capped: clamped.capped });
  }));

  router.post('/devices/:id/mute', wrap(async (req, res) => {
    const driver = device(req, res);
    if (!driver) return;
    const { state } = req.body || {};
    if (!['on', 'off'].includes(state)) return badRequest(res, 'state must be on or off');

    if (state === 'on') await driver.mute();
    else await driver.unmute();

    logger.info({ action: 'mute', device: req.params.id, state, user: req.session.username });
    res.json({ ok: true, muted: state === 'on' });
  }));

  router.post('/devices/:id/input', wrap(async (req, res) => {
    const driver = device(req, res);
    if (!driver) return;
    const { input } = req.body || {};
    if (typeof input !== 'string' || input === '') return badRequest(res, 'input is required');

    const inputs = typeof driver.getInputs === 'function' ? driver.getInputs() : [];
    if (inputs.length > 0 && !inputs.some((entry) => entry.id === input)) {
      return badRequest(res, `unknown input: ${input}`);
    }

    await driver.setInput(input);
    logger.info({ action: 'input', device: req.params.id, input, user: req.session.username });
    res.json({ ok: true, input });
  }));

  // HEOS account. The password is passed straight to the amp: never logged,
  // never stored, never echoed back.
  router.get('/devices/:id/account', wrap(async (req, res) => {
    const driver = device(req, res);
    if (!driver) return;
    if (typeof driver.getAccount !== 'function' || !(driver.capabilities() || {}).account) return badRequest(res, 'this device has no HEOS account');
    const account = await driver.getAccount();
    if (!account) return res.status(502).json({ error: 'the amp did not answer the account check' });
    res.json(account);
  }));

  router.post('/devices/:id/account/signin', wrap(async (req, res) => {
    const driver = device(req, res);
    if (!driver) return;
    if (typeof driver.signIn !== 'function') return badRequest(res, 'this device has no HEOS account');
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username) || username.length > 254) {
      return badRequest(res, 'enter the email address of the HEOS account');
    }
    if (typeof password !== 'string' || password.length === 0 || password.length > 128) {
      return badRequest(res, 'enter the HEOS password');
    }
    try {
      const account = await driver.signIn(username.trim(), password);
      logger.info({ action: 'heos_sign_in', device: req.params.id, result: 'ok', user: req.session.username });
      res.json({ ok: true, ...account });
    } catch (e) {
      logger.info({ action: 'heos_sign_in', device: req.params.id, result: 'failed', user: req.session.username });
      res.status(400).json({ error: e.message });
    }
  }));

  router.post('/devices/:id/account/signout', wrap(async (req, res) => {
    const driver = device(req, res);
    if (!driver) return;
    if (typeof driver.signOut !== 'function') return badRequest(res, 'this device has no HEOS account');
    const account = await driver.signOut();
    logger.info({ action: 'heos_sign_out', device: req.params.id, user: req.session.username });
    res.json({ ok: true, ...account });
  }));

  // ---- Spotify (Web API; tokens never leave the server) ----
  function withSpotify(handler) {
    return wrap(async (req, res) => {
      if (!spotify) return res.status(503).json({ error: 'Spotify is not available' });
      try {
        await handler(req, res);
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
      return undefined;
    });
  }
  router.get('/spotify/status', withSpotify(async (req, res) => res.json(await spotify.status())));
  router.post('/spotify/client', withSpotify(async (req, res) => {
    spotify.setClientId((req.body || {}).clientId);
    logger.info({ action: 'spotify_client_set', user: req.session.username });
    res.json(await spotify.status());
  }));
  router.post('/spotify/disconnect', withSpotify(async (req, res) => {
    spotify.disconnect();
    logger.info({ action: 'spotify_disconnected', user: req.session.username });
    res.json({ ok: true });
  }));
  router.get('/spotify/devices', withSpotify(async (req, res) => res.json(await spotify.devices())));
  router.get('/spotify/playlists', withSpotify(async (req, res) => res.json(await spotify.playlists())));
  router.get('/spotify/now', withSpotify(async (req, res) => res.json(await spotify.nowPlaying())));
  router.post('/spotify/play', withSpotify(async (req, res) => {
    const { link, deviceId } = req.body || {};
    const target = await spotify.play(link, deviceId || null);
    logger.info({ action: 'spotify_play', kind: target.kind, user: req.session.username });
    res.json({ ok: true, kind: target.kind });
  }));
  router.post('/spotify/control', withSpotify(async (req, res) => {
    await spotify.control((req.body || {}).action);
    res.json({ ok: true });
  }));

  // ---- Browser radio (Radio Browser directory; plays in the page) ----
  router.get('/webradio/genres', (req, res) => res.json(WebRadio.genres()));

  router.get('/webradio/search', wrap(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const tag = typeof req.query.tag === 'string' ? req.query.tag : '';
    if (q.length > 60) return badRequest(res, 'search is too long');
    try {
      return res.json(await webradio.search({ q, tag }));
    } catch (e) {
      return res.status(502).json({ error: `radio directory: ${e.message}` });
    }
  }));

  router.get('/webradio/stream/:uuid', wrap(async (req, res) => {
    try {
      await webradio.stream(req.params.uuid, req, res);
    } catch (e) {
      if (!res.headersSent) res.status(400).json({ error: e.message });
    }
  }));

  // Play an open-directory station on a real amp (HEOS). The browser sends the
  // station's id; the server looks up the address itself.
  router.post('/devices/:id/webradio/play-on-amp', wrap(async (req, res) => {
    const driver = device(req, res);
    if (!driver) return;
    if (typeof driver.playStream !== 'function' || !(driver.capabilities() || {}).playStream) return badRequest(res, 'this device cannot play stream addresses');
    let stream;
    try { stream = await webradio.publicStreamUrl((req.body || {}).uuid); } catch (e) { return badRequest(res, e.message); }
    try {
      await driver.playStream(stream.url);
    } catch (e) {
      return res.status(502).json({ error: e.message });
    }
    logger.info({ action: 'webradio_on_amp', device: req.params.id, station: stream.name, user: req.session.username });
    return res.json({ ok: true, name: stream.name });
  }));

  // The page tells a virtual amp what it is playing (for its display and the clock).
  router.post('/devices/:id/webradio/playing', wrap(async (req, res) => {
    const driver = device(req, res);
    if (!driver) return;
    const virtual = typeof driver.driverOf === 'function' ? driver.driverOf('virtual') : null;
    if (!virtual) return badRequest(res, 'only a virtual amp plays browser radio');
    let station;
    try { station = await webradio.station((req.body || {}).uuid); } catch (e) { return badRequest(res, e.message); }
    virtual.setWebStation(station);
    logger.info({ action: 'webradio_play', device: req.params.id, station: station.name, user: req.session.username });
    res.json({ ok: true });
  }));

  // ---- Clock: alarms, timers, reminders ----
  function withSchedule(handler) {
    return wrap(async (req, res) => {
      if (!scheduler) return res.status(503).json({ error: 'the clock is not running' });
      try {
        await handler(req, res);
      } catch (e) {
        if (e.message === 'not found') return res.status(404).json({ error: 'not found' });
        return badRequest(res, e.message);
      }
      return undefined;
    });
  }
  const audit = (req, action, extra = {}) => logger.info({ action, user: req.session.username, ...extra });

  router.get('/schedule', withSchedule(async (req, res) => res.json(scheduler.list())));
  router.post('/schedule/alarms', withSchedule(async (req, res) => {
    const alarm = scheduler.addAlarm(req.body || {});
    audit(req, 'alarm_add', { alarm: alarm.id, time: alarm.time });
    res.json(alarm);
  }));
  router.patch('/schedule/alarms/:sid', withSchedule(async (req, res) => {
    const alarm = scheduler.updateAlarm(req.params.sid, req.body || {});
    audit(req, 'alarm_update', { alarm: alarm.id });
    res.json(alarm);
  }));
  router.delete('/schedule/alarms/:sid', withSchedule(async (req, res) => {
    scheduler.removeAlarm(req.params.sid);
    audit(req, 'alarm_remove', { alarm: req.params.sid });
    res.json({ ok: true });
  }));
  router.post('/schedule/alarms/:sid/test', withSchedule(async (req, res) => {
    const alarm = scheduler.list().alarms.find((a) => a.id === req.params.sid);
    if (!alarm) return res.status(404).json({ error: 'not found' });
    audit(req, 'alarm_test', { alarm: alarm.id });
    await scheduler.fireAlarm(alarm);
    return res.json({ ok: true });
  }));
  router.post('/schedule/timers', withSchedule(async (req, res) => {
    const timer = scheduler.addTimer(req.body || {});
    audit(req, 'timer_add', { timer: timer.id, seconds: timer.seconds, standby: timer.action === 'standby' });
    res.json(timer);
  }));
  router.delete('/schedule/timers/:sid', withSchedule(async (req, res) => {
    scheduler.cancelTimer(req.params.sid);
    audit(req, 'timer_cancel', { timer: req.params.sid });
    res.json({ ok: true });
  }));
  router.post('/schedule/reminders', withSchedule(async (req, res) => {
    const reminder = scheduler.addReminder(req.body || {});
    audit(req, 'reminder_add', { reminder: reminder.id });
    res.json(reminder);
  }));
  router.delete('/schedule/reminders/:sid', withSchedule(async (req, res) => {
    scheduler.removeReminder(req.params.sid);
    audit(req, 'reminder_remove', { reminder: req.params.sid });
    res.json({ ok: true });
  }));

  // The handset: one button per request, from a fixed list.
  router.post('/devices/:id/remote', wrap(async (req, res) => {
    const driver = device(req, res);
    if (!driver) return;
    const { key } = req.body || {};
    if (!isRemoteKey(key)) return badRequest(res, 'unknown button');
    try {
      const result = await pressRemoteKey(driver, key, { volumeCap: manager.getVolumeCap(req.params.id) });
      logger.info({ action: 'remote', device: req.params.id, key, verified: result.verified, user: req.session.username });
      res.json(result);
    } catch (e) {
      logger.info({ action: 'remote', device: req.params.id, key, result: 'failed', user: req.session.username });
      res.status(400).json({ error: e.message });
    }
  }));

  // Internet radio (TuneIn through HEOS).
  function radioDriver(req, res) {
    const driver = device(req, res);
    if (!driver) return null;
    if (typeof driver.radioBrowse !== 'function' || !(driver.capabilities() || {}).radio) {
      badRequest(res, 'internet radio is not supported by this device');
      return null;
    }
    return driver;
  }

  router.get('/devices/:id/radio/browse', wrap(async (req, res) => {
    const driver = radioDriver(req, res);
    if (!driver) return;
    const cid = typeof req.query.cid === 'string' && req.query.cid !== '' ? req.query.cid : null;
    if (cid !== null && !/^[A-Za-z0-9%._~:/+-]{1,1500}$/.test(cid)) return badRequest(res, 'invalid radio folder');
    const start = Math.min(10000, Math.max(0, parseInt(req.query.start, 10) || 0));
    res.json(await driver.radioBrowse(cid, start));
  }));

  router.get('/devices/:id/radio/search', wrap(async (req, res) => {
    const driver = radioDriver(req, res);
    if (!driver) return;
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    if (q.trim().length < 2 || q.length > 60) return badRequest(res, 'type 2 to 60 characters');
    res.json(await driver.radioSearch(q));
  }));

  router.post('/devices/:id/radio/play', wrap(async (req, res) => {
    const driver = radioDriver(req, res);
    if (!driver) return;
    const { mid, name, cid } = req.body || {};
    if (typeof mid !== 'string' || !/^[A-Za-z0-9%._~:/+-]{1,128}$/.test(mid)) return badRequest(res, 'invalid station');
    if (cid !== undefined && cid !== null && (typeof cid !== 'string' || !/^[A-Za-z0-9%._~:/+-]{1,1500}$/.test(cid))) {
      return badRequest(res, 'invalid radio folder');
    }
    const label = typeof name === 'string' ? name.slice(0, 120) : 'Radio';
    await driver.radioPlay(mid, label, cid || null);
    logger.info({ action: 'radio_play', device: req.params.id, station: label, mid, user: req.session.username });
    res.json({ ok: true });
  }));

  router.post('/devices/:id/sourcedirect', wrap(async (req, res) => {
    const driver = device(req, res);
    if (!driver) return;
    const { state } = req.body || {};
    if (!['on', 'off'].includes(state)) return badRequest(res, 'state must be on or off');
    if (typeof driver.setSourceDirect !== 'function') return badRequest(res, 'source direct is not supported by this device');

    await driver.setSourceDirect(state === 'on');
    logger.info({ action: 'sourcedirect', device: req.params.id, state, user: req.session.username });
    res.json({ ok: true, sourceDirect: state === 'on' });
  }));

  router.post('/devices/:id/play', wrap(async (req, res) => {
    const driver = device(req, res);
    if (!driver) return;
    const { state } = req.body || {};
    if (!PLAY_STATES.has(state)) return badRequest(res, 'state must be play, pause or stop');

    await driver.setPlayState(state);
    logger.info({ action: 'play', device: req.params.id, state, user: req.session.username });
    res.json({ ok: true, state });
  }));

  router.post('/devices/:id/transport', wrap(async (req, res) => {
    const driver = device(req, res);
    if (!driver) return;
    const { action } = req.body || {};
    if (!['next', 'previous', 'toggle'].includes(action)) return badRequest(res, 'action must be next, previous or toggle');

    if (action === 'next') await driver.next();
    else if (action === 'previous') await driver.previous();
    else await driver.playPause();

    logger.info({ action: 'transport', device: req.params.id, action, user: req.session.username });
    res.json({ ok: true, action });
  }));

  router.post('/devices/:id/preset', wrap(async (req, res) => {
    const driver = device(req, res);
    if (!driver) return;
    const preset = parseInt((req.body || {}).preset, 10);
    if (!Number.isFinite(preset) || preset < 1) return badRequest(res, 'preset must be a positive number');

    await driver.playPreset(preset);
    logger.info({ action: 'preset', device: req.params.id, preset, user: req.session.username });
    res.json({ ok: true, preset });
  }));

  router.post('/devices/:id/stream', wrap(async (req, res) => {
    const driver = device(req, res);
    if (!driver) return;

    let url;
    try {
      url = validateStreamUrl((req.body || {}).url);
    } catch (e) {
      return badRequest(res, e.message);
    }

    await driver.playStream(url);
    logger.info({ action: 'stream', device: req.params.id, url, user: req.session.username });
    res.json({ ok: true, url });
  }));

  router.get('/devices/:id/nowplaying', wrap(async (req, res) => {
    const driver = device(req, res);
    if (!driver) return;
    res.json(await driver.getNowPlaying());
  }));

  return router;
}

module.exports = createApiRouter;
