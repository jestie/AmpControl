const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Alarms, timers and reminders.
 *
 * They live on the server so an alarm goes off even when no browser is open:
 * a radio alarm switches the amp on, tunes the station and fades up to the
 * chosen volume (never above the device's cap). Browsers that are open poll
 * GET /api/schedule and chime for anything in `rings` they have not seen.
 *
 * Times are the server's local time (Europe/London on the reference host).
 * Stored in data/schedule.json (not in git).
 */

const LIMITS = { alarms: 20, timers: 10, reminders: 50, rings: 30 };
const MID_RE = /^[A-Za-z0-9%._~:/+-]{1,128}$/;
const ID_RE = /^[a-f0-9]{12}$/;

function newId() { return crypto.randomBytes(6).toString('hex'); }

function cleanText(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function dayKey(date) {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

class Scheduler {
  constructor({ file, manager, logger, now = () => new Date(), wait } = {}) {
    this.file = file || process.env.SCHEDULE_FILE || path.join(__dirname, '../data/schedule.json');
    this.manager = manager;
    this.logger = logger || { info() {}, error() {} };
    this.now = now;
    this.wait = wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.state = { alarms: [], timers: [], reminders: [], rings: [] };
    this.timer = null;
    this.load();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const key of ['alarms', 'timers', 'reminders', 'rings']) {
        if (Array.isArray(data[key])) this.state[key] = data[key];
      }
    } catch (e) {
      // First run, or unreadable: start empty.
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  start(intervalMs = 10000) {
    this.stop();
    this.timer = setInterval(() => this.tick().catch((e) => this.logger.error({ action: 'schedule_tick', error: e.message })), intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---- views ----

  list() {
    return {
      serverTime: this.now().toISOString(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      alarms: this.state.alarms,
      timers: this.state.timers.filter((t) => !t.cancelled),
      reminders: this.state.reminders,
      rings: this.state.rings
    };
  }

  _device(deviceId) {
    const devices = this.manager.getDevices();
    const id = deviceId || (devices[0] && devices[0].id);
    if (!devices.some((d) => d.id === id)) throw new Error('unknown device');
    return id;
  }

  // ---- validation ----

  _alarmFields(input, existing = {}) {
    const out = { ...existing };
    if (input.time !== undefined) {
      if (typeof input.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) throw new Error('time must be HH:MM');
      out.time = input.time;
    }
    if (input.days !== undefined) {
      if (!Array.isArray(input.days) || input.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error('days must be 0-6 (Sunday = 0)');
      out.days = [...new Set(input.days)].sort();
    }
    if (input.label !== undefined) out.label = cleanText(input.label, 60);
    if (input.enabled !== undefined) out.enabled = Boolean(input.enabled);
    if (input.deviceId !== undefined || !out.deviceId) out.deviceId = this._device(input.deviceId);
    if (input.volume !== undefined) {
      const v = Number(input.volume);
      if (!Number.isInteger(v) || v < 0 || v > 100) throw new Error('volume must be 0-100');
      out.volume = Math.min(v, this.manager.getVolumeCap(out.deviceId));
    }
    if (input.action !== undefined) {
      const action = input.action || {};
      if (action.type === 'chime') out.action = { type: 'chime' };
      else if (action.type === 'radio') {
        if (typeof action.mid !== 'string' || !MID_RE.test(action.mid)) throw new Error('choose a radio station');
        out.action = { type: 'radio', mid: action.mid, name: cleanText(action.name, 120) || 'Radio' };
      } else if (action.type === 'input') {
        const driver = this.manager.getDriver(out.deviceId);
        const inputs = driver && typeof driver.getInputs === 'function' ? driver.getInputs() : [];
        if (!inputs.some((i) => i.id === action.input)) throw new Error('unknown input');
        out.action = { type: 'input', input: action.input };
      } else throw new Error('action must be chime, radio or input');
    }
    if (!out.time) throw new Error('time is required');
    if (!Array.isArray(out.days)) out.days = [];
    if (!out.action) out.action = { type: 'chime' };
    if (out.volume === undefined) out.volume = Math.min(15, this.manager.getVolumeCap(out.deviceId));
    if (out.enabled === undefined) out.enabled = true;
    if (out.label === undefined) out.label = '';
    return out;
  }

  _find(kind, id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('not found');
    const item = this.state[kind].find((entry) => entry.id === id);
    if (!item) throw new Error('not found');
    return item;
  }

  // ---- alarms ----

  addAlarm(input = {}) {
    if (this.state.alarms.length >= LIMITS.alarms) throw new Error(`at most ${LIMITS.alarms} alarms`);
    const alarm = { id: newId(), ...this._alarmFields(input), lastFired: null };
    this.state.alarms.push(alarm);
    this.save();
    return alarm;
  }

  updateAlarm(id, input = {}) {
    const alarm = this._find('alarms', id);
    Object.assign(alarm, this._alarmFields(input, alarm));
    this.save();
    return alarm;
  }

  removeAlarm(id) {
    this._find('alarms', id);
    this.state.alarms = this.state.alarms.filter((a) => a.id !== id);
    this.save();
  }

  // ---- timers ----

  addTimer(input = {}) {
    const active = this.state.timers.filter((t) => !t.done && !t.cancelled);
    if (active.length >= LIMITS.timers) throw new Error(`at most ${LIMITS.timers} timers`);
    const seconds = Number(input.seconds);
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > 24 * 3600) throw new Error('timer must be 5 seconds to 24 hours');
    const action = input.action === 'standby' ? 'standby' : 'none';
    const timer = {
      id: newId(),
      label: cleanText(input.label, 60),
      seconds,
      endsAt: new Date(this.now().getTime() + seconds * 1000).toISOString(),
      action,
      deviceId: this._device(input.deviceId),
      done: false
    };
    this.state.timers.push(timer);
    this.save();
    return timer;
  }

  cancelTimer(id) {
    const timer = this._find('timers', id);
    timer.cancelled = true;
    this.save();
  }

  // ---- reminders ----

  addReminder(input = {}) {
    if (this.state.reminders.length >= LIMITS.reminders) throw new Error(`at most ${LIMITS.reminders} reminders`);
    const text = cleanText(input.text, 120);
    if (!text) throw new Error('write what to remind you of');
    const at = new Date(input.at);
    if (Number.isNaN(at.getTime())) throw new Error('choose a date and time');
    if (at.getTime() < this.now().getTime() - 60000) throw new Error('that time has already passed');
    const reminder = { id: newId(), text, at: at.toISOString(), firedAt: null };
    this.state.reminders.push(reminder);
    this.state.reminders.sort((a, b) => a.at.localeCompare(b.at));
    this.save();
    return reminder;
  }

  removeReminder(id) {
    this._find('reminders', id);
    this.state.reminders = this.state.reminders.filter((r) => r.id !== id);
    this.save();
  }

  // ---- firing ----

  _ring(kind, label, extra = {}) {
    const ring = { id: newId(), kind, label, at: this.now().toISOString(), ...extra };
    this.state.rings.push(ring);
    this.state.rings = this.state.rings.slice(-LIMITS.rings);
    return ring;
  }

  async tick() {
    const now = this.now();
    let changed = false;
    const today = dayKey(now);
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    for (const alarm of this.state.alarms) {
      if (!alarm.enabled || alarm.time !== hhmm || alarm.lastFired === today) continue;
      if (alarm.days.length > 0 && !alarm.days.includes(now.getDay())) continue;
      alarm.lastFired = today;
      if (alarm.days.length === 0) alarm.enabled = false;     // a one-off alarm
      this._ring('alarm', alarm.label || `Alarm ${alarm.time}`, { alarmId: alarm.id });
      changed = true;
      this.fireAlarm(alarm).catch((e) => this.logger.error({ action: 'alarm_failed', alarm: alarm.id, error: e.message }));
    }

    for (const timer of this.state.timers) {
      if (timer.done || timer.cancelled || new Date(timer.endsAt) > now) continue;
      timer.done = true;
      this._ring('timer', timer.label || 'Timer done', { timerId: timer.id });
      changed = true;
      if (timer.action === 'standby') {
        const driver = this.manager.getDriver(timer.deviceId);
        if (driver) driver.powerOff().catch((e) => this.logger.error({ action: 'timer_standby_failed', error: e.message }));
      }
      this.logger.info({ action: 'timer_done', timer: timer.id, standby: timer.action === 'standby' });
    }

    for (const reminder of this.state.reminders) {
      if (reminder.firedAt || new Date(reminder.at) > now) continue;
      reminder.firedAt = now.toISOString();
      this._ring('reminder', reminder.text, { reminderId: reminder.id });
      changed = true;
    }

    // Housekeeping: drop finished timers and old fired reminders after a day.
    const dayAgo = now.getTime() - 24 * 3600 * 1000;
    const timersBefore = this.state.timers.length;
    this.state.timers = this.state.timers.filter((t) => !(t.done || t.cancelled) || new Date(t.endsAt).getTime() > dayAgo);
    const remindersBefore = this.state.reminders.length;
    this.state.reminders = this.state.reminders.filter((r) => !r.firedAt || new Date(r.firedAt).getTime() > dayAgo);
    if (this.state.timers.length !== timersBefore || this.state.reminders.length !== remindersBefore) changed = true;

    if (changed) this.save();
  }

  /** Wake-up: power on, choose the source, then fade up gently to the alarm volume. */
  async fireAlarm(alarm) {
    const driver = this.manager.getDriver(alarm.deviceId);
    if (!driver) throw new Error('device not available');
    this.logger.info({ action: 'alarm', alarm: alarm.id, type: alarm.action.type });
    if (alarm.action.type === 'chime') return;

    const cap = this.manager.getVolumeCap(alarm.deviceId);
    const target = Math.min(alarm.volume, cap);
    const start = Math.min(4, target);

    if ((await driver.getPowerState().catch(() => 'unknown')) !== 'on') {
      await driver.powerOn();
      await this.wait(5000);   // the amp needs a moment to wake up its network player
    }
    await driver.setVolume(start).catch(() => {});
    await driver.unmute().catch(() => {});
    if (alarm.action.type === 'radio') await driver.radioPlay(alarm.action.mid, alarm.action.name, null);
    else await driver.setInput(alarm.action.input);

    for (let level = start + 1; level <= target; level += 1) {
      await this.wait(2500);
      await driver.setVolume(level);
    }
  }
}

module.exports = { Scheduler, LIMITS };
