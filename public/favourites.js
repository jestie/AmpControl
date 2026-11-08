/*
 * ♥ My stations: the signed-in user's own favourite stations, kept by the
 * server (/api/my/stations). Separate from the amp's presets (☆ = HEOS
 * Favourites). One store per page; every ♥ button on the page follows it.
 *
 *   MyStations.init(api, toast)       load the list once
 *   MyStations.heart(station)         a ♥ toggle for a station
 *   MyStations.panel({ play, why })   the Favourites list for one amp card
 *
 * A station is { source: 'tunein', mid, cid?, name, image }
 *            or { source: 'directory', uuid, name, image }.
 */
(() => {
  'use strict';

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of [].concat(children)) if (child !== null && child !== undefined) node.append(child);
    return node;
  }

  const idFor = (s) => (s.source === 'tunein' ? `tunein:${s.mid}` : `directory:${s.uuid}`);

  let api = null;
  let toast = (m) => console.log(m);
  let list = [];
  let loaded = null;
  const panels = new Set();

  function emit() {
    const ids = new Set(list.map((s) => s.id));
    for (const btn of document.querySelectorAll('button.my-heart[data-fid]')) paintHeart(btn, ids.has(btn.dataset.fid));
    for (const p of panels) p.render();
  }

  function paintHeart(btn, on) {
    btn.textContent = on ? '♥' : '♡';
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
    const name = btn.dataset.name || 'this station';
    btn.title = on ? 'Remove from my favourites' : 'Add to my favourites';
    btn.setAttribute('aria-label', on ? `Remove ${name} from my favourites` : `Add ${name} to my favourites`);
  }

  async function init(apiFn, toastFn) {
    api = apiFn;
    if (toastFn) toast = toastFn;
    if (!loaded) {
      loaded = api('/api/my/stations').then((l) => { list = Array.isArray(l) ? l : []; emit(); }).catch(() => { /* shown empty */ });
    }
    return loaded;
  }

  const has = (station) => list.some((s) => s.id === idFor(station));

  async function toggle(station) {
    if (!api) return;
    const id = idFor(station);
    try {
      if (list.some((s) => s.id === id)) {
        list = await api(`/api/my/stations/${encodeURIComponent(id)}`, { method: 'DELETE' });
        toast(`Removed ${station.name} from your favourites`);
      } else {
        list = await api('/api/my/stations', { method: 'POST', body: JSON.stringify(station) });
        toast(`♥ Added ${station.name} to your favourites`);
      }
    } catch (e) {
      toast(e.message);
    }
    emit();
  }

  function heart(station) {
    const btn = el('button', { type: 'button', class: 'my-heart', dataset: { fid: idFor(station), name: station.name || '' } });
    paintHeart(btn, has(station));
    btn.addEventListener('click', (event) => { event.stopPropagation(); toggle(station); });
    return btn;
  }

  async function saveOrder(ids) {
    try {
      list = await api('/api/my/stations/order', { method: 'PUT', body: JSON.stringify({ ids }) });
    } catch (e) {
      toast(e.message);
    }
    emit();
  }

  /**
   * The Favourites list for one amp card.
   * play(station): plays it; why(station): '' when it can play here, else the reason.
   * onCount(n): told how many favourites there are (to pick the opening view).
   */
  function panel({ play, why = () => '', onCount = () => {} }) {
    const ul = el('ul', { class: 'radio-list my-list' });
    const empty = el('p', { class: 'muted small my-empty', text: 'No favourites yet. Tap ♡ next to any station in Browse to keep it here.' });
    const hint = el('p', { class: 'muted small my-hint', text: 'Drag ≡ to change the order (or focus it and use the arrow keys).' });
    const section = el('section', { class: 'section radio my-stations' }, [
      el('div', { class: 'section-label', text: '♥ My favourite stations' }),
      empty, ul, hint
    ]);

    function row(station) {
      const reason = why(station);
      const icon = station.image
        ? el('img', { src: station.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
        : el('span', { class: 'radio-icon', text: '📻' });
      if (icon.tagName === 'IMG') icon.addEventListener('error', () => icon.replaceWith(el('span', { class: 'radio-icon', text: '📻' })));
      const source = station.source === 'tunein' ? 'TuneIn' : 'Open directory';
      const button = el('button', { type: 'button', class: `radio-item station${reason ? ' unavailable' : ''}`, title: reason || `Play ${station.name}` }, [
        icon,
        el('span', { class: 'radio-name' }, [station.name, el('span', { class: 'wr-meta', text: reason ? `${source} · ${reason}` : source })]),
        el('span', { class: 'radio-go', text: '▶' })
      ]);
      button.addEventListener('click', () => {
        if (reason) { toast(reason); return; }
        play(station);
      });
      const grip = el('button', { type: 'button', class: 'my-grip', text: '≡', title: 'Drag to reorder', 'aria-label': `Move ${station.name}: arrow keys` });
      const li = el('li', { class: 'radio-row my-row', dataset: { fid: station.id } }, [grip, button, heart(station)]);
      grip.addEventListener('keydown', (event) => {
        const step = { ArrowUp: -1, ArrowDown: 1 }[event.key];
        if (!step) return;
        event.preventDefault();
        const ids = list.map((s) => s.id);
        const i = ids.indexOf(station.id);
        const j = i + step;
        if (i < 0 || j < 0 || j >= ids.length) return;
        [ids[i], ids[j]] = [ids[j], ids[i]];
        saveOrder(ids).then(() => { const g = ul.querySelector(`li[data-fid="${CSS.escape(station.id)}"] .my-grip`); if (g) g.focus(); });
      });
      grip.addEventListener('pointerdown', (event) => startDrag(event, li));
      return li;
    }

    // Pointer drag (mouse and touch): the row follows the finger; drop saves the order.
    function startDrag(event, li) {
      event.preventDefault();
      // Listen on the window: moving the row in the page drops pointer capture.
      const grip = window;
      const pid = event.pointerId;
      li.classList.add('dragging');
      let moved = false;
      const move = (e) => {
        if (e.pointerId !== pid) return;
        const others = [...ul.children].filter((x) => x !== li);
        const after = others.find((x) => { const r = x.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
        if (after === li.nextElementSibling || (!after && li === ul.lastElementChild)) return;
        moved = true;
        if (after) ul.insertBefore(li, after); else ul.append(li);
      };
      const end = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', end);
        grip.removeEventListener('pointercancel', end);
        li.classList.remove('dragging');
        if (!moved) return;
        const ids = [...ul.children].map((x) => x.dataset.fid);
        if (ids.join('\n') !== list.map((s) => s.id).join('\n')) saveOrder(ids);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', end);
      grip.addEventListener('pointercancel', end);
    }

    // Rebuild only when something visible changed (status refreshes every few
    // seconds must not reset the list, least of all mid-drag).
    let lastKey = null;
    let lastCount = -1;
    const self = {
      section,
      render() {
        if (ul.querySelector('.dragging')) return;
        const key = list.map((s) => `${s.id}|${s.name}|${s.image}|${why(s)}`).join('\n');
        if (key === lastKey) return;
        lastKey = key;
        ul.replaceChildren(...list.map(row));
        empty.hidden = list.length > 0;
        hint.hidden = list.length < 2;
        if (list.length !== lastCount) { lastCount = list.length; onCount(list.length); }
      },
      count: () => list.length,
      ready: () => loaded || Promise.resolve()
    };
    panels.add(self);
    self.render();
    return self;
  }

  window.MyStations = { init, heart, panel, has, toggle, idFor };
})();
