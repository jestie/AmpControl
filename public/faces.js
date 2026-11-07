/*
 * Digital faces: original front panels drawn in code (no photos), in three
 * switchable skins: Neon glass, Retro VU and Minimal pro. They work for any
 * device, including the virtual amp, and are part of the public project.
 *
 * One set of controls (power, inputs, display, volume dial, mute, meters);
 * each skin is a look (CSS in app.css, `.dface.skin-*`). Meters follow the
 * visualiser's levels: the real music when it is analysing, otherwise the
 * amp's state.
 */
(() => {
  'use strict';

  const SKINS = [
    { id: 'neon', label: 'Neon glass' },
    { id: 'retro', label: 'Retro VU' },
    { id: 'minimal', label: 'Minimal pro' }
  ];
  const SVG = 'http://www.w3.org/2000/svg';
  const SWEEP = 270;             // dial travel in degrees
  const START = -135;
  const DRAG_PX = 5;

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of [].concat(children)) if (child) node.append(child);
    return node;
  }
  function svg(tag, attrs = {}, children = []) {
    const node = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    for (const child of children) node.append(child);
    return node;
  }
  function polar(cx, cy, r, deg) {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  }
  function arcPath(cx, cy, r, from, to) {
    const [x1, y1] = polar(cx, cy, r, from);
    const [x2, y2] = polar(cx, cy, r, to);
    return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
  }

  let gradientSeq = 0;

  function vuMeter(label) {
    // A classic VU scale: -20 .. +3, red zone above 0.
    const marks = [];
    const scale = [['-20', -50], ['-10', -30], ['-7', -20], ['-5', -10], ['-3', 0], ['0', 18], ['+3', 50]];
    for (const [text, deg] of scale) {
      const [x1, y1] = polar(100, 118, 82, deg);
      const [x2, y2] = polar(100, 118, 92, deg);
      const [tx, ty] = polar(100, 118, 103, deg);
      marks.push(svg('line', { x1, y1, x2, y2, class: deg > 18 ? 'vu-tick red' : 'vu-tick' }));
      const t = svg('text', { x: tx, y: ty, class: deg >= 18 ? 'vu-num red' : 'vu-num', 'text-anchor': 'middle' });
      t.textContent = text;
      marks.push(t);
    }
    const needle = svg('line', { x1: 100, y1: 118, x2: 100, y2: 30, class: 'vu-needle' });
    const caption = svg('text', { x: 100, y: 96, class: 'vu-label', 'text-anchor': 'middle' });
    caption.textContent = `VU ${label}`;
    const node = svg('svg', { viewBox: '0 0 200 125', class: 'vu' }, [
      svg('path', { d: arcPath(100, 118, 87, -50, 18), class: 'vu-arc' }),
      svg('path', { d: arcPath(100, 118, 87, 18, 50), class: 'vu-arc red' }),
      ...marks, caption, needle,
      svg('circle', { cx: 100, cy: 118, r: 7, class: 'vu-hub' })
    ]);
    return { node, needle };
  }

  function create({ device, post, refresh, toast, levels }) {
    const cap = Number(device.volumeCap) || 40;
    const gid = `dfgrad${(gradientSeq += 1)}`;

    // ---- skeleton ----
    const brand = el('div', { class: 'df-brand' }, [el('span', { text: 'SOUNDCONTROL' }), el('b', { text: ' ONE' })]);
    const power = el('button', { type: 'button', class: 'df-power', 'aria-label': 'Power', title: 'Power' }, [el('span', { class: 'df-led' })]);
    const powerLabel = el('div', { class: 'df-caption df-power-cap', text: 'POWER' });
    const inputs = el('div', { class: 'df-inputs', role: 'group', 'aria-label': 'Input' });
    const title = el('div', { class: 'df-title', text: '' });
    const sub = el('div', { class: 'df-sub', text: '' });
    const spectrum = el('canvas', { class: 'df-spectrum', 'aria-hidden': 'true' });
    const display = el('div', { class: 'df-display', role: 'button', tabindex: '0', title: 'Tap to change the equaliser look', 'aria-label': 'Equaliser display: tap to change the look' }, [spectrum, title, sub]);
    const left = vuMeter('L');
    const right = vuMeter('R');
    const meters = el('div', { class: 'df-meters', 'aria-hidden': 'true' }, [left.node, right.node]);
    const mute = el('button', { type: 'button', class: 'df-mute', 'aria-label': 'Mute', title: 'Mute', text: 'MUTE' });

    // Volume dial: track, value arc (gradient), ticks, a knob cap with a pointer.
    const stops = svg('linearGradient', { id: gid, x1: '0', y1: '0', x2: '1', y2: '1' });
    const ticks = [];
    for (let i = 0; i <= 30; i += 1) {
      const deg = START + (SWEEP * i) / 30;
      const [x1, y1] = polar(60, 60, i % 5 === 0 ? 47 : 49, deg);
      const [x2, y2] = polar(60, 60, 53, deg);
      ticks.push(svg('line', { x1, y1, x2, y2, class: i % 5 === 0 ? 'df-tick major' : 'df-tick' }));
    }
    const capArc = svg('path', { class: 'df-cap-arc', d: arcPath(60, 60, 42, START + (SWEEP * cap) / 100, START + SWEEP) });
    const valueArc = svg('path', { class: 'df-arc', stroke: `url(#${gid})` });
    const dialSvg = svg('svg', { viewBox: '0 0 120 120', class: 'df-dial-svg' }, [
      svg('defs', {}, [stops]),
      ...ticks,
      svg('path', { class: 'df-track', d: arcPath(60, 60, 42, START, START + SWEEP) }),
      capArc,
      valueArc
    ]);
    const volNum = el('span', { class: 'df-vol', text: '–' });
    const knob = el('div', { class: 'df-knob' }, [el('span', { class: 'df-pointer' }), volNum]);
    const dial = el('div', { class: 'df-dial', role: 'slider', tabindex: '0', 'aria-label': 'Volume', 'aria-valuemin': '0', 'aria-valuemax': String(cap) }, [dialSvg, knob]);
    const dialLabel = el('div', { class: 'df-caption df-dial-cap', text: 'VOLUME' });

    const root = el('div', { class: 'dface skin-neon' }, [brand, power, powerLabel, inputs, display, meters, dial, dialLabel, mute]);

    function setGradient(colors) {
      stops.replaceChildren(...colors.map((c, i) => svg('stop', { offset: `${(i / Math.max(1, colors.length - 1)) * 100}%`, 'stop-color': c })));
    }
    setGradient(['#22d3ee', '#4f7cff', '#b26bff']);
    let paletteStops = ['#22d3ee', '#4f7cff', '#b26bff'];
    window.addEventListener('sc:palette', (e) => { if (e.detail && e.detail.stops) { setGradient(e.detail.stops); paletteStops = e.detail.stops; } });

    // ---- equaliser looks in the display: tap to cycle ----
    const EQ_KEY = 'soundcontrol.eq.look';
    const modes = window.EqViz ? window.EqViz.MODES : [];
    const renderer = window.EqViz ? window.EqViz.createRenderer() : null;
    let modeIndex = 0;
    try { modeIndex = Math.max(0, modes.findIndex((m) => m.id === localStorage.getItem(EQ_KEY))); } catch (e) { modeIndex = 0; }
    function nextLook() {
      if (!modes.length) return;
      modeIndex = (modeIndex + 1) % modes.length;
      try { localStorage.setItem(EQ_KEY, modes[modeIndex].id); } catch (e) { /* fine */ }
      show(`${modeIndex + 1}/${modes.length}  ${modes[modeIndex].name}`);
    }
    display.addEventListener('click', nextLook);
    display.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); nextLook(); } });
    function lookColors() {
      if (root.classList.contains('skin-retro')) return ['#ffb547'];
      if (root.classList.contains('skin-minimal')) return [getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#3d8bfd'];
      return paletteStops;
    }

    // ---- state ----
    let data = null;
    let volume = 0;
    let holdUntil = 0;
    let flash = '';
    let flashUntil = 0;
    const isOn = () => Boolean(data && data.power === 'on');

    function render() {
      const deg = START + (SWEEP * volume) / 100;
      valueArc.setAttribute('d', volume > 0 ? arcPath(60, 60, 42, START, deg) : '');
      knob.style.setProperty('--angle', `${deg}deg`);
      volNum.textContent = data ? String(volume) : '–';
      dial.setAttribute('aria-valuenow', String(volume));
      root.classList.toggle('on', isOn());
      root.classList.toggle('muted', Boolean(data && data.mute));
      mute.setAttribute('aria-pressed', String(Boolean(data && data.mute)));
      power.setAttribute('aria-pressed', String(isOn()));

      const list = (data && data.inputs) || [];
      const key = list.map((i) => i.id).join('|');
      if (inputs.dataset.key !== key) {
        inputs.dataset.key = key;
        inputs.replaceChildren(...list.map((i) => {
          const b = el('button', { type: 'button', class: 'df-input', text: i.label.replace(/\s*\(.*\)$/, ''), 'data-id': i.id });
          b.addEventListener('click', () => choose(i));
          return b;
        }));
      }
      inputs.querySelectorAll('.df-input').forEach((b) => b.classList.toggle('active', Boolean(data && String(data.input).toUpperCase() === String(b.dataset.id).toUpperCase())));

      if (!data) { title.textContent = 'Connecting…'; sub.textContent = ''; return; }
      if (!isOn()) { title.textContent = data.power === 'standby' ? 'Standby' : 'Offline'; sub.textContent = 'Press power'; return; }
      if (Date.now() < flashUntil) { title.textContent = flash; sub.textContent = ''; return; }
      const np = data.nowPlaying || {};
      const input = list.find((i) => String(i.id).toUpperCase() === String(data.input).toUpperCase());
      const playing = (data.playState === 'play' || np.type === 'webradio') && (np.song || np.station);
      title.textContent = playing ? (np.song || np.station) : (input ? input.label : String(data.input || ''));
      sub.textContent = [playing ? (np.artist || (np.station !== np.song ? np.station : '')) : '', `VOL ${volume}`, data.mute ? 'MUTE' : ''].filter(Boolean).join('  ·  ');
    }

    function show(text) { flash = text; flashUntil = Date.now() + 1400; render(); setTimeout(render, 1450); }

    // ---- actions ----
    let lastSent = null;
    let sendTimer = null;
    let lastAt = 0;
    function send(final) {
      clearTimeout(sendTimer);
      const due = lastAt + 220 - Date.now();
      if (!final && due > 0) { sendTimer = setTimeout(() => send(false), due); return; }
      if (volume === lastSent) { if (final) refresh(); return; }
      lastSent = volume;
      lastAt = Date.now();
      post('volume', { level: volume }).then(() => { if (final) refresh(); }).catch((e) => toast(e.message));
    }
    function setVolume(v, final = false) {
      if (!isOn()) { show('Standby'); return; }
      const next = Math.max(0, Math.min(cap, Math.round(v)));
      if (Math.round(v) > cap) show(`MAX ${cap}`);
      if (next === volume && !final) return;
      volume = next;
      holdUntil = Date.now() + 2500;
      render();
      send(final);
    }

    let drag = null;
    dial.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      dial.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, start: volume, moved: false };
      dial.classList.add('grabbing');
    });
    dial.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const d = (e.clientX - drag.x) - (e.clientY - drag.y);
      if (Math.abs(d) > 3) drag.moved = true;
      if (drag.moved) setVolume(drag.start + d / DRAG_PX);
    });
    const end = (e) => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      dial.classList.remove('grabbing');
      if (moved) { send(true); return; }
      const box = dial.getBoundingClientRect();
      setVolume(volume + (e.clientX < box.left + box.width / 2 ? -1 : 1), true);
    };
    dial.addEventListener('pointerup', end);
    dial.addEventListener('pointercancel', () => { drag = null; dial.classList.remove('grabbing'); send(true); });
    let wheelTimer = null;
    dial.addEventListener('wheel', (e) => {
      e.preventDefault();
      setVolume(volume + (e.deltaY < 0 ? 1 : -1));
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => send(true), 400);
    }, { passive: false });
    dial.addEventListener('keydown', (e) => {
      const step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 5, PageDown: -5 }[e.key];
      if (step === undefined) return;
      e.preventDefault();
      setVolume(volume + step, true);
    });

    power.addEventListener('click', async () => {
      const target = isOn() ? 'off' : 'on';
      power.disabled = true;
      show(target === 'on' ? 'Hello' : 'Goodbye');
      try { await post('power', { state: target }); } catch (e) { toast(e.message); } finally { power.disabled = false; }
      refresh();
      setTimeout(refresh, 2500);
    });
    mute.addEventListener('click', async () => {
      try { await post('mute', { state: data && data.mute ? 'off' : 'on' }); } catch (e) { toast(e.message); }
      refresh();
    });
    async function choose(input) {
      if (!isOn()) { toast('Press power first.'); return; }
      data.input = input.id;
      show(input.label);
      try { await post('input', { input: input.id }); } catch (e) { toast(e.message); }
      refresh();
    }

    // ---- meters: spectrum bars (Neon, Minimal) and VU needles (Retro) ----
    const sctx = spectrum.getContext('2d');
    let needleL = 0;
    let needleR = 0;
    function frame() {
      requestAnimationFrame(frame);
      if (root.hidden || document.hidden || !root.isConnected) return;
      const lv = levels ? levels() : { energy: 0, bands: [0, 0, 0, 0], spectrum: null };
      const on = isOn();
      // VU: left leans on bass, right on treble; damped like a real needle.
      const targetL = on ? Math.min(1, (lv.bands[0] * 0.6 + lv.bands[1] * 0.4)) : 0;
      const targetR = on ? Math.min(1, (lv.bands[2] * 0.5 + lv.bands[3] * 0.5)) : 0;
      needleL += (targetL - needleL) * 0.18;
      needleR += (targetR - needleR) * 0.18;
      left.needle.setAttribute('transform', `rotate(${-50 + needleL * 100} 100 118)`);
      right.needle.setAttribute('transform', `rotate(${-50 + needleR * 100} 100 118)`);

      const w = spectrum.clientWidth;
      const h = spectrum.clientHeight;
      if (!w || !h) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (spectrum.width !== Math.round(w * dpr)) { spectrum.width = Math.round(w * dpr); spectrum.height = Math.round(h * dpr); }
      sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sctx.clearRect(0, 0, w, h);
      if (!on || !renderer) return;
      renderer.draw(modes[modeIndex].id, sctx, w, h, lv, lookColors(), performance.now() / 1000);
    }
    requestAnimationFrame(frame);

    function update(next) {
      const touched = Date.now() < holdUntil;
      data = next;
      if (!touched && next.volume !== null && Number.isFinite(Number(next.volume))) {
        volume = Math.round(Number(next.volume));
        lastSent = volume;
      }
      render();
    }
    function setSkin(id) {
      const skin = SKINS.some((s) => s.id === id) ? id : 'neon';
      root.className = root.className.replace(/skin-\w+/, `skin-${skin}`);
    }
    render();
    return { root, update, setSkin };
  }

  window.Faces = { create, SKINS };
})();
