/*
 * A pair of bookshelf speakers beside the amp, drawn in code (our own design).
 * Tap the tab on either side to slide both out; tap a speaker to take its
 * grille off or put it back. The bass cone pumps with the bass and the tweeter
 * with the treble, scaled by the volume; nothing moves in standby.
 */
(() => {
  'use strict';

  const SHOW_KEY = 'soundcontrol.speakers.show';
  const GRILLE_KEY = 'soundcontrol.speakers.grille';
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* fine */ } }
  };

  function el(tag, cls, attrs = {}, children = []) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    for (const c of children) node.append(c);
    return node;
  }

  function speaker(side) {
    const tweeterDome = el('div', 'spk-dome');
    const tweeter = el('div', 'spk-tweeter', {}, [el('div', 'spk-tweeter-plate', {}, [tweeterDome])]);
    const plug = el('div', 'spk-plug');
    const cone = el('div', 'spk-cone', {}, [plug]);
    const woofer = el('div', 'spk-woofer', {}, [el('div', 'spk-surround', {}, [cone])]);
    const port = el('div', 'spk-port');
    const badge = el('div', 'spk-badge');
    badge.textContent = 'SC';
    const baffle = el('div', 'spk-baffle', {}, [badge, tweeter, woofer, port]);
    const grilleBadge = el('div', 'spk-grille-badge');
    grilleBadge.textContent = 'SoundControl';
    const grille = el('div', 'spk-grille', {}, [grilleBadge]);
    const root = el('button', `speaker speaker-${side}`, { type: 'button', 'aria-label': `${side} speaker: tap to take the grille off or put it on` }, [
      el('div', 'spk-cabinet', {}, [baffle, grille])
    ]);
    return { root, cone, plug, tweeterDome, grille };
  }

  function create({ levels, getState, cap }) {
    const left = speaker('left');
    const right = speaker('right');
    const tabL = el('button', 'spk-tab spk-tab-left', { type: 'button' });
    const tabR = el('button', 'spk-tab spk-tab-right', { type: 'button' });

    function setShown(show) {
      store.set(SHOW_KEY, show ? 'on' : 'off');
      row.classList.toggle('speakers-out', show);
      for (const tab of [tabL, tabR]) {
        tab.textContent = show ? (tab === tabL ? '›' : '‹') : '☰';
        tab.title = show ? 'Hide the speakers' : 'Show the speakers';
        tab.setAttribute('aria-label', tab.title);
        tab.setAttribute('aria-pressed', String(show));
      }
    }
    function setGrille(on) {
      store.set(GRILLE_KEY, on ? 'on' : 'off');
      row.classList.toggle('grilles-off', !on);
    }

    const middle = el('div', 'amp-middle');
    const row = el('div', 'amp-row', {}, [tabL, left.root, middle, right.root, tabR]);
    [tabL, tabR].forEach((t) => t.addEventListener('click', () => setShown(!row.classList.contains('speakers-out'))));
    [left.root, right.root].forEach((s) => s.addEventListener('click', () => setGrille(row.classList.contains('grilles-off'))));
    setShown(store.get(SHOW_KEY, 'off') === 'on');
    setGrille(store.get(GRILLE_KEY, 'on') === 'on');

    // ---- movement ----
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // A cone follows the beat: how far the level jumps above its recent average
    // (a loud, steady track would otherwise just hold the cone out).
    const mk = () => ({ bass: 0, high: 0, avgB: 0, avgH: 0 });
    const l = mk();
    const r = mk();
    function drive(s, bass, high, loud) {
      s.avgB += (bass - s.avgB) * 0.08;   // smoothing tuned for 30 fps
      s.avgH += (high - s.avgH) * 0.12;
      const kickB = Math.max(0, bass - s.avgB) * 7 + bass * 0.1;
      const kickH = Math.max(0, high - s.avgH) * 6 + high * 0.08;
      const tB = Math.min(1, kickB) * loud;
      const tH = Math.min(1, kickH) * loud;
      s.bass += (tB - s.bass) * (tB > s.bass ? 0.91 : 0.44);   // punch out, ease back
      s.high += (tH - s.high) * (tH > s.high ? 0.96 : 0.58);
    }
    let lastFrame = 0;
    function frame(now) {
      requestAnimationFrame(frame);
      if (document.hidden || !row.classList.contains('speakers-out') || !row.isConnected) return;
      if (now - lastFrame < 1000 / 30 - 4) return;   // 30 fps: the cones still punch on the beat
      lastFrame = now;
      const state = getState() || {};
      const on = state.power === 'on' && !state.mute;
      const loud = on ? 0.35 + 0.65 * Math.min(1, (Number(state.volume) || 0) / Math.max(1, cap)) : 0;
      const lv = levels ? levels() : null;
      const b = lv ? lv.bands : [0, 0, 0, 0];
      // Left leans on the low bands, right on the mid/high ones, like the VU meters.
      drive(l, b[0], b[3] * 0.7 + b[2] * 0.3, loud);
      drive(r, b[0] * 0.8 + b[1] * 0.2, b[3], loud);
      const k = reduce ? 0.25 : 1;
      for (const [spk, s] of [[left, l], [right, r]]) {
        spk.cone.style.scale = String(1 + s.bass * 0.13 * k);
        spk.cone.style.boxShadow = `inset 0 0 ${6 + s.bass * 16}px rgba(0,0,0,${0.3 + s.bass * 0.4})`;
        spk.plug.style.scale = String(1 + s.bass * 0.2 * k);
        spk.tweeterDome.style.scale = String(1 + s.high * 0.14 * k);
        spk.grille.style.scale = String(1 + s.bass * 0.01 * k);
      }
    }
    requestAnimationFrame(frame);

    return { row, middle };
  }

  window.Speakers = { create };
})();
