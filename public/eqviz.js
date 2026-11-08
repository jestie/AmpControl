/*
 * Equaliser looks for the display inside the digital faces. Tap the display to
 * cycle through them. Each look draws the same data (a spectrum of 0..1 values,
 * and a waveform when the real audio is analysed) in its own style, in the
 * colours it is given. All drawn on a canvas; no images.
 */
(() => {
  'use strict';

  const MODES = [
    { id: 'bars', name: 'Glow bars' },
    { id: 'faders', name: 'Faders' },
    { id: 'halo', name: 'Halo' },
    { id: 'terrain', name: 'Terrain' },
    { id: 'capsules', name: 'Capsules' },
    { id: 'scope', name: 'Scope' },
    { id: 'mirror', name: 'Mirror' },
    { id: 'led', name: 'LED' },
    { id: 'waterfall', name: 'Waterfall' },
    { id: 'silk', name: 'Silk' }
  ];

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return [125, 211, 252];
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function mix(colors, t) {
    if (colors.length === 1) return hexToRgb(colors[0]);
    const x = Math.max(0, Math.min(0.9999, t)) * (colors.length - 1);
    const i = Math.floor(x);
    const a = hexToRgb(colors[i]);
    const b = hexToRgb(colors[i + 1]);
    const f = x - i;
    return [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * f));
  }
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

  /** One renderer per face: keeps the history some looks need. */
  function createRenderer() {
    const state = { prev: null, peaks: null, history: [], waterfall: null, wfCtx: null };

    // Resample any spectrum to n values (max per slice), then smooth over time.
    function sample(levels, n, t) {
      const out = new Float32Array(n);
      const spec = levels && levels.spectrum;
      if (spec && spec.length) {
        for (let i = 0; i < n; i += 1) {
          const a = Math.floor((i / n) * spec.length);
          const b = Math.max(a + 1, Math.floor(((i + 1) / n) * spec.length));
          let m = 0;
          for (let k = a; k < b; k += 1) m = Math.max(m, spec[k] || 0);
          out[i] = m;
        }
      } else {
        // No real audio: a believable spectrum from the amp's energy.
        const e = levels ? levels.energy : 0;
        for (let i = 0; i < n; i += 1) {
          const u = i / n;
          const shape = 0.55 + 0.45 * Math.sin(u * 3.1 + 0.6);
          const flicker = 0.5 + 0.5 * Math.sin(t * (1.7 + u * 3.3) + i * 1.37) * Math.sin(t * 0.9 + i * 0.41);
          out[i] = Math.max(0, Math.min(1, e * shape * (0.45 + 0.55 * flicker)));
        }
      }
      if (!state.prev || state.prev.length !== n) state.prev = new Float32Array(n);
      for (let i = 0; i < n; i += 1) {
        const v = out[i];
        state.prev[i] += (v - state.prev[i]) * (v > state.prev[i] ? 0.8 : 0.33);   // fast up, slow down (tuned for 30 fps)
        out[i] = state.prev[i];
      }
      return out;
    }

    function peaksFor(values) {
      if (!state.peaks || state.peaks.length !== values.length) state.peaks = new Float32Array(values.length);
      for (let i = 0; i < values.length; i += 1) state.peaks[i] = Math.max(values[i], state.peaks[i] - 0.016);
      return state.peaks;
    }

    function roundRect(ctx, x, y, w, h, r) {
      const rr = Math.min(r, w / 2, h / 2);
      ctx.beginPath();
      ctx.moveTo(x + rr, y);
      ctx.arcTo(x + w, y, x + w, y + h, rr);
      ctx.arcTo(x + w, y + h, x, y + h, rr);
      ctx.arcTo(x, y + h, x, y, rr);
      ctx.arcTo(x, y, x + w, y, rr);
      ctx.closePath();
    }

    const looks = {
      bars(ctx, w, h, lv, colors, t) {
        const n = 28;
        const v = sample(lv, n, t);
        const base = h * 0.74;
        const gap = w / n;
        ctx.shadowBlur = 8;
        for (let i = 0; i < n; i += 1) {
          const c = mix(colors, i / (n - 1));
          const bh = Math.max(2, v[i] * base * 0.95);
          const x = i * gap + gap * 0.18;
          const g = ctx.createLinearGradient(0, base - bh, 0, base);
          g.addColorStop(0, rgba(c, 0.95));
          g.addColorStop(1, rgba(c, 0.35));
          ctx.shadowColor = rgba(c, 0.8);
          ctx.fillStyle = g;
          ctx.fillRect(x, base - bh, gap * 0.64, bh);
          // reflection
          ctx.shadowBlur = 0;
          const r = ctx.createLinearGradient(0, base, 0, base + bh * 0.35);
          r.addColorStop(0, rgba(c, 0.25));
          r.addColorStop(1, rgba(c, 0));
          ctx.fillStyle = r;
          ctx.fillRect(x, base + 2, gap * 0.64, bh * 0.35);
          ctx.shadowBlur = 8;
        }
        ctx.shadowBlur = 0;
      },

      faders(ctx, w, h, lv, colors, t) {
        const n = 10;
        const v = sample(lv, n, t);
        const top = h * 0.12;
        const bottom = h * 0.88;
        for (let i = 0; i < n; i += 1) {
          const c = mix(colors, i / (n - 1));
          const x = (i + 0.5) * (w / n);
          ctx.fillStyle = 'rgba(255,255,255,0.08)';
          roundRect(ctx, x - 2, top, 4, bottom - top, 2);
          ctx.fill();
          const y = bottom - v[i] * (bottom - top);
          ctx.shadowBlur = 10;
          ctx.shadowColor = rgba(c, 0.9);
          ctx.fillStyle = rgba(c, 0.9);
          roundRect(ctx, x - 2, y, 4, bottom - y, 2);
          ctx.fill();
          const g = ctx.createRadialGradient(x - 2, y - 2, 1, x, y, Math.min(9, w / n / 3));
          g.addColorStop(0, '#ffffff');
          g.addColorStop(1, rgba(c, 1));
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(x, y, Math.min(7, w / n / 3.4), 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
        }
      },

      halo(ctx, w, h, lv, colors, t) {
        const n = 56;
        const v = sample(lv, n, t);
        const cx = w / 2;
        const cy = h / 2;
        const r0 = h * 0.2;
        const r1 = h * 0.5;
        const sx = Math.min(2.6, (w / h) * 0.6);     // stretch into an oval on wide displays
        ctx.lineCap = 'round';
        for (let i = 0; i < n; i += 1) {
          const a = (i / n) * Math.PI * 2 - Math.PI / 2 + t * 0.15;
          const c = mix(colors, i / (n - 1));
          const len = (r1 - r0) * (0.12 + 0.88 * v[i]);
          ctx.strokeStyle = rgba(c, 0.45 + 0.55 * v[i]);
          ctx.lineWidth = Math.max(2, (Math.PI * 2 * r0) / n * 0.62);
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(a) * r0 * sx, cy + Math.sin(a) * r0);
          ctx.lineTo(cx + Math.cos(a) * (r0 + len) * sx, cy + Math.sin(a) * (r0 + len));
          ctx.stroke();
        }
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.beginPath();
        ctx.ellipse(cx, cy, r0 * sx * 0.9, r0 * 0.9, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.lineWidth = 1;
        ctx.stroke();
      },

      terrain(ctx, w, h, lv, colors, t) {
        const n = 40;
        const v = sample(lv, n, t);
        state.history.unshift(Float32Array.from(v));
        if (state.history.length > 22) state.history.length = 22;
        const rows = state.history.length;
        for (let r = rows - 1; r >= 0; r -= 1) {
          const depth = r / 22;
          const scale = 1 - depth * 0.55;
          const y0 = h * (0.95 - depth * 0.62);
          const x0 = w * (1 - scale) / 2;
          const row = state.history[r];
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          for (let i = 0; i < n; i += 1) {
            const x = x0 + (i / (n - 1)) * w * scale;
            ctx.lineTo(x, y0 - row[i] * h * 0.55 * scale);
          }
          ctx.lineTo(x0 + w * scale, y0);
          ctx.closePath();
          const c = mix(colors, 0.15 + 0.7 * (1 - depth));
          ctx.fillStyle = rgba(c, 0.10 + 0.25 * (1 - depth));
          ctx.fill();
          ctx.strokeStyle = rgba(c, 0.25 + 0.6 * (1 - depth));
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      },

      capsules(ctx, w, h, lv, colors, t) {
        const n = 18;
        const v = sample(lv, n, t);
        const p = peaksFor(v);
        const base = h * 0.78;
        const gap = w / n;
        const bw = gap * 0.56;
        for (let i = 0; i < n; i += 1) {
          const c = mix(colors, i / (n - 1));
          const x = i * gap + (gap - bw) / 2;
          const bh = Math.max(bw, v[i] * base * 0.92);
          const g = ctx.createLinearGradient(0, base - bh, 0, base);
          g.addColorStop(0, rgba(c, 0.95));
          g.addColorStop(1, rgba(c, 0.4));
          ctx.fillStyle = g;
          ctx.shadowBlur = 10;
          ctx.shadowColor = rgba(c, 0.7);
          roundRect(ctx, x, base - bh, bw, bh, bw / 2);
          ctx.fill();
          ctx.shadowBlur = 0;
          ctx.fillStyle = rgba(c, 0.95);
          ctx.beginPath();
          ctx.arc(x + bw / 2, base + h * 0.1 - p[i] * h * 0.04, Math.max(1.5, bw * 0.18), 0, Math.PI * 2);
          ctx.fill();
        }
      },

      scope(ctx, w, h, lv, colors, t) {
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.lineWidth = 1;
        for (let i = 1; i < 8; i += 1) { ctx.beginPath(); ctx.moveTo((i * w) / 8, 0); ctx.lineTo((i * w) / 8, h); ctx.stroke(); }
        for (let i = 1; i < 4; i += 1) { ctx.beginPath(); ctx.moveTo(0, (i * h) / 4); ctx.lineTo(w, (i * h) / 4); ctx.stroke(); }
        const g = ctx.createLinearGradient(0, 0, w, 0);
        colors.forEach((c, i) => g.addColorStop(colors.length === 1 ? 0 : i / (colors.length - 1), c));
        ctx.strokeStyle = g;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.shadowBlur = 10;
        ctx.shadowColor = rgba(mix(colors, 0.5), 0.9);
        ctx.beginPath();
        const wave = lv && lv.wave;
        const points = 160;
        // Auto-gain: the waveform is measured after the volume, so scale it to fill the screen.
        let peak = 0.02;
        if (wave && wave.length) for (let k = 0; k < wave.length; k += 4) peak = Math.max(peak, Math.abs(wave[k]));
        state.scopeGain = (state.scopeGain || 1) + ((0.9 / peak) - (state.scopeGain || 1)) * 0.15;
        const gain = Math.min(40, state.scopeGain);
        for (let i = 0; i < points; i += 1) {
          let y;
          if (wave && wave.length) y = Math.max(-1, Math.min(1, wave[Math.floor((i / points) * wave.length)] * gain));
          else {
            const e = lv ? lv.energy : 0;
            const u = i / points;
            y = e * (0.6 * Math.sin(u * 22 + t * 6) + 0.3 * Math.sin(u * 57 - t * 9) + 0.15 * Math.sin(u * 131 + t * 4));
          }
          const x = (i / (points - 1)) * w;
          const yy = h / 2 + y * h * 0.42;
          if (i === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
      },

      mirror(ctx, w, h, lv, colors, t) {
        const n = 40;
        const v = sample(lv, n, t);
        const mid = h / 2;
        const gap = w / n;
        for (let i = 0; i < n; i += 1) {
          const c = mix(colors, i / (n - 1));
          const bh = Math.max(1, v[i] * mid * 0.92);
          const g = ctx.createLinearGradient(0, mid - bh, 0, mid + bh);
          g.addColorStop(0, rgba(c, 0.15));
          g.addColorStop(0.5, rgba(c, 0.95));
          g.addColorStop(1, rgba(c, 0.15));
          ctx.fillStyle = g;
          ctx.fillRect(i * gap + gap * 0.2, mid - bh, gap * 0.6, bh * 2);
        }
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.fillRect(0, mid - 0.5, w, 1);
      },

      led(ctx, w, h, lv, colors, t) {
        const n = 16;
        const segs = 12;
        const v = sample(lv, n, t);
        const p = peaksFor(v);
        const gap = w / n;
        const sh = (h * 0.86) / segs;
        const zone = (k) => (k >= segs - 2 ? [255, 70, 70] : k >= segs - 5 ? [255, 196, 64] : [60, 230, 120]);
        for (let i = 0; i < n; i += 1) {
          const lit = Math.round(v[i] * segs);
          const peak = Math.min(segs - 1, Math.round(p[i] * segs));
          for (let k = 0; k < segs; k += 1) {
            const on = k < lit || k === peak;
            const c = colors.length === 1 && colors[0] === '#ffb547' ? [255, 181, 71] : zone(k);
            ctx.fillStyle = on ? rgba(c, k === peak && k >= lit ? 0.7 : 0.92) : rgba(c, 0.08);
            ctx.fillRect(i * gap + gap * 0.14, h * 0.93 - (k + 1) * sh + 1.5, gap * 0.72, sh - 3);
          }
        }
      },

      waterfall(ctx, w, h, lv, colors, t) {
        const n = 48;
        const v = sample(lv, n, t);
        const cw = Math.max(1, Math.round(w));
        const ch = Math.max(1, Math.round(h));
        if (!state.waterfall || state.waterfall.width !== cw || state.waterfall.height !== ch) {
          state.waterfall = document.createElement('canvas');
          state.waterfall.width = cw;
          state.waterfall.height = ch;
          state.wfCtx = state.waterfall.getContext('2d');
        }
        const wf = state.wfCtx;
        // Stretch each frame between its quietest and loudest band, so even a
        // loud, compressed station shows detail; colour by frequency.
        const lo = Math.min(...v);
        const hi = Math.max(lo + 0.05, ...v);
        // Scroll left by replacing pixels ('copy'); blending would build up to full brightness.
        wf.globalCompositeOperation = 'copy';
        wf.drawImage(state.waterfall, -2, 0);
        wf.globalCompositeOperation = 'source-over';
        wf.clearRect(cw - 2, 0, 2, ch);
        for (let i = 0; i < n; i += 1) {
          const y = ch - ((i + 1) / n) * ch;
          const heat = ((v[i] - lo) / (hi - lo)) ** 2.2;
          wf.fillStyle = rgba(mix(colors, i / (n - 1)), heat);
          wf.fillRect(cw - 2, y, 2, ch / n + 1);
        }
        ctx.drawImage(state.waterfall, 0, 0, w, h);
      },

      silk(ctx, w, h, lv, colors, t) {
        const n = 32;
        const v = sample(lv, n, t);
        const p = peaksFor(v);
        const base = h * 0.92;
        const pts = Array.from(v, (val, i) => [(i / (n - 1)) * w, base - val * h * 0.8]);
        const g = ctx.createLinearGradient(0, 0, w, 0);
        colors.forEach((c, i) => g.addColorStop(colors.length === 1 ? 0 : i / (colors.length - 1), c));
        ctx.beginPath();
        ctx.moveTo(0, base);
        ctx.lineTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < n; i += 1) {
          const [x0, y0] = pts[i - 1];
          const [x1, y1] = pts[i];
          ctx.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
        }
        ctx.lineTo(w, pts[n - 1][1]);
        ctx.lineTo(w, base);
        ctx.closePath();
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = g;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = g;
        ctx.lineWidth = 2;
        ctx.shadowBlur = 10;
        ctx.shadowColor = rgba(mix(colors, 0.5), 0.8);
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.setLineDash([2, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i < n; i += 1) {
          const x = (i / (n - 1)) * w;
          const y = base - p[i] * h * 0.8 - 3;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
    };

    return {
      draw(modeId, ctx, w, h, levels, colors, t) {
        const look = looks[modeId] || looks.bars;
        if (modeId !== 'terrain') state.history.length = Math.min(state.history.length, 0);
        look(ctx, w, h, levels, colors.length ? colors : ['#7dd3fc'], t);
      }
    };
  }

  window.EqViz = { MODES, createRenderer };
})();
