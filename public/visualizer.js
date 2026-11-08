/*
 * Sound visualiser under the amp: layered glowing wave meshes.
 *
 * Two modes:
 *  - Display (default): the app never receives the audio (the amp plays it), so
 *    the waves follow what the amp reports: they dance while something plays,
 *    grow with the volume, breathe when paused and lie flat in standby.
 *  - Live (🎤): the browser listens to the room through the microphone and the
 *    waves react to the real sound: bass, low-mid, mid and treble each drive one
 *    wave, and the bars are the real spectrum. Analysed in the browser only;
 *    nothing is recorded or sent anywhere.
 * Tap the waves to change the colours.
 */
(() => {
  'use strict';

  const PALETTES = [
    { name: 'Rainbow', stops: ['#ff3d7f', '#ff9f43', '#ffd60a', '#3ccf7a', '#22d3ee', '#4f7cff', '#b26bff'] },
    { name: 'Aurora', stops: ['#00bf63', '#00a16f', '#00837b', '#22d3ee', '#4f7cff', '#b26bff'] },
    { name: 'M²-Squared', stops: ['#00339a', '#004792', '#006f82', '#00837b', '#00a16f', '#00bf63'] },
    { name: 'Sunset', stops: ['#ff4d6d', '#ff7b7b', '#ff9f43', '#ffd60a', '#ff9f43', '#c7a6ff'] },
    { name: 'Ice', stops: ['#e0f2ff', '#7dd3fc', '#38bdf8', '#5eead4', '#a5b4fc', '#e0f2ff'] }
  ];
  const STORE_KEY = 'soundcontrol.visualizer.palette';
  const LAYERS = 4;          // separate waves stacked on top of each other
  const STRANDS = 7;         // lines per wave: together they look like a mesh

  function loadPalette() {
    try {
      const index = Number(localStorage.getItem(STORE_KEY));
      return Number.isInteger(index) && index >= 0 && index < PALETTES.length ? index : 0;
    } catch (e) {
      return 0;
    }
  }
  function savePalette(index) {
    try { localStorage.setItem(STORE_KEY, String(index)); } catch (e) { /* private mode: fine */ }
  }

  function create() {
    const root = document.createElement('div');
    root.className = 'visualizer';
    root.setAttribute('role', 'button');
    root.setAttribute('tabindex', '0');
    const canvas = document.createElement('canvas');
    const label = document.createElement('span');
    label.className = 'viz-label';
    const micBtn = document.createElement('button');
    micBtn.type = 'button';
    micBtn.className = 'viz-mic';
    micBtn.textContent = '🎤';
    micBtn.title = 'Listen to the room: react to the real sound';
    micBtn.setAttribute('aria-pressed', 'false');
    root.append(canvas, label, micBtn);
    const ctx = canvas.getContext('2d');

    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let paletteIndex = loadPalette();
    let target = 0.08;       // energy the amp state asks for
    let energy = 0.08;       // smoothed energy actually drawn
    let width = 0;
    let height = 0;
    let running = false;
    let visible = true;
    let labelTimer = null;
    // ---- live microphone analysis ----
    // Bands in Hz for the four waves: bass, low-mid, mid, treble.
    const BANDS = [[30, 160], [160, 600], [600, 2500], [2500, 9000]];
    let live = null;            // { ctx, analyser, stream, bins }
    const bandLevel = new Array(LAYERS).fill(0);
    const bandPeak = new Array(LAYERS).fill(0.02);
    let spectrum = null;

    function showMessage(text) {
      label.textContent = text;
      label.classList.add('show');
      clearTimeout(labelTimer);
      labelTimer = setTimeout(() => label.classList.remove('show'), 4000);
    }

    async function startLive() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showMessage(window.isSecureContext ? 'No microphone in this browser' : 'The microphone needs HTTPS (or localhost on this PC)');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        });
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        const actx = new AudioCtx();
        const analyser = actx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.72;
        actx.createMediaStreamSource(stream).connect(analyser);   // never to the speakers
        live = { ctx: actx, analyser, stream, bins: new Uint8Array(analyser.frequencyBinCount) };
        micBtn.classList.add('active');
        micBtn.setAttribute('aria-pressed', 'true');
        root.classList.add('live');
        showMessage('Listening: reacting to the real sound');
        start();
      } catch (e) {
        showMessage(e && e.name === 'NotAllowedError' ? 'Microphone permission was refused' : 'Could not open the microphone');
      }
    }

    function stopLive() {
      if (!live) return;
      if (live.external) { live = null; spectrum = null; root.classList.remove('live'); return; }
      live.stream.getTracks().forEach((track) => track.stop());
      live.ctx.close().catch(() => {});
      live = null;
      spectrum = null;
      micBtn.classList.remove('active');
      micBtn.setAttribute('aria-pressed', 'false');
      root.classList.remove('live');
      showMessage('Display mode');
    }

    micBtn.addEventListener('click', (event) => {
      event.stopPropagation();          // do not change the colours
      if (live && !live.external) stopLive(); else startLive();
    });

    // Browser radio hands over its own analyser: the waves follow the real music.
    let external = null;
    function useAnalyser(analyser, sampleRate) {
      if (live && !live.external) stopLive();
      external = analyser ? { ctx: { sampleRate }, analyser, bins: new Uint8Array(analyser.frequencyBinCount), external: true } : null;
      live = external;
      spectrum = null;
      root.classList.toggle('live', Boolean(external));
      start();
    }

    // Levels for the faces' meters: real when analysing, otherwise from the amp's state.
    function levels() {
      if (live) return { live: true, energy, bands: bandLevel.slice(), spectrum, wave: live.wave || null };
      const t = performance.now() / 1000;
      const wobble = (k) => Math.max(0, Math.min(1, energy * (0.75 + 0.25 * Math.sin(t * (2.1 + k) + k * 1.7))));
      return { live: false, energy, bands: [wobble(0), wobble(1), wobble(2), wobble(3)], spectrum: null, wave: null };
    }

    function readLive() {
      const { analyser, bins, ctx: actx } = live;
      analyser.getByteFrequencyData(bins);
      // The waveform too (for the oscilloscope look in the faces).
      if (!live.wave || live.wave.length !== analyser.fftSize) live.wave = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(live.wave);   // -1..1, full resolution
      const hzPerBin = actx.sampleRate / analyser.fftSize;
      for (let i = 0; i < LAYERS; i += 1) {
        const [lo, hi] = BANDS[i];
        const a = Math.max(1, Math.floor(lo / hzPerBin));
        const b = Math.min(bins.length - 1, Math.ceil(hi / hzPerBin));
        let sum = 0;
        for (let k = a; k <= b; k += 1) sum += bins[k];
        const level = sum / ((b - a + 1) * 255);
        // Auto-gain per band: compare against a slowly decaying peak, so quiet
        // rooms and loud rooms both fill the canvas.
        bandPeak[i] = Math.max(level, bandPeak[i] * 0.99, 0.02);
        const norm = Math.min(1, level / bandPeak[i]);
        // Fast attack, slower release: punchy on the beat.
        bandLevel[i] += (norm - bandLevel[i]) * (norm > bandLevel[i] ? 0.84 : 0.23);
      }
      // Log-spaced spectrum for the bars (40 Hz .. 12 kHz).
      const bars = Math.round(width / 6);
      if (!spectrum || spectrum.length !== bars) spectrum = new Float32Array(bars);
      const fMin = 40;
      const fMax = 12000;
      for (let i = 0; i < bars; i += 1) {
        const f0 = fMin * (fMax / fMin) ** (i / bars);
        const f1 = fMin * (fMax / fMin) ** ((i + 1) / bars);
        const a = Math.max(1, Math.floor(f0 / hzPerBin));
        const b = Math.max(a, Math.min(bins.length - 1, Math.floor(f1 / hzPerBin)));
        let peak = 0;
        for (let k = a; k <= b; k += 1) peak = Math.max(peak, bins[k]);
        spectrum[i] += (peak / 255 - spectrum[i]) * 0.75;
      }
      const overall = bandLevel.reduce((x, y) => x + y, 0) / LAYERS;
      energy = 0.15 + overall * 0.85;
    }

    const seeds = Array.from({ length: LAYERS }, (_, i) => ({
      speed: 0.35 + i * 0.13,
      freq: 1.4 + i * 0.55,
      phase: i * 1.7,
      offset: (i - (LAYERS - 1) / 2) * 0.09
    }));

    function setLabel() {
      label.textContent = PALETTES[paletteIndex].name;
      root.setAttribute('aria-label', `Sound visualiser, colours: ${PALETTES[paletteIndex].name}. Tap to change.`);
      label.classList.add('show');
      clearTimeout(labelTimer);
      labelTimer = setTimeout(() => label.classList.remove('show'), 1400);
    }
    // Let the rest of the app (ghost clock, accent colour) follow the palette.
    function emitPalette() {
      window.dispatchEvent(new CustomEvent('sc:palette', { detail: { ...PALETTES[paletteIndex] } }));
    }
    function nextPalette() {
      paletteIndex = (paletteIndex + 1) % PALETTES.length;
      savePalette(paletteIndex);
      setLabel();
      emitPalette();
      if (!running) draw(performance.now());
    }
    root.addEventListener('click', nextPalette);
    root.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); nextPalette(); }
    });

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const box = root.getBoundingClientRect();
      width = Math.max(1, Math.round(box.width));
      height = Math.max(1, Math.round(box.height));
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!running) draw(performance.now());
    }

    // The gradient only changes with the palette or the width: build it once, not per frame.
    let gradCache = null;
    let gradKey = '';
    function gradient() {
      const key = `${paletteIndex}:${width}`;
      if (gradCache && gradKey === key) return gradCache;
      const stops = PALETTES[paletteIndex].stops;
      const g = ctx.createLinearGradient(0, 0, width, 0);
      stops.forEach((color, i) => g.addColorStop(i / (stops.length - 1), color));
      gradCache = g;
      gradKey = key;
      return g;
    }

    // A wave is a sum of sines whose shape drifts with time, so it never repeats exactly.
    function waveY(x, t, seed, strand) {
      const u = x / width;
      const spread = (strand - (STRANDS - 1) / 2) * 0.018;
      const a = Math.sin(u * Math.PI * seed.freq + t * seed.speed + seed.phase + spread * 6);
      const b = Math.sin(u * Math.PI * seed.freq * 2.3 - t * seed.speed * 1.7 + seed.phase * 2);
      const c = Math.sin(u * Math.PI * seed.freq * 5.1 + t * seed.speed * 2.9) * energy;
      const envelope = Math.sin(u * Math.PI) ** 0.6;   // taper towards both ends
      const level = live ? 0.08 + bandLevel[seeds.indexOf(seed)] * 0.92 : energy;
      const amp = height * 0.42 * (0.12 + level * 0.88);
      return height / 2 + (seed.offset + spread) * height + (a * 0.55 + b * 0.3 + c * 0.35) * amp * envelope;
    }

    function draw(now) {
      const t = now / 1000;
      if (live) readLive();
      else energy += (target - energy) * 0.08;   // tuned for 30 fps
      ctx.clearRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'lighter';
      const stroke = gradient();
      ctx.strokeStyle = stroke;
      ctx.lineCap = 'round';
      const step = Math.max(3, width / 160);

      for (let layer = 0; layer < LAYERS; layer += 1) {
        const seed = seeds[layer];
        for (let strand = 0; strand < STRANDS; strand += 1) {
          ctx.globalAlpha = 0.16 + 0.5 * energy * (strand === Math.floor(STRANDS / 2) ? 1 : 0.45);
          ctx.lineWidth = strand === Math.floor(STRANDS / 2) ? 1.6 : 0.8;
          ctx.beginPath();
          for (let x = 0; x <= width; x += step) {
            const y = waveY(x, t, seed, strand);
            if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
      }

      // Live: the bars are the real spectrum of what the microphone hears.
      if (live && spectrum) {
        ctx.fillStyle = stroke;
        const bars = spectrum.length;
        for (let i = 0; i < bars; i += 1) {
          const x = (i + 0.5) * (width / bars);
          const h = spectrum[i] ** 1.4 * height * 0.9;
          ctx.globalAlpha = 0.22 + 0.4 * spectrum[i];
          ctx.fillRect(x, height / 2 - h / 2, 1.5, h);
        }
      } else if (energy > 0.15) {
        // Display mode: decorative spikes and sparkles.
        ctx.fillStyle = stroke;
        const bars = Math.round(width / 6);
        for (let i = 0; i < bars; i += 1) {
          const x = (i + 0.5) * (width / bars);
          const n = Math.sin(i * 12.9898 + Math.floor(t * 8) * 78.233) * 43758.5453;
          const r = n - Math.floor(n);
          const h = r * r * height * 0.45 * energy;
          ctx.globalAlpha = 0.18 * energy;
          ctx.fillRect(x, height / 2 - h / 2, 1, h);
          if (r > 0.93) {
            ctx.globalAlpha = 0.7 * energy;
            ctx.fillRect(x, height / 2 - h * 0.9, 1.5, 1.5);
          }
        }
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    // Frame budget: the waves drift slowly, so 30 fps looks the same as 60 at
    // half the cost; in standby (flat, dim waves) 10 fps is plenty.
    let lastDraw = 0;
    function frameGap() {
      if (!live && target === 0 && energy < 0.02) return 1000 / 10;
      return 1000 / 30;
    }
    function loop(now) {
      if (!running) return;
      requestAnimationFrame(loop);
      if (now - lastDraw < frameGap() - 4) return;
      lastDraw = now;
      draw(now);
    }
    function start() {
      if (running || (reduceMotion && !live) || !visible || document.hidden) return;
      running = true;
      requestAnimationFrame(loop);
    }
    function stop() { running = false; }

    // Only animate while on screen and the tab is visible.
    if ('IntersectionObserver' in window) {
      new IntersectionObserver((entries) => {
        visible = entries.some((entry) => entry.isIntersecting);
        if (visible) start(); else stop();
      }).observe(root);
    }
    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
    if ('ResizeObserver' in window) new ResizeObserver(resize).observe(root);
    else window.addEventListener('resize', resize);

    function update(data, cap) {
      if (!data || data.power !== 'on') target = 0;
      else if (data.playState === 'play' && !data.mute) {
        const level = Math.min(1, (Number(data.volume) || 0) / (Number(cap) || 40));
        target = 0.45 + 0.55 * level;
      } else target = 0.08;
      root.classList.toggle('idle', target === 0);
      if (reduceMotion) { energy = target; draw(performance.now()); }
      start();
    }

    requestAnimationFrame(() => { resize(); start(); emitPalette(); });
    return { root, update, useAnalyser, levels };
  }

  window.Visualizer = { create };
})();
