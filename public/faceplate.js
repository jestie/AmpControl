/*
 * Interactive front panel: the amp's own photo with live controls laid over
 * the real knobs and buttons. Turn the volume knob, click through inputs with
 * the input knob, press power, Source Direct and the Enter pad, and read the
 * state on the display.
 *
 * Coordinates are pixels in the cropped photo (public/img/pm7000n-face.png,
 * 1140 x 384) and are turned into percentages, so the panel scales to any width.
 */
(() => {
  'use strict';

  const MODELS = {
    pm7000n: {
      image: '/img/pm7000n-face.png',
      width: 1140,
      height: 384,
      inputKnob: { x: 240, y: 172, r: 68 },
      volumeKnob: { x: 900, y: 173, r: 68 },
      enter: { x: 748, y: 170, r: 34 },
      power: { x: 182, y: 300, r: 24 },
      sourceDirect: { x: 391, y: 257, r: 14 },
      display: { x: 432, y: 130, w: 280, h: 76 },
      // Front-panel only: the network protocol did not answer for these.
      manual: [
        { x: 450, y: 302, r: 30, name: 'Bass' },
        { x: 570, y: 302, r: 30, name: 'Treble' },
        { x: 687, y: 302, r: 30, name: 'Balance' },
        { x: 748, y: 255, r: 12, name: 'Back' }
      ]
    }
  };

  // Volume knob sweep: 300 degrees from 0 to 100, like the real dial.
  const SWEEP_START = -150;
  const SWEEP = 300;
  const DRAG_PX_PER_STEP = 5;
  const SEND_EVERY_MS = 220;
  const HOLD_AFTER_TOUCH_MS = 2500;

  function el(tag, cls, attrs = {}) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  }

  function create({ device, post, refresh, toast, getData }) {
    const model = MODELS[device.faceplate];
    if (!model) return null;
    const W = model.width;
    const H = model.height;
    const cap = Number(device.volumeCap) || 40;

    const pct = (value, total) => `${(value / total) * 100}%`;
    function placeCircle(node, spot) {
      node.style.left = pct(spot.x - spot.r, W);
      node.style.top = pct(spot.y - spot.r, H);
      node.style.width = pct(spot.r * 2, W);
      node.style.height = pct(spot.r * 2, H);
    }

    const root = el('div', 'faceplate');
    root.style.aspectRatio = `${W} / ${H}`;
    const photo = el('img', 'fp-photo', { src: model.image, alt: 'Marantz PM7000N front panel', draggable: 'false' });
    root.append(photo);

    // A knob is a round window onto the same photo; rotating the window turns
    // the knob's own brushed-metal image, plus an indicator dot.
    function knob(spot, label) {
      const node = el('div', 'fp-knob', { role: 'slider', tabindex: '0', 'aria-label': label });
      placeCircle(node, spot);
      const face = el('div', 'fp-knob-face');
      const img = el('img', '', { src: model.image, alt: '', draggable: 'false' });
      img.style.width = pct(W, spot.r * 2);
      img.style.left = `-${pct(spot.x - spot.r, spot.r * 2)}`;
      img.style.top = `-${pct(spot.y - spot.r, spot.r * 2)}`;
      face.append(img, el('span', 'fp-knob-dot'));
      node.append(face);
      root.append(node);
      return { node, face };
    }

    const inputKnob = knob(model.inputKnob, 'Input selector');
    const volumeKnob = knob(model.volumeKnob, 'Volume');
    volumeKnob.node.setAttribute('aria-valuemin', '0');
    volumeKnob.node.setAttribute('aria-valuemax', String(cap));

    const display = el('div', 'fp-display');
    display.style.left = pct(model.display.x, W);
    display.style.top = pct(model.display.y, H);
    display.style.width = pct(model.display.w, W);
    display.style.height = pct(model.display.h, H);
    const line1 = el('div', 'fp-line small');
    const line2 = el('div', 'fp-line big');
    const line3 = el('div', 'fp-line small');
    display.append(line1, line2, line3);
    root.append(display);

    function button(spot, cls, label) {
      const node = el('button', `fp-btn ${cls}`, { type: 'button', 'aria-label': label, title: label });
      placeCircle(node, spot);
      root.append(node);
      return node;
    }
    const powerBtn = button(model.power, 'fp-power', 'Power');
    const sdBtn = button(model.sourceDirect, 'fp-sd', 'Source Direct');
    const enterBtn = button(model.enter, 'fp-enter', 'Play/pause (left: previous, right: next)');
    for (const spot of model.manual) {
      const node = button(spot, 'fp-manual', `${spot.name}: set on the amp itself`);
      node.addEventListener('click', () => {
        toast(`${spot.name} is front-panel only here: the amp does not answer it over the network.`);
      });
    }

    // ---- state ----
    let data = null;
    let volume = 0;
    let holdUntil = 0;           // ignore polled volume while the user is turning
    let flashText = '';
    let flashUntil = 0;
    let flashTimer = null;

    const isOn = () => Boolean(data && data.power === 'on');
    const caps = () => (data && data.capabilities) || {};

    function flash(text) {
      flashText = text;
      flashUntil = Date.now() + 1600;
      clearTimeout(flashTimer);
      flashTimer = setTimeout(render, 1650);
      render();
    }

    function inputList() { return (data && data.inputs) || []; }
    function inputIndex() {
      const list = inputList();
      const current = data && data.input ? String(data.input).toUpperCase() : '';
      return list.findIndex((entry) => String(entry.id).toUpperCase() === current);
    }
    function inputLabel() {
      const index = inputIndex();
      if (index >= 0) return inputList()[index].label;
      return data && data.input ? String(data.input).toUpperCase() : '—';
    }

    function render() {
      volumeKnob.face.style.transform = `rotate(${SWEEP_START + (SWEEP * volume) / 100}deg)`;
      volumeKnob.node.setAttribute('aria-valuenow', String(volume));
      const index = Math.max(0, inputIndex());
      inputKnob.face.style.transform = `rotate(${index * 40 - 20}deg)`;

      root.classList.toggle('on', isOn());
      root.classList.toggle('sd-off', Boolean(data) && data.sourceDirect === false);
      powerBtn.setAttribute('aria-pressed', String(isOn()));
      sdBtn.hidden = !caps().sourceDirect;
      enterBtn.hidden = !caps().transport;

      if (!data) {
        line1.textContent = '';
        line2.textContent = 'Connecting…';
        line3.textContent = '';
        return;
      }
      if (!isOn()) {
        line1.textContent = '';
        line2.textContent = data.power === 'standby' ? 'Standby' : 'Offline';
        line3.textContent = '';
        return;
      }
      if (Date.now() < flashUntil) {
        line1.textContent = '';
        line2.textContent = flashText;
        line3.textContent = '';
        return;
      }
      const np = data.nowPlaying || {};
      const playing = data.playState === 'play' && (np.song || np.station);
      line1.textContent = playing ? (np.artist || (np.station !== np.song ? np.station : '') || inputLabel()) : 'INPUT';
      line2.textContent = playing ? np.song || np.station : inputLabel();
      const bits = [`VOL ${volume}`];
      if (data.mute) bits.push('MUTE');
      if (data.sourceDirect) bits.push('SOURCE DIRECT');
      line3.textContent = bits.join('   ');
    }

    // ---- volume ----
    let lastSent = null;
    let sendTimer = null;
    let lastSendAt = 0;

    function sendVolume(final) {
      clearTimeout(sendTimer);
      const now = Date.now();
      const due = lastSendAt + SEND_EVERY_MS - now;
      if (!final && due > 0) {
        sendTimer = setTimeout(() => sendVolume(false), due);
        return;
      }
      if (volume === lastSent) {
        if (final) refresh();
        return;
      }
      lastSent = volume;
      lastSendAt = now;
      const level = volume;
      post('volume', { level })
        .then(() => { if (final) refresh(); })
        .catch((e) => toast(e.message));
    }

    function setVolume(next, final = false) {
      if (!isOn()) {
        flash('Standby');
        toast('The amp is in standby: press the power button first.');
        return;
      }
      const wanted = Math.round(next);
      const clamped = Math.max(0, Math.min(cap, wanted));
      if (wanted > cap && volume === cap) flash(`MAX ${cap}`);
      if (clamped === volume && !final) return;
      volume = clamped;
      holdUntil = Date.now() + HOLD_AFTER_TOUCH_MS;
      flash(clamped >= cap ? `VOL ${clamped}  (MAX)` : `VOL ${clamped}`);
      sendVolume(final);
    }

    // Drag: right or up turns it up. The knob is small on a phone, so linear
    // drags beat having to trace a circle.
    let drag = null;
    volumeKnob.node.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      volumeKnob.node.setPointerCapture(event.pointerId);
      drag = { x: event.clientX, y: event.clientY, start: volume, moved: false };
      volumeKnob.node.classList.add('grabbing');
    });
    volumeKnob.node.addEventListener('pointermove', (event) => {
      if (!drag) return;
      const delta = (event.clientX - drag.x) - (event.clientY - drag.y);
      if (Math.abs(delta) > 3) drag.moved = true;
      if (drag.moved) setVolume(drag.start + delta / DRAG_PX_PER_STEP);
    });
    function endDrag(event) {
      if (!drag) return;
      const wasDrag = drag.moved;
      drag = null;
      volumeKnob.node.classList.remove('grabbing');
      if (wasDrag) {
        sendVolume(true);
        return;
      }
      // A tap: left half down one, right half up one.
      const box = volumeKnob.node.getBoundingClientRect();
      setVolume(volume + (event.clientX < box.left + box.width / 2 ? -1 : 1), true);
    }
    volumeKnob.node.addEventListener('pointerup', endDrag);
    volumeKnob.node.addEventListener('pointercancel', () => {
      drag = null;
      volumeKnob.node.classList.remove('grabbing');
      sendVolume(true);
    });

    let wheelTimer = null;
    volumeKnob.node.addEventListener('wheel', (event) => {
      event.preventDefault();
      setVolume(volume + (event.deltaY < 0 ? 1 : -1));
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => sendVolume(true), 400);
    }, { passive: false });

    volumeKnob.node.addEventListener('keydown', (event) => {
      const step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 5, PageDown: -5 }[event.key];
      if (step === undefined) return;
      event.preventDefault();
      setVolume(volume + step, true);
    });

    // ---- input knob: tap for the next input, drag left/right to step ----
    async function stepInput(direction) {
      if (!isOn()) {
        toast('The amp is in standby: press the power button first.');
        return;
      }
      const list = inputList();
      if (list.length === 0) return;
      const index = inputIndex();
      const next = list[((index < 0 ? 0 : index) + direction + list.length) % list.length];
      data.input = next.id;          // turn the knob now; the poll confirms it
      flash(next.label);
      try {
        await post('input', { input: next.id });
      } catch (e) {
        toast(e.message);
      }
      refresh();
    }

    let inputDrag = null;
    inputKnob.node.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      inputKnob.node.setPointerCapture(event.pointerId);
      inputDrag = { x: event.clientX, y: event.clientY };
    });
    inputKnob.node.addEventListener('pointerup', (event) => {
      if (!inputDrag) return;
      const delta = (event.clientX - inputDrag.x) - (event.clientY - inputDrag.y);
      inputDrag = null;
      stepInput(delta < -15 ? -1 : 1);
    });
    inputKnob.node.addEventListener('pointercancel', () => { inputDrag = null; });
    inputKnob.node.addEventListener('keydown', (event) => {
      if (['ArrowRight', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); stepInput(1); }
      if (['ArrowLeft', 'ArrowDown'].includes(event.key)) { event.preventDefault(); stepInput(-1); }
    });

    // ---- buttons ----
    powerBtn.addEventListener('click', async () => {
      const target = isOn() ? 'off' : 'on';
      powerBtn.disabled = true;
      flash(target === 'on' ? 'Power on…' : 'Standby…');
      try {
        await post('power', { state: target });
      } catch (e) {
        toast(e.message);
      } finally {
        powerBtn.disabled = false;
      }
      // The amp takes a moment to wake; poll a little sooner than usual.
      refresh();
      setTimeout(refresh, 2500);
    });

    sdBtn.addEventListener('click', async () => {
      if (!isOn()) {
        toast('The amp is in standby: press the power button first.');
        return;
      }
      const target = data.sourceDirect ? 'off' : 'on';
      try {
        await post('sourcedirect', { state: target });
        flash(`Source Direct ${target.toUpperCase()}`);
      } catch (e) {
        toast(e.message);
      }
      refresh();
    });

    enterBtn.addEventListener('click', async (event) => {
      const box = enterBtn.getBoundingClientRect();
      const dx = (event.clientX - (box.left + box.width / 2)) / (box.width / 2);
      try {
        if (event.detail !== 0 && dx < -0.45) {
          await post('transport', { action: 'previous' });
          flash('◀◀');
        } else if (event.detail !== 0 && dx > 0.45) {
          await post('transport', { action: 'next' });
          flash('▶▶');
        } else {
          const target = data && data.playState === 'play' ? 'pause' : 'play';
          await post('play', { state: target });
          flash(target === 'play' ? '▶' : '❚❚');
        }
      } catch (e) {
        toast(e.message);
      }
      refresh();
    });

    function update(next) {
      const wasTouched = Date.now() < holdUntil;
      data = next;
      if (!wasTouched && Number.isFinite(Number(next.volume)) && next.volume !== null) {
        volume = Math.round(Number(next.volume));
        lastSent = volume;
      }
      render();
    }

    render();
    return { root, update, current: () => getData() };
  }

  window.Faceplate = { create };
})();
