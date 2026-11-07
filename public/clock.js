/*
 * The clock: a ghosted digital clock floating over the visualiser, plus the
 * Clock tab (alarms, timers, reminders) and the theme setting.
 *
 * Alarms, timers and reminders live on the server (src/schedule.js) so they
 * work with no browser open; an open page polls them and chimes for new rings.
 * Colours follow the visualiser palette (the 'sc:palette' event).
 */
(() => {
  'use strict';

  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
  const SEEN_KEY = 'soundcontrol.rings.seen';
  const THEME_KEY = 'soundcontrol.theme';
  const CLOCK_KEY = 'soundcontrol.clock.show';
  const WAKE_LABEL = 'Wake-up';

  const store = {
    get(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch (e) { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* private mode */ } }
  };

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of [].concat(children)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child && child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const pad = (n) => String(n).padStart(2, '0');

  // ---- theme: accent colour follows the visualiser palette ----
  let palette = { name: 'Rainbow', stops: ['#ff3d7f', '#ff9f43', '#ffd60a', '#3ccf7a', '#22d3ee', '#4f7cff', '#b26bff'] };

  function luminance(hex) {
    const n = parseInt(hex.slice(1), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }
  function darken(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    const out = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * f));
    return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  }
  // Pick a palette colour that white button text stays readable on.
  function accentFrom(stops) {
    const ok = stops.filter((c) => { const l = luminance(c); return l > 0.08 && l < 0.36; });
    const pool = ok.length ? ok : stops;
    return pool.reduce((best, c) => (Math.abs(luminance(c) - 0.2) < Math.abs(luminance(best) - 0.2) ? c : best), pool[0]);
  }
  function applyTheme() {
    const root = document.documentElement;
    root.style.setProperty('--ghost-gradient', `linear-gradient(90deg, ${palette.stops.join(', ')})`);
    if (store.get(THEME_KEY, 'match') === 'match') {
      const accent = accentFrom(palette.stops);
      root.style.setProperty('--accent', accent);
      root.style.setProperty('--accent-dark', darken(accent, 0.8));
    } else {
      root.style.removeProperty('--accent');
      root.style.removeProperty('--accent-dark');
    }
  }
  window.addEventListener('sc:palette', (event) => {
    if (event.detail && Array.isArray(event.detail.stops)) palette = event.detail;
    applyTheme();
  });

  // ---- chime (Web Audio, no files) ----
  let audioCtx = null;
  function chime(kind) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      audioCtx = audioCtx || new AudioCtx();
      const notes = kind === 'alarm' ? [880, 1175, 1568, 1175, 880, 1175, 1568] : kind === 'timer' ? [988, 1319, 988, 1319] : [784, 1047];
      notes.forEach((freq, i) => {
        const t = audioCtx.currentTime + i * 0.22;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(t);
        osc.stop(t + 0.21);
      });
    } catch (e) { /* no audio: the banner still shows */ }
  }

  function create({ device, api, toast, onOpen, getLastStation = null }) {
    let data = { alarms: [], timers: [], reminders: [], rings: [] };
    let skew = 0;   // server clock minus browser clock, for timer countdowns

    // ---- ghost clock over the visualiser ----
    const ghostTime = el('span', { class: 'ghost-time', text: '--:--' });
    const ghostSec = el('span', { class: 'ghost-sec', text: '' });
    const ghostDate = el('div', { class: 'ghost-date', text: '' });
    const ghost = el('div', { class: 'ghost-clock', 'aria-hidden': 'true' }, [el('div', { class: 'ghost-row' }, [ghostTime, ghostSec]), ghostDate]);
    const chips = el('div', { class: 'clock-chips' });

    // Where the clock lives: floating over the waves, docked under them, or hidden.
    const MODES = ['float', 'dock', 'off'];
    function clockMode() {
      const saved = store.get(CLOCK_KEY, 'float');
      if (saved === 'on') return 'float';           // older setting
      return MODES.includes(saved) ? saved : 'float';
    }
    const dockBtn = el('button', { type: 'button', class: 'clock-dock-btn' });
    let vizRoot = null;
    function placeClock() {
      const mode = clockMode();
      ghost.hidden = mode === 'off';
      ghost.classList.toggle('docked', mode === 'dock');
      if (vizRoot) {
        if (mode === 'dock') vizRoot.after(ghost); else vizRoot.append(ghost);
        dockBtn.hidden = mode === 'off';
        dockBtn.textContent = mode === 'dock' ? '⤒' : '⤓';
        const tip = mode === 'dock' ? 'Float the clock over the waves' : 'Move the clock under the waves';
        dockBtn.title = tip;
        dockBtn.setAttribute('aria-label', tip);
        (mode === 'dock' ? ghost : vizRoot).append(dockBtn);
      }
      if (typeof modeSelect !== 'undefined' && modeSelect) modeSelect.value = mode;
    }
    function setClockMode(mode) { store.set(CLOCK_KEY, mode); placeClock(); }
    dockBtn.addEventListener('click', (event) => {
      event.stopPropagation();      // do not change the visualiser colours
      setClockMode(clockMode() === 'dock' ? 'float' : 'dock');
    });

    function tickGhost() {
      const now = new Date();
      ghostTime.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
      ghostSec.textContent = pad(now.getSeconds());
      ghostDate.textContent = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
      renderChips();
      updateCountdowns();
    }

    // ---- next alarm ----
    function nextAlarm() {
      const now = new Date();
      let best = null;
      for (const alarm of data.alarms) {
        if (!alarm.enabled) continue;
        const [h, m] = alarm.time.split(':').map(Number);
        for (let add = 0; add < 8; add += 1) {
          const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + add, h, m, 0);
          if (at <= now) continue;
          if (alarm.days.length && !alarm.days.includes(at.getDay())) continue;
          if (!best || at < best.at) best = { at, alarm };
          break;
        }
      }
      return best;
    }

    function timeLeft(endsAt) {
      const ms = new Date(endsAt).getTime() - (Date.now() + skew);
      const s = Math.max(0, Math.ceil(ms / 1000));
      const h = Math.floor(s / 3600);
      return h ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
    }

    function renderChips() {
      const items = [];
      const next = nextAlarm();
      if (next) {
        const today = new Date().toDateString() === next.at.toDateString();
        const icon = next.alarm.label === WAKE_LABEL ? '🌅' : '⏰';
        items.push(el('button', { type: 'button', class: 'chip', onclick: onOpen }, `${icon} ${today ? '' : `${DAYS[next.at.getDay()]} `}${next.alarm.time}`));
      }
      for (const timer of data.timers.filter((t) => !t.done)) {
        items.push(el('button', { type: 'button', class: 'chip timer-chip', onclick: onOpen, 'data-ends': timer.endsAt }, `⏲ ${timeLeft(timer.endsAt)}${timer.label ? ` ${timer.label}` : ''}`));
      }
      const upcoming = data.reminders.find((r) => !r.firedAt);
      if (upcoming) {
        const at = new Date(upcoming.at);
        items.push(el('button', { type: 'button', class: 'chip', onclick: onOpen }, `🔔 ${pad(at.getHours())}:${pad(at.getMinutes())} ${upcoming.text.slice(0, 24)}`));
      }
      if (!items.length) items.push(el('button', { type: 'button', class: 'chip ghosted', onclick: onOpen }, '⏰ Set an alarm, timer or reminder'));
      chips.replaceChildren(...items);
    }

    // ---- ringing banner ----
    const banner = el('div', { class: 'ring-banner', role: 'alertdialog', hidden: true });
    document.body.append(banner);
    let repeatTimer = null;
    function ring(item) {
      const icon = item.kind === 'alarm' ? '⏰' : item.kind === 'timer' ? '⏲' : '🔔';
      const title = item.kind === 'alarm' ? 'Alarm' : item.kind === 'timer' ? 'Timer done' : 'Reminder';
      banner.replaceChildren(
        el('div', { class: 'ring-icon', text: icon }),
        el('div', { class: 'ring-text' }, [el('strong', { text: title }), el('div', { text: item.label })]),
        el('button', { type: 'button', class: 'primary', text: 'Dismiss', onclick: stopRinging })
      );
      banner.hidden = false;
      chime(item.kind);
      if (item.kind === 'alarm') {
        const alarm = data.alarms.find((a) => a.id === item.alarmId);
        if (alarm) window.dispatchEvent(new CustomEvent('sc:alarm', { detail: alarm }));
      }
      clearInterval(repeatTimer);
      let count = 0;
      repeatTimer = setInterval(() => { count += 1; if (count > 10) stopRinging(); else chime(item.kind); }, 3000);
      try {
        if ('Notification' in window && Notification.permission === 'granted') new Notification(`${icon} ${title}`, { body: item.label, tag: item.id });
      } catch (e) { /* notifications unavailable */ }
    }
    function stopRinging() { clearInterval(repeatTimer); banner.hidden = true; }

    function checkRings(rings) {
      const seen = store.get(SEEN_KEY, null);
      const newest = rings.length ? rings[rings.length - 1].at : '';
      if (seen === null) { store.set(SEEN_KEY, newest || new Date().toISOString()); return; }   // first visit: no old alarms
      const fresh = rings.filter((r) => r.at > seen);
      if (!fresh.length) return;
      store.set(SEEN_KEY, fresh[fresh.length - 1].at);
      // Ring only for things from the last 10 minutes (a page opened later stays quiet).
      const recent = fresh.filter((r) => Date.now() + skew - new Date(r.at).getTime() < 10 * 60 * 1000);
      if (recent.length) ring(recent[recent.length - 1]);
    }

    // ---- the Clock tab ----
    const alarmList = el('ul', { class: 'clock-list' });
    const timerList = el('ul', { class: 'clock-list' });
    const reminderList = el('ul', { class: 'clock-list' });

    // Alarm form
    const aTime = el('input', { type: 'time', value: '07:00', required: true, 'aria-label': 'Alarm time' });
    const aLabel = el('input', { type: 'text', maxlength: '60', placeholder: 'Label (optional)', 'aria-label': 'Alarm label' });
    const dayBoxes = WEEK_ORDER.map((d) => {
      const box = el('input', { type: 'checkbox', value: String(d), 'aria-label': DAYS[d] });
      return { d, box, label: el('label', { class: 'day' }, [box, el('span', { text: DAYS[d].slice(0, 2) })]) };
    });
    const aAction = el('select', { 'aria-label': 'What the alarm does' });
    const aVolume = el('input', { type: 'range', min: '0', max: String(device.volumeCap || 40), value: String(Math.min(15, device.volumeCap || 40)), 'aria-label': 'Alarm volume' });
    const aVolumeValue = el('span', { class: 'muted small', text: aVolume.value });
    aVolume.addEventListener('input', () => { aVolumeValue.textContent = aVolume.value; });

    function lastStation() {
      if (getLastStation) return getLastStation();     // virtual amp: browser radio
      try { return JSON.parse(store.get(`soundcontrol.radio.last.${device.id}`, 'null')); } catch (e) { return null; }
    }
    function fillActions(inputs) {
      const station = lastStation();
      const options = [el('option', { value: 'chime', text: '🔔 Chime in the browser only' })];
      options.push(station && station.mid
        ? el('option', { value: 'radio', text: `📻 Wake to ${station.name}` })
        : el('option', { value: 'radio', text: '📻 Wake to radio (play a station first)', disabled: true }));
      for (const input of inputs || []) options.push(el('option', { value: `input:${input.id}`, text: `🔌 Amp on, ${input.label}` }));
      const keep = aAction.value;
      aAction.replaceChildren(...options);
      if ([...aAction.options].some((o) => o.value === keep && !o.disabled)) aAction.value = keep;
      else if (station && station.mid) aAction.value = 'radio';
    }

    const alarmForm = el('form', { class: 'clock-form' }, [
      el('div', { class: 'row' }, [aTime, aLabel]),
      el('div', { class: 'days' }, dayBoxes.map((x) => x.label)),
      el('p', { class: 'muted small', text: 'No days ticked = rings once.' }),
      aAction,
      el('label', { class: 'row vol' }, [el('span', { class: 'small', text: 'Volume' }), aVolume, aVolumeValue]),
      el('button', { type: 'submit', class: 'primary', text: 'Add alarm' })
    ]);
    alarmForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const [type, input] = aAction.value.split(':');
      const station = lastStation();
      const action = type === 'radio' ? { type: 'radio', mid: station && station.mid, name: station && station.name }
        : type === 'input' ? { type: 'input', input } : { type: 'chime' };
      try {
        await api('/api/schedule/alarms', { method: 'POST', body: JSON.stringify({
          time: aTime.value, label: aLabel.value, days: dayBoxes.filter((x) => x.box.checked).map((x) => x.d),
          volume: Number(aVolume.value), action, deviceId: device.id
        }) });
        aLabel.value = '';
        toast(`Alarm set for ${aTime.value}`);
        load();
      } catch (e) { toast(e.message); }
    });

    // Timer form
    const tMinutes = el('input', { type: 'number', min: '1', max: '1440', value: '10', 'aria-label': 'Minutes' });
    const tLabel = el('input', { type: 'text', maxlength: '60', placeholder: 'Label (optional)', 'aria-label': 'Timer label' });
    const tStandby = el('input', { type: 'checkbox', 'aria-label': 'Standby the amp when done' });
    async function startTimer(minutes) {
      try {
        await api('/api/schedule/timers', { method: 'POST', body: JSON.stringify({
          seconds: Math.round(minutes * 60), label: tLabel.value, action: tStandby.checked ? 'standby' : 'none', deviceId: device.id
        }) });
        tLabel.value = '';
        load();
      } catch (e) { toast(e.message); }
    }
    const timerForm = el('form', { class: 'clock-form' }, [
      el('div', { class: 'quick' }, [1, 5, 10, 15, 30, 60].map((m) => el('button', { type: 'button', text: m < 60 ? `${m} min` : '1 hour', onclick: () => startTimer(m) }))),
      el('div', { class: 'row' }, [tMinutes, el('span', { class: 'small muted', text: 'min' }), tLabel]),
      el('label', { class: 'row check' }, [tStandby, el('span', { class: 'small', text: 'Put the amp in standby when done (a sleep timer with any length)' })]),
      el('button', { type: 'submit', class: 'primary', text: 'Start timer' })
    ]);
    timerForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const minutes = Number(tMinutes.value);
      if (minutes > 0) startTimer(minutes);
    });

    // Reminder form
    const rWhen = el('input', { type: 'datetime-local', required: true, 'aria-label': 'Remind me at' });
    const rText = el('input', { type: 'text', maxlength: '120', required: true, placeholder: 'Remind me to…', 'aria-label': 'Reminder' });
    const reminderForm = el('form', { class: 'clock-form' }, [rText, el('div', { class: 'row' }, [rWhen, el('button', { type: 'submit', class: 'primary', text: 'Add' })])]);
    reminderForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await api('/api/schedule/reminders', { method: 'POST', body: JSON.stringify({ text: rText.value, at: new Date(rWhen.value).toISOString() }) });
        rText.value = '';
        toast('Reminder added');
        load();
      } catch (e) { toast(e.message); }
    });
    function defaultReminderTime() {
      const t = new Date(Date.now() + 60 * 60 * 1000);
      rWhen.value = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}`;
    }
    defaultReminderTime();

    const notifyBtn = el('button', { type: 'button', class: 'ghost small-btn', text: '🔔 Allow desktop notifications' });
    notifyBtn.addEventListener('click', async () => {
      try { await Notification.requestPermission(); } catch (e) { /* unsupported */ }
      renderNotify();
    });
    function renderNotify() {
      const supported = 'Notification' in window;
      notifyBtn.hidden = !supported || Notification.permission !== 'default';
    }

    // ---- Wake-up radio: one quick setting on top of the Clock tab ----
    const wTime = el('input', { type: 'time', value: '06:00', 'aria-label': 'Wake-up time' });
    const wDays = WEEK_ORDER.map((d) => {
      const box = el('input', { type: 'checkbox', value: String(d), 'aria-label': DAYS[d] });
      box.checked = d >= 1 && d <= 5;
      return { d, box, label: el('label', { class: 'day' }, [box, el('span', { text: DAYS[d].slice(0, 2) })]) };
    });
    const wVolume = el('input', { type: 'range', min: '1', max: String(device.volumeCap || 40), value: String(Math.min(12, device.volumeCap || 40)), 'aria-label': 'Wake-up volume' });
    const wVolumeValue = el('span', { class: 'muted small', text: wVolume.value });
    wVolume.addEventListener('input', () => { wVolumeValue.textContent = wVolume.value; });
    const wStation = el('div', { class: 'small' });
    const wOn = el('input', { type: 'checkbox', class: 'switch', 'aria-label': 'Wake-up radio on or off' });
    const wSave = el('button', { type: 'submit', class: 'primary', text: 'Save wake-up' });
    const wakeForm = el('form', { class: 'clock-form wake' }, [
      el('div', { class: 'row' }, [wTime, el('span', { class: 'grow' }), el('span', { class: 'small muted', text: 'On' }), wOn]),
      el('div', { class: 'days' }, wDays.map((x) => x.label)),
      wStation,
      el('label', { class: 'row vol' }, [el('span', { class: 'small', text: 'Volume' }), wVolume, wVolumeValue]),
      el('p', { class: 'muted small', text: 'The amp switches on, tunes the station and fades up gently to this volume.' }),
      wSave
    ]);
    const wakeAlarm = () => data.alarms.find((a) => a.label === WAKE_LABEL);
    let wakeDirty = false;
    [wTime, wVolume, wOn, ...wDays.map((x) => x.box)].forEach((n) => n.addEventListener('input', () => { wakeDirty = true; }));

    function renderWake() {
      const alarm = wakeAlarm();
      const station = lastStation();
      const useStation = alarm && alarm.action.type === 'radio' ? alarm.action : station;
      wStation.replaceChildren(useStation && useStation.mid
        ? el('span', {}, ['📻 ', el('strong', { text: useStation.name }), el('span', { class: 'muted', text: station && station.mid && alarm && station.mid !== alarm.action.mid ? ` (saving will switch to ${station.name}, your last station)` : '' })])
        : el('span', { class: 'muted', text: '📻 Play a station on the Radio tab first: the wake-up uses your last station.' }));
      if (wakeDirty) return;    // do not overwrite what the user is editing
      if (alarm) {
        wTime.value = alarm.time;
        wDays.forEach((x) => { x.box.checked = alarm.days.includes(x.d); });
        wVolume.value = String(alarm.volume);
        wVolumeValue.textContent = wVolume.value;
        wOn.checked = alarm.enabled;
      } else wOn.checked = true;
    }

    wakeForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const station = lastStation();
      const alarm = wakeAlarm();
      const action = station && station.mid ? { type: 'radio', mid: station.mid, name: station.name } : alarm ? alarm.action : null;
      if (!action) { toast('Play a radio station first, then save the wake-up.'); return; }
      const body = { time: wTime.value, days: wDays.filter((x) => x.box.checked).map((x) => x.d), volume: Number(wVolume.value), enabled: wOn.checked, action, label: WAKE_LABEL, deviceId: device.id };
      try {
        if (alarm) await api(`/api/schedule/alarms/${alarm.id}`, { method: 'PATCH', body: JSON.stringify(body) });
        else await api('/api/schedule/alarms', { method: 'POST', body: JSON.stringify(body) });
        wakeDirty = false;
        toast(wOn.checked ? `Wake-up radio set for ${wTime.value}` : 'Wake-up radio switched off');
        load();
      } catch (e) { toast(e.message); }
    });

    const panel = el('div', { class: 'clock-panel' }, [
      el('section', { class: 'section wake-card' }, [el('div', { class: 'section-label', text: '🌅 Wake-up radio' }), wakeForm]),
      el('section', { class: 'section' }, [el('div', { class: 'section-label', text: 'Alarms' }), alarmList, el('details', {}, [el('summary', { text: '+ New alarm' }), alarmForm])]),
      el('section', { class: 'section' }, [el('div', { class: 'section-label', text: 'Timers' }), timerList, timerForm]),
      el('section', { class: 'section' }, [el('div', { class: 'section-label', text: 'Reminders' }), reminderList, reminderForm]),
      el('p', { class: 'muted small', text: 'Alarms, timers and reminders run on the server, so alarms play even with no browser open. Open pages chime; keep one open for timer and reminder sounds.' }),
      notifyBtn
    ]);

    function describeAlarm(alarm) {
      const days = alarm.days.length === 7 ? 'Every day'
        : alarm.days.length === 0 ? 'Once'
        : JSON.stringify(alarm.days) === '[1,2,3,4,5]' ? 'Weekdays'
        : JSON.stringify(alarm.days) === '[0,6]' ? 'Weekends'
        : WEEK_ORDER.filter((d) => alarm.days.includes(d)).map((d) => DAYS[d]).join(' ');
      const what = alarm.action.type === 'radio' ? `📻 ${alarm.action.name}` : alarm.action.type === 'input' ? `🔌 ${alarm.action.input}` : '🔔 Chime';
      return `${days} · ${what}${alarm.action.type === 'chime' ? '' : ` · vol ${alarm.volume}`}`;
    }

    function renderLists() {
      renderWake();
      alarmList.replaceChildren(...(data.alarms.length ? data.alarms.map((alarm) => {
        const toggle = el('input', { type: 'checkbox', class: 'switch', 'aria-label': `Alarm ${alarm.time} on or off` });
        toggle.checked = alarm.enabled;
        toggle.addEventListener('change', async () => {
          try { await api(`/api/schedule/alarms/${alarm.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: toggle.checked }) }); load(); } catch (e) { toast(e.message); }
        });
        return el('li', { class: `clock-item ${alarm.enabled ? '' : 'off'}` }, [
          el('div', { class: 'big-time', text: alarm.time }),
          el('div', { class: 'grow' }, [el('div', { text: alarm.label || 'Alarm' }), el('div', { class: 'muted small', text: describeAlarm(alarm) })]),
          alarm.action.type === 'chime' ? null : el('button', { type: 'button', class: 'mini', title: 'Test now: runs the wake-up on the amp', text: '▶', onclick: async () => {
            try { toast('Testing the alarm on the amp…'); await api(`/api/schedule/alarms/${alarm.id}/test`, { method: 'POST' }); } catch (e) { toast(e.message); }
          } }),
          toggle,
          el('button', { type: 'button', class: 'mini', 'aria-label': 'Delete alarm', text: '✕', onclick: async () => {
            try { await api(`/api/schedule/alarms/${alarm.id}`, { method: 'DELETE' }); load(); } catch (e) { toast(e.message); }
          } })
        ]);
      }) : [el('li', { class: 'muted small', text: 'No alarms yet.' })]));

      const timers = data.timers.filter((t) => !t.done);
      timerList.replaceChildren(...timers.map((timer) => el('li', { class: 'clock-item' }, [
        el('div', { class: 'big-time countdown', 'data-ends': timer.endsAt, text: timeLeft(timer.endsAt) }),
        el('div', { class: 'grow' }, [el('div', { text: timer.label || 'Timer' }), el('div', { class: 'muted small', text: timer.action === 'standby' ? 'Then the amp goes to standby' : 'Chimes when done' })]),
        el('button', { type: 'button', class: 'mini', 'aria-label': 'Cancel timer', text: '✕', onclick: async () => {
          try { await api(`/api/schedule/timers/${timer.id}`, { method: 'DELETE' }); load(); } catch (e) { toast(e.message); }
        } })
      ])));

      const reminders = data.reminders.filter((r) => !r.firedAt);
      reminderList.replaceChildren(...(reminders.length ? reminders.map((reminder) => {
        const at = new Date(reminder.at);
        return el('li', { class: 'clock-item' }, [
          el('div', { class: 'big-time small-time', text: `${pad(at.getHours())}:${pad(at.getMinutes())}` }),
          el('div', { class: 'grow' }, [el('div', { text: reminder.text }), el('div', { class: 'muted small', text: at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) })]),
          el('button', { type: 'button', class: 'mini', 'aria-label': 'Delete reminder', text: '✕', onclick: async () => {
            try { await api(`/api/schedule/reminders/${reminder.id}`, { method: 'DELETE' }); load(); } catch (e) { toast(e.message); }
          } })
        ]);
      }) : [el('li', { class: 'muted small', text: 'No reminders.' })]));
    }

    function updateCountdowns() {
      panel.querySelectorAll('.countdown').forEach((node) => { node.textContent = timeLeft(node.dataset.ends); });
    }

    async function load() {
      try {
        data = await api('/api/schedule');
        skew = new Date(data.serverTime).getTime() - Date.now();
        renderLists();
        renderChips();
        checkRings(data.rings || []);
      } catch (e) { /* offline: try again on the next poll */ }
    }

    // ---- appearance settings (shown in the Settings tab) ----
    const themeSelect = el('select', { 'aria-label': 'Accent colour' }, [
      el('option', { value: 'match', text: 'Match the visualiser colours' }),
      el('option', { value: 'classic', text: 'Classic blue' })
    ]);
    themeSelect.value = store.get(THEME_KEY, 'match');
    themeSelect.addEventListener('change', () => { store.set(THEME_KEY, themeSelect.value); applyTheme(); });
    var modeSelect = el('select', { 'aria-label': 'Clock position' }, [
      el('option', { value: 'float', text: 'Float over the waves' }),
      el('option', { value: 'dock', text: 'Under the waves' }),
      el('option', { value: 'off', text: 'Hidden' })
    ]);
    modeSelect.value = clockMode();
    modeSelect.addEventListener('change', () => setClockMode(modeSelect.value));
    const appearance = el('section', { class: 'section appearance' }, [
      el('div', { class: 'section-label', text: 'Appearance' }),
      el('label', { class: 'row' }, [el('span', { class: 'grow', text: 'Accent colour' }), themeSelect]),
      el('label', { class: 'row' }, [el('span', { class: 'grow', text: 'Clock' }), modeSelect]),
      el('p', { class: 'muted small', text: 'Tap the visualiser to change its colours; with "Match", the whole app follows.' })
    ]);

    applyTheme();
    placeClock();
    renderNotify();
    tickGhost();
    setInterval(tickGhost, 1000);
    load();
    setInterval(() => { if (!document.hidden) load(); }, 5000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });

    // Put the clock on the visualiser (floating) and the chips under it.
    function mount(root) {
      vizRoot = root;
      root.after(chips);
      placeClock();
    }

    return { ghost, chips, panel, appearance, fillActions, mount };
  }

  window.Clock = { create };
})();
