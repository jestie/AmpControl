/*
 * Spotify in the app: setup in Settings, playing in the Radio tab.
 * The server does all Spotify calls; the page never sees a token.
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

  const DEVICE_KEY = 'soundcontrol.spotify.device';
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* fine */ } }
  };

  function create({ api, toast, deviceName }) {
    let status = null;

    // ---------------- Settings: setup ----------------
    const setup = el('section', { class: 'section spotify-setup' });

    function renderSetup() {
      const items = [el('div', { class: 'section-label', text: '🎵 Spotify' })];
      if (!status) { items.push(el('p', { class: 'muted small', text: 'Checking…' })); setup.replaceChildren(...items); return; }

      if (!status.configured) {
        const input = el('input', { type: 'text', maxlength: '32', placeholder: 'Client ID (32 characters)', 'aria-label': 'Spotify Client ID', autocomplete: 'off', spellcheck: 'false' });
        const save = el('button', { type: 'submit', class: 'primary', text: 'Save' });
        const form = el('form', { class: 'row spotify-client' }, [input, save]);
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          try { status = await api('/api/spotify/client', { method: 'POST', body: JSON.stringify({ clientId: input.value.trim() }) }); renderAll(); toast('Client ID saved: now press Connect'); } catch (err) { toast(err.message); }
        });
        items.push(
          el('p', { class: 'small', text: 'Play your Spotify playlists on the amp. Needs Spotify Premium and a free developer key (5 minutes, once):' }),
          el('ol', { class: 'small steps' }, [
            el('li', {}, ['Go to ', el('a', { href: 'https://developer.spotify.com/dashboard', target: '_blank', rel: 'noopener noreferrer', text: 'developer.spotify.com/dashboard' }), ' and log in with your Spotify account.']),
            el('li', { text: 'Create app: any name (e.g. SoundControl), any description.' }),
            el('li', {}, ['Redirect URI: ', el('code', { class: 'copyable', text: status.redirectUri }), ' (copy it exactly).']),
            el('li', { text: 'Tick "Web API", agree, save. Open the app’s Settings and copy the Client ID.' }),
            el('li', { text: 'Paste it below and press Save.' })
          ]),
          form,
          el('p', { class: 'muted small', text: 'No client secret and no Spotify password are needed or stored here.' })
        );
      } else if (!status.connected) {
        const loopback = /^http:\/\/127\.0\.0\.1:\d+\//.test(status.redirectUri);
        const here = location.hostname === '127.0.0.1';
        const port = (/:(\d+)\//.exec(status.redirectUri) || [])[1] || location.port;
        items.push(el('p', { class: 'small', text: 'Client ID saved. Now sign in to Spotify once to connect.' }));
        if (loopback && !here) {
          items.push(
            el('p', { class: 'small warn-text' }, ['Spotify only allows this sign-in from the server’s own browser. On the PC running SoundControl, open ', el('a', { href: `http://127.0.0.1:${port}/`, text: `http://127.0.0.1:${port}` }), ', sign in there, come to Settings and press Connect. After that it works from every device.'])
          );
        }
        items.push(el('div', { class: 'row' }, [
          el('a', { class: 'button primary', href: '/spotify/login', text: 'Connect Spotify' }),
          el('button', { type: 'button', class: 'ghost', text: 'Change Client ID', onclick: () => { status = { ...status, configured: false }; renderAll(); } })
        ]));
      } else {
        items.push(
          el('p', { class: 'small' }, [
            '✅ Connected', status.user ? ` as ${status.user}` : '',
            status.premium === false ? el('span', { class: 'warn-text', text: ' · not Premium: Spotify only allows playback control with Premium' }) : '',
            status.error ? el('span', { class: 'warn-text', text: ` · ${status.error}` }) : ''
          ]),
          el('button', { type: 'button', class: 'ghost', text: 'Disconnect Spotify', onclick: async () => {
            if (!window.confirm('Disconnect Spotify from SoundControl?')) return;
            try { await api('/api/spotify/disconnect', { method: 'POST' }); load(); } catch (e) { toast(e.message); }
          } })
        );
      }
      setup.replaceChildren(...items);
    }

    // ---------------- Radio tab: play ----------------
    const player = el('section', { class: 'section spotify', hidden: true });
    const link = el('input', { type: 'text', placeholder: 'Paste a Spotify link (playlist, album or track)', 'aria-label': 'Spotify link' });
    const speaker = el('select', { 'aria-label': 'Speaker' });
    const refreshSpeakers = el('button', { type: 'button', class: 'mini', title: 'Find speakers', 'aria-label': 'Find speakers', text: '↻' });
    const playForm = el('form', { class: 'spotify-play' }, [
      el('div', { class: 'row' }, [link, el('button', { type: 'submit', class: 'primary', text: 'Play' })]),
      el('label', { class: 'row small' }, [el('span', { text: 'On' }), speaker, refreshSpeakers])
    ]);
    const nowArt = el('span', { class: 'radio-icon', text: '🎵' });
    const nowTitle = el('div', { class: 'wr-now-name', text: 'Nothing playing on Spotify' });
    const nowSub = el('div', { class: 'muted small', text: '' });
    const prev = el('button', { type: 'button', class: 'icon', text: '⏮', 'aria-label': 'Previous' });
    const toggle = el('button', { type: 'button', class: 'icon play', text: '▶', 'aria-label': 'Play' });
    const next = el('button', { type: 'button', class: 'icon', text: '⏭', 'aria-label': 'Next' });
    const now = el('div', { class: 'wr-now spotify-now' }, [nowArt, el('div', { class: 'grow' }, [nowTitle, nowSub]), prev, toggle, next]);
    const lists = el('ul', { class: 'radio-list spotify-lists' });
    const listsBox = el('details', {}, [el('summary', { text: 'Your playlists' }), lists]);
    player.append(el('div', { class: 'section-label', text: '🎵 Spotify' }), now, playForm, listsBox);

    let devicesCache = [];
    async function loadSpeakers() {
      try {
        devicesCache = await api('/api/spotify/devices');
      } catch (e) { devicesCache = []; toast(e.message); }
      const saved = store.get(DEVICE_KEY);
      const opts = devicesCache.map((d) => el('option', { value: d.id, text: `${d.name}${d.active ? ' (playing)' : ''}` }));
      if (!opts.length) opts.push(el('option', { value: '', text: 'No speakers found: open Spotify and play on the amp once' }));
      speaker.replaceChildren(...opts);
      const match = devicesCache.find((d) => d.name === saved)
        || devicesCache.find((d) => /marantz|pm7000|heos|denon/i.test(d.name) || (deviceName && d.name.toLowerCase().includes(String(deviceName).toLowerCase())))
        || devicesCache.find((d) => d.active);
      if (match) speaker.value = match.id;
    }
    speaker.addEventListener('change', () => {
      const d = devicesCache.find((x) => x.id === speaker.value);
      if (d) store.set(DEVICE_KEY, d.name);
    });
    refreshSpeakers.addEventListener('click', loadSpeakers);

    async function play(value) {
      try {
        await api('/api/spotify/play', { method: 'POST', body: JSON.stringify({ link: value, deviceId: speaker.value || null }) });
        toast('Playing on Spotify');
        setTimeout(loadNow, 1200);
      } catch (e) { toast(e.message); }
    }
    playForm.addEventListener('submit', (e) => { e.preventDefault(); if (link.value.trim()) play(link.value.trim()); });

    async function loadLists() {
      try {
        const items = await api('/api/spotify/playlists');
        lists.replaceChildren(...(items.length ? items.map((p) => {
          const icon = p.image ? el('img', { src: p.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : el('span', { class: 'radio-icon', text: '🎵' });
          const b = el('button', { type: 'button', class: 'radio-item station' }, [icon, el('span', { class: 'radio-name' }, [p.name, el('span', { class: 'wr-meta', text: p.tracks ? `${p.tracks} tracks` : '' })]), el('span', { class: 'radio-go', text: '▶' })]);
          b.addEventListener('click', () => play(p.link));
          return el('li', {}, [b]);
        }) : [el('li', { class: 'muted small', text: 'No playlists.' })]));
      } catch (e) { lists.replaceChildren(el('li', { class: 'muted small', text: e.message })); }
    }

    let playing = false;
    async function loadNow() {
      if (player.hidden || document.hidden) return;
      try {
        const n = await api('/api/spotify/now');
        playing = n.playing;
        nowTitle.textContent = n.title || 'Nothing playing on Spotify';
        nowSub.textContent = [n.artist, n.device ? `on ${n.device}` : ''].filter(Boolean).join(' · ');
        toggle.textContent = n.playing ? '⏸' : '▶';
        toggle.setAttribute('aria-label', n.playing ? 'Pause' : 'Play');
        const art = n.image ? el('img', { src: n.image, alt: '', referrerpolicy: 'no-referrer', class: 'wr-logo' }) : el('span', { class: 'radio-icon', text: '🎵' });
        now.firstChild.replaceWith(art);
      } catch (e) { /* not fatal */ }
    }
    const control = (action) => async () => { try { await api('/api/spotify/control', { method: 'POST', body: JSON.stringify({ action }) }); setTimeout(loadNow, 600); } catch (e) { toast(e.message); } };
    prev.addEventListener('click', control('previous'));
    next.addEventListener('click', control('next'));
    toggle.addEventListener('click', () => control(playing ? 'pause' : 'play')());

    // ---------------- shared ----------------
    function renderAll() {
      renderSetup();
      const ready = Boolean(status && status.connected && !status.error);
      const wasHidden = player.hidden;
      player.hidden = !ready;
      if (ready && wasHidden) { loadSpeakers(); loadLists(); loadNow(); }
    }
    async function load() {
      try { status = await api('/api/spotify/status'); } catch (e) { status = { configured: false, connected: false, redirectUri: '', error: e.message }; }
      renderAll();
    }

    // Result of the sign-in round trip (?spotify=...).
    const params = new URLSearchParams(location.search);
    if (params.has('spotify')) {
      const msg = params.get('spotify');
      toast(msg === 'connected' ? 'Spotify connected' : msg);
      history.replaceState(null, '', location.pathname);
    }
    load();
    setInterval(loadNow, 5000);

    return { setup, player };
  }

  window.SpotifyPanel = { create };
})();
