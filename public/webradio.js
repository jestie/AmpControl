/*
 * Browser radio for a virtual amp: browse and search the open Radio Browser
 * directory, play in the page, and hand the audio to the visualiser so the
 * waves and the faces' meters follow the real music.
 *
 * The amp's state still rules: standby stops the sound, volume and mute set
 * how loud it plays. The stream comes through our server (same origin), which
 * is what makes the analysis possible.
 */
(() => {
  'use strict';

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

  function create({ device, api, toast, visualizer, refresh }) {
    const LAST_KEY = `soundcontrol.webradio.last.${device.id}`;
    const store = {
      get() { try { return JSON.parse(localStorage.getItem(LAST_KEY) || 'null'); } catch (e) { return null; } },
      set(v) { try { localStorage.setItem(LAST_KEY, JSON.stringify(v)); } catch (e) { /* private mode */ } }
    };

    const audio = new Audio();
    audio.preload = 'none';
    audio.crossOrigin = 'anonymous';
    let ctx = null;
    let analyser = null;
    let current = null;
    let amp = { power: 'standby', volume: 12, mute: false };
    const cap = Number(device.volumeCap) || 60;

    function ensureGraph() {
      if (ctx) return;
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      ctx = new AudioCtx();
      const source = ctx.createMediaElementSource(audio);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.72;
      source.connect(analyser);
      analyser.connect(ctx.destination);
    }

    // The amp's volume (0-100) is the loudness here; a gentle curve sounds more even.
    function applyAmp() {
      const level = amp.power === 'on' && !amp.mute ? Math.min(amp.volume, cap) / 100 : 0;
      audio.volume = Math.min(1, level ** 1.5 * 1.6);
      if (amp.power !== 'on' && !audio.paused) stop(false);
    }

    const nowName = el('div', { class: 'wr-now-name', text: 'Nothing playing' });
    const nowSub = el('div', { class: 'wr-now-sub muted small', text: 'Pick a station below' });
    const nowLogo = el('span', { class: 'radio-icon', text: '📻' });
    const playBtn = el('button', { type: 'button', class: 'icon play', 'aria-label': 'Play', text: '▶' });
    const nowBar = el('div', { class: 'wr-now' }, [nowLogo, el('div', { class: 'grow' }, [nowName, nowSub]), playBtn]);

    function setLogo(station) {
      const node = station && station.favicon
        ? el('img', { src: station.favicon, alt: '', referrerpolicy: 'no-referrer', class: 'wr-logo' })
        : el('span', { class: 'radio-icon', text: '📻' });
      if (node.tagName === 'IMG') node.addEventListener('error', () => node.replaceWith(el('span', { class: 'radio-icon', text: '📻' })));
      nowBar.firstChild.replaceWith(node);
    }

    function renderNow(state) {
      const station = current || store.get();
      nowName.textContent = station ? station.name : 'Nothing playing';
      nowSub.textContent = state || (station ? 'Stopped' : 'Pick a station below');
      playBtn.textContent = audio.paused ? '▶' : '■';
      playBtn.setAttribute('aria-label', audio.paused ? 'Play' : 'Stop');
      setLogo(station);
    }

    async function play(station) {
      if (!station || !station.uuid) return;
      current = station;
      store.set({ uuid: station.uuid, name: station.name, favicon: station.favicon || '' });
      try {
        await api(`/api/devices/${device.id}/webradio/playing`, { method: 'POST', body: JSON.stringify({ uuid: station.uuid }) });
      } catch (e) {
        toast(e.message);
        return;
      }
      amp.power = 'on';
      ensureGraph();
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
      audio.src = `/api/webradio/stream/${station.uuid}`;
      applyAmp();
      renderNow('Tuning…');
      try {
        await audio.play();
        if (visualizer && analyser) visualizer.useAnalyser(analyser, ctx.sampleRate);
        renderNow(station.tags && station.tags.length ? station.tags.join(' · ') : 'Live');
      } catch (e) {
        renderNow(e.name === 'NotAllowedError' ? 'Tap ▶ to start (the browser blocked autoplay)' : 'This station is not playing; try another');
      }
      refresh();
    }

    function stop(tell = true) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      if (visualizer) visualizer.useAnalyser(null);
      renderNow();
      if (tell) refresh();
    }

    audio.addEventListener('error', () => { if (audio.getAttribute('src')) renderNow('This station is not playing; try another'); });
    audio.addEventListener('playing', () => renderNow(current && current.tags && current.tags.length ? current.tags.join(' · ') : 'Live'));
    audio.addEventListener('waiting', () => renderNow('Buffering…'));
    playBtn.addEventListener('click', () => {
      if (!audio.paused) stop();
      else play(current || store.get());
    });

    // ---- browse ----
    const search = el('input', { type: 'search', placeholder: 'Search stations, e.g. Jazz FM', maxlength: '60', 'aria-label': 'Search radio stations' });
    const form = el('form', { class: 'radio-search' }, [search, el('button', { type: 'submit', text: 'Search' })]);
    const genres = el('div', { class: 'wr-genres' });
    const list = el('ul', { class: 'radio-list' });
    const title = el('div', { class: 'radio-title', text: 'Popular' });

    function row(station) {
      const icon = station.favicon
        ? el('img', { src: station.favicon, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
        : el('span', { class: 'radio-icon', text: '📻' });
      if (icon.tagName === 'IMG') icon.addEventListener('error', () => icon.replaceWith(el('span', { class: 'radio-icon', text: '📻' })));
      const meta = [station.country, station.codec, station.bitrate ? `${station.bitrate}k` : ''].filter(Boolean).join(' · ');
      const button = el('button', { type: 'button', class: 'radio-item station' }, [
        icon,
        el('span', { class: 'radio-name' }, [station.name, el('span', { class: 'wr-meta', text: meta })]),
        el('span', { class: 'radio-go', text: '▶' })
      ]);
      button.addEventListener('click', () => play(station));
      return el('li', {}, [button]);
    }

    async function load(params, label) {
      title.textContent = label;
      list.replaceChildren(el('li', { class: 'muted small', text: 'Loading…' }));
      try {
        const stations = await api(`/api/webradio/search?${new URLSearchParams(params)}`);
        list.replaceChildren(...(stations.length ? stations.map(row) : [el('li', { class: 'muted small', text: 'No stations found.' })]));
      } catch (e) {
        list.replaceChildren(el('li', { class: 'muted small', text: e.message }));
      }
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const q = search.value.trim();
      if (q.length >= 2) load({ q }, `Search: ${q}`);
    });

    let loaded = false;
    async function init() {
      if (loaded) return;
      loaded = true;
      try {
        const tags = await api('/api/webradio/genres');
        genres.replaceChildren(...tags.map((tag) => el('button', { type: 'button', class: 'chip', text: tag, onclick: () => load({ tag }, tag[0].toUpperCase() + tag.slice(1)) })));
      } catch (e) { /* genres are optional */ }
      load({}, 'Popular');
    }

    const section = el('section', { class: 'section radio webradio' }, [
      el('div', { class: 'section-label', text: 'Internet radio · plays on this device' }),
      nowBar,
      form,
      genres,
      el('div', { class: 'radio-nav' }, [title]),
      list,
      el('p', { class: 'muted small', text: 'Stations from the open Radio Browser directory (radio-browser.info).' })
    ]);
    renderNow();

    // An alarm on a virtual amp: the open page plays the station.
    window.addEventListener('sc:alarm', (event) => {
      const alarm = event.detail;
      if (!alarm || alarm.deviceId !== device.id || !alarm.action || alarm.action.type !== 'radio') return;
      play({ uuid: alarm.action.mid, name: alarm.action.name, favicon: (store.get() || {}).favicon || '' });
    });

    return {
      section,
      init,
      update(data) {
        amp = { power: data.power, volume: Number(data.volume) || 0, mute: Boolean(data.mute) };
        applyAmp();
      },
      lastStation() {
        const s = store.get();
        return s ? { mid: s.uuid, name: s.name } : null;
      }
    };
  }

  window.WebRadioPanel = { create };
})();
