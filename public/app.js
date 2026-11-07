(() => {
  'use strict';

  const csrfMeta = document.querySelector('meta[name="csrf-token"]');
  const csrfToken = csrfMeta ? csrfMeta.content : '';
  const devicesEl = document.getElementById('devices');
  const toastEl = document.getElementById('toast');
  const cards = new Map();
  let toastTimer = null;

  function toast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 5000);
  }

  async function api(path, options = {}) {
    const headers = Object.assign({ Accept: 'application/json' }, options.headers || {});
    const method = options.method || 'GET';
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken;

    const response = await fetch(path, {
      ...options,
      method,
      headers,
      credentials: 'same-origin'
    });

    if (response.status === 401) {
      window.location.assign('/login');
      throw new Error('Session expired');
    }

    let payload = null;
    try { payload = await response.json(); } catch (e) { payload = null; }
    if (!response.ok) {
      throw new Error((payload && payload.error) || `Request failed (${response.status})`);
    }
    return payload;
  }

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
      else node.setAttribute(key, value);
    }
    for (const child of [].concat(children)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child && child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function setNote(card, message, isError = false) {
    card.refs.note.textContent = message || '';
    card.refs.note.classList.toggle('error', Boolean(isError));
    if (isError) toast(message);
  }

  function buildCard(device) {
    const refs = {};
    const card = { id: device.id, data: null, sliderActive: false, inputsKey: '', presetsKey: '' };

    refs.badge = el('span', { class: 'badge', text: '…' });
    refs.power = el('button', { type: 'button', class: 'primary', text: 'Turn on' });

    refs.artIcon = el('span', { text: '♪' });
    refs.art = el('img', { alt: '', hidden: 'hidden' });
    refs.artPlaceholder = el('div', { class: 'art' }, [refs.artIcon, refs.art]);
    refs.title = el('div', { class: 'title', text: '—' });
    refs.sub = el('div', { class: 'sub', text: '' });

    refs.play = el('button', { type: 'button', class: 'icon play', text: '▶', 'aria-label': 'Play' });
    refs.prev = el('button', { type: 'button', class: 'icon', text: '⏮', 'aria-label': 'Previous' });
    refs.next = el('button', { type: 'button', class: 'icon', text: '⏭', 'aria-label': 'Next' });
    refs.transport = el('div', { class: 'row transport' }, [refs.prev, refs.play, refs.next]);

    refs.mute = el('button', { type: 'button', class: 'icon', text: '🔇', 'aria-label': 'Mute' });
    refs.slider = el('input', {
      type: 'range', min: '0', max: String(device.volumeCap || 40), step: '1', value: '0',
      'aria-label': 'Volume'
    });
    refs.volumeValue = el('span', { class: 'volume-value', text: '–' });
    refs.volumeDown = el('button', { type: 'button', class: 'icon', text: '−', 'aria-label': 'Volume down' });
    refs.volumeUp = el('button', { type: 'button', class: 'icon', text: '+', 'aria-label': 'Volume up' });
    refs.volume = el('section', { class: 'volume' }, [
      el('div', { class: 'volume-head' }, [
        el('span', { text: `Volume (max ${device.volumeCap || 40}%)` }),
        refs.volumeValue
      ]),
      el('div', { class: 'volume-row' }, [refs.volumeDown, refs.slider, refs.volumeUp, refs.mute])
    ]);

    refs.inputs = el('select', { 'aria-label': 'Input' });
    refs.inputSection = el('section', { class: 'section', hidden: 'hidden' }, [
      el('div', { class: 'section-label', text: 'Input' }),
      refs.inputs
    ]);

    refs.presets = el('div', { class: 'presets' });
    refs.presetSection = el('section', { class: 'section', hidden: 'hidden' }, [
      el('div', { class: 'section-label', text: 'Presets' }),
      refs.presets
    ]);

    refs.streamInput = el('input', { type: 'url', placeholder: 'https://stream.example/radio.mp3', 'aria-label': 'Stream URL' });
    refs.streamButton = el('button', { type: 'submit', text: 'Play' });
    refs.streamForm = el('form', { class: 'stream section', hidden: 'hidden' }, [
      refs.streamInput,
      refs.streamButton
    ]);

    refs.note = el('div', { class: 'note' });

    refs.root = el('article', { class: 'card' }, [
      el('div', { class: 'card-head' }, [
        el('div', {}, [
          el('h2', { text: device.name }),
          el('div', { class: 'room muted', text: device.room || '' })
        ]),
        el('div', { class: 'head-actions' }, [refs.badge, refs.power])
      ]),
      el('div', { class: 'now-playing' }, [
        refs.artPlaceholder,
        el('div', { class: 'track' }, [refs.title, refs.sub])
      ]),
      refs.transport,
      refs.volume,
      refs.inputSection,
      refs.presetSection,
      refs.streamForm,
      refs.note
    ]);

    card.refs = refs;

    if (device.faceplate && window.Faceplate) {
      card.faceplate = window.Faceplate.create({
        device,
        post: (path, body) => api(`/api/devices/${card.id}/${path}`, { method: 'POST', body: JSON.stringify(body) }),
        refresh: () => refresh(card.id, { quiet: true }),
        toast,
        getData: () => card.data
      });
      if (card.faceplate) refs.root.insertBefore(card.faceplate.root, refs.root.children[1]);
    }
    if (window.Faces) {
      card.faces = window.Faces.create({
        device,
        post: (path, body) => api(`/api/devices/${card.id}/${path}`, { method: 'POST', body: JSON.stringify(body) }),
        refresh: () => refresh(card.id, { quiet: true }),
        toast,
        levels: () => (card.visualizer ? card.visualizer.levels() : null)
      });
      (card.faceplate ? card.faceplate.root : refs.root.querySelector('.card-head')).after(card.faces.root);
    }
    if (window.Visualizer) {
      card.visualizer = window.Visualizer.create();
      (card.faces ? card.faces.root : card.faceplate ? card.faceplate.root : refs.root.querySelector('.card-head')).after(card.visualizer.root);
    }

    // ---- Internet radio (TuneIn via HEOS) ----
    const RADIO_KEY = `soundcontrol.radio.last.${device.id}`;
    refs.radioSearch = el('input', { type: 'search', placeholder: 'Search stations, e.g. BBC Radio 2', 'aria-label': 'Search radio stations', maxlength: '60' });
    refs.radioForm = el('form', { class: 'radio-search' }, [refs.radioSearch, el('button', { type: 'submit', text: 'Search' })]);
    refs.radioBack = el('button', { type: 'button', class: 'icon radio-back', text: '‹', 'aria-label': 'Back', hidden: 'hidden' });
    refs.radioTitle = el('div', { class: 'radio-title', text: 'TuneIn' });
    refs.radioList = el('ul', { class: 'radio-list' });
    refs.radioMore = el('button', { type: 'button', class: 'radio-more', text: 'More', hidden: 'hidden' });
    refs.radioSection = el('section', { class: 'section radio', hidden: 'hidden' }, [
      el('div', { class: 'section-label', text: 'Internet radio' }),
      refs.radioForm,
      el('div', { class: 'radio-nav' }, [refs.radioBack, refs.radioTitle]),
      refs.radioList,
      refs.radioMore
    ]);
    refs.root.insertBefore(refs.radioSection, refs.presetSection);

    const radio = { stack: [], loaded: false, busy: false };

    function radioRow(item) {
      const icon = item.image
        ? el('img', { src: item.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
        : el('span', { class: 'radio-icon', text: item.kind === 'folder' ? '📁' : '📻' });
      const row = el('button', { type: 'button', class: `radio-item ${item.kind}` }, [
        icon,
        el('span', { class: 'radio-name', text: item.name }),
        el('span', { class: 'radio-go', text: item.kind === 'folder' ? '›' : '▶' })
      ]);
      row.addEventListener('click', () => {
        if (item.kind === 'folder' && item.cid) openFolder(item.name, item.cid);
        else if (item.playable && item.mid) playStation(item, radio.stack.length ? radio.stack[radio.stack.length - 1].cid : null);
      });
      if (icon.tagName === 'IMG') icon.addEventListener('error', () => icon.replaceWith(el('span', { class: 'radio-icon', text: '📻' })));
      return el('li', {}, [row]);
    }

    function renderRadio(page, append) {
      if (!append) refs.radioList.replaceChildren();
      if (!append && page.items.length === 0) refs.radioList.append(el('li', { class: 'muted small', text: 'Nothing here.' }));
      refs.radioList.append(...page.items.map(radioRow));
      const top = radio.stack[radio.stack.length - 1];
      top.next = page.start + page.returned;
      refs.radioMore.hidden = !(page.count > top.next && top.cid);
      refs.radioBack.hidden = radio.stack.length <= 1;
      refs.radioTitle.textContent = top.title;
    }

    async function loadRadio(append = false) {
      if (radio.busy) return;
      radio.busy = true;
      const top = radio.stack[radio.stack.length - 1];
      if (!append) refs.radioList.replaceChildren(el('li', { class: 'muted small', text: 'Loading…' }));
      try {
        let page;
        if (top.search) page = await api(`/api/devices/${card.id}/radio/search?q=${encodeURIComponent(top.search)}`);
        else {
          const params = new URLSearchParams();
          if (top.cid) params.set('cid', top.cid);
          if (append) params.set('start', String(top.next || 0));
          page = await api(`/api/devices/${card.id}/radio/browse?${params}`);
        }
        renderRadio(page, append);
      } catch (e) {
        refs.radioList.replaceChildren(el('li', { class: 'muted small', text: e.message }));
      } finally {
        radio.busy = false;
      }
    }

    function openFolder(title, cid) {
      radio.stack.push({ title, cid });
      loadRadio();
    }

    async function playStation(item, cid) {
      setNote(card, `Tuning to ${item.name}…`);
      try {
        await api(`/api/devices/${card.id}/radio/play`, { method: 'POST', body: JSON.stringify({ mid: item.mid, name: item.name, cid }) });
        try { localStorage.setItem(RADIO_KEY, JSON.stringify({ mid: item.mid, name: item.name, cid })); } catch (e) { /* fine */ }
        toast(`Playing ${item.name}`);
        setNote(card, '');
        setTimeout(() => refresh(card.id), 1500);
        setTimeout(() => refresh(card.id), 4000);
      } catch (e) {
        setNote(card, e.message, true);
      }
    }
    card.playLastStation = () => {
      let last = null;
      try { last = JSON.parse(localStorage.getItem(RADIO_KEY) || 'null'); } catch (e) { last = null; }
      if (last && last.mid) return playStation(last, last.cid || null);
      if (card.selectTab) card.selectTab('radio');
      refs.radioSearch.focus({ preventScroll: true });
      return null;
    };

    refs.radioBack.addEventListener('click', () => {
      if (radio.stack.length > 1) radio.stack.pop();
      loadRadio();
    });
    refs.radioMore.addEventListener('click', () => loadRadio(true));
    refs.radioForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const q = refs.radioSearch.value.trim();
      if (q.length < 2) return;
      radio.stack = [radio.stack[0], { title: `Search: ${q}`, search: q }];
      loadRadio();
    });
    card.showRadio = (show) => {
      refs.radioSection.hidden = !show;
      if (show && !radio.loaded) {
        radio.loaded = true;
        radio.stack = [{ title: 'TuneIn', cid: null }];
        loadRadio();
      }
    };

    // HEOS account: sign the amp in so presets and internet radio work.
    refs.accountStatus = el('div', { class: 'account-status muted', text: 'Checking…' });
    refs.accountUser = el('input', { type: 'email', name: 'heos-user', placeholder: 'HEOS account email', autocomplete: 'username', 'aria-label': 'HEOS account email', required: 'required' });
    refs.accountPass = el('input', { type: 'password', name: 'heos-pass', placeholder: 'HEOS password', autocomplete: 'current-password', 'aria-label': 'HEOS password', required: 'required' });
    refs.accountSubmit = el('button', { type: 'submit', class: 'primary', text: 'Sign the amp in' });
    refs.accountForm = el('form', { class: 'account-form', hidden: 'hidden' }, [
      refs.accountUser, refs.accountPass, refs.accountSubmit,
      el('p', { class: 'muted small', text: 'Sent straight to the amp and saved there by HEOS; this app does not keep it. It crosses your home network unencrypted, so only use this at home.' }),
      // There is no HEOS sign-up website: accounts are made in the HEOS app or on the amp.
      el('p', { class: 'muted small register' }, [
        'No HEOS account yet? Create one free in the HEOS app (',
        el('a', { href: 'https://apps.apple.com/gb/app/heos-by-denon/id843129434', target: '_blank', rel: 'noopener noreferrer', text: 'iPhone' }),
        ' · ',
        el('a', { href: 'https://play.google.com/store/search?q=HEOS%20Denon&c=apps', target: '_blank', rel: 'noopener noreferrer', text: 'Android' }),
        '): Settings → HEOS Account → Create Account. Or on the amp: Setup menu → HEOS Account → Create Account. Then sign in here.'
      ])
    ]);
    refs.accountOut = el('button', { type: 'button', class: 'ghost', text: 'Sign out', hidden: 'hidden' });
    refs.accountSection = el('details', { class: 'section account', hidden: 'hidden' }, [
      el('summary', {}, [el('span', { class: 'section-label', text: 'HEOS account' }), refs.accountStatus]),
      refs.accountForm,
      refs.accountOut
    ]);
    refs.root.insertBefore(refs.accountSection, refs.note);

    function applyAccount(account) {
      card.account = account;
      refs.accountSection.hidden = false;
      if (!account) {
        refs.accountStatus.textContent = 'not answering';
        refs.accountForm.hidden = true;
        refs.accountOut.hidden = true;
        return;
      }
      refs.accountStatus.textContent = account.signedIn ? `signed in as ${account.username || 'HEOS user'}` : 'signed out: presets and radio are off';
      refs.accountStatus.classList.toggle('warn', !account.signedIn);
      refs.accountForm.hidden = account.signedIn;
      refs.accountOut.hidden = !account.signedIn;
      if (!account.signedIn) refs.accountSection.open = true;
      if (card.data) applyStatus(card, card.data);
    }
    card.loadAccount = async () => {
      try {
        applyAccount(await api(`/api/devices/${card.id}/account`));
      } catch (e) {
        if (/no HEOS account/.test(e.message)) return;   // device without HEOS: keep hidden
        applyAccount(null);
      }
    };

    refs.accountForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      refs.accountSubmit.disabled = true;
      refs.accountSubmit.textContent = 'Signing in…';
      try {
        const result = await api(`/api/devices/${card.id}/account/signin`, {
          method: 'POST',
          body: JSON.stringify({ username: refs.accountUser.value.trim(), password: refs.accountPass.value })
        });
        refs.accountPass.value = '';
        applyAccount(result);
        toast('The amp is signed in to HEOS.');
        refs.accountSection.open = false;
      } catch (e) {
        toast(e.message);
      } finally {
        refs.accountPass.value = '';
        refs.accountSubmit.disabled = false;
        refs.accountSubmit.textContent = 'Sign the amp in';
      }
    });
    refs.accountOut.addEventListener('click', async () => {
      if (!window.confirm('Sign the amp out of HEOS? Presets and internet radio stop working.')) return;
      try {
        applyAccount(await api(`/api/devices/${card.id}/account/signout`, { method: 'POST' }));
      } catch (e) {
        toast(e.message);
      }
    });

    async function act(path, body) {
      try {
        const result = await api(`/api/devices/${card.id}/${path}`, {
          method: 'POST',
          body: JSON.stringify(body)
        });
        setNote(card, '');
        await refresh(card.id);
        return result;
      } catch (e) {
        setNote(card, e.message, true);
        return null;
      }
    }

    refs.power.addEventListener('click', () => {
      const target = card.data && card.data.power === 'on' ? 'off' : 'on';
      refs.power.disabled = true;
      act('power', { state: target }).finally(() => { refs.power.disabled = false; });
    });

    refs.mute.addEventListener('click', () => {
      const target = card.data && card.data.mute ? 'off' : 'on';
      act('mute', { state: target });
    });

    refs.play.addEventListener('click', () => {
      const target = card.data && card.data.playState === 'play' ? 'pause' : 'play';
      act('play', { state: target });
    });
    refs.next.addEventListener('click', () => act('transport', { action: 'next' }));
    refs.prev.addEventListener('click', () => act('transport', { action: 'previous' }));

    function setSliderFill() {
      const min = Number(refs.slider.min) || 0;
      const max = Number(refs.slider.max) || 100;
      const value = Number(refs.slider.value);
      const percent = max > min ? ((value - min) / (max - min)) * 100 : 0;
      refs.slider.style.setProperty('--fill', `${percent}%`);
      refs.volumeValue.textContent = `${Math.round(value)}%`;
    }

    refs.slider.addEventListener('input', setSliderFill);
    refs.slider.addEventListener('change', () => {
      card.sliderActive = false;
      act('volume', { level: Number(refs.slider.value) });
    });
    refs.slider.addEventListener('pointerdown', () => { card.sliderActive = true; });
    refs.slider.addEventListener('pointerup', () => { card.sliderActive = false; });
    refs.slider.addEventListener('pointercancel', () => { card.sliderActive = false; });

    function nudge(delta) {
      const max = Number(refs.slider.max) || 100;
      const current = Number(refs.slider.value) || 0;
      const next = Math.max(0, Math.min(max, current + delta));
      refs.slider.value = String(next);
      setSliderFill();
      act('volume', { level: next });
    }
    refs.volumeUp.addEventListener('click', () => nudge(5));
    refs.volumeDown.addEventListener('click', () => nudge(-5));

    refs.inputs.addEventListener('change', () => {
      if (refs.inputs.value === RADIO_INPUT) {
        if (card.playLastStation) card.playLastStation();
        return;
      }
      act('input', { input: refs.inputs.value });
    });

    refs.streamForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const url = refs.streamInput.value.trim();
      if (!url) return;
      refs.streamButton.disabled = true;
      act('stream', { url }).finally(() => { refs.streamButton.disabled = false; });
    });

    buildTabs(card, device);
    setSliderFill();
    return card;
  }

  // Tabs keep the page to one screen: the amp stays on top, and Remote, Radio
  // and Settings share the space below it (beside it on wide screens).
  const TABS = [
    { id: 'remote', label: '🎛 Controls' },
    { id: 'handset', label: '📟 Remote' },
    { id: 'radio', label: '📻 Radio' },
    { id: 'clock', label: '⏰ Clock' },
    { id: 'settings', label: '⚙ Settings' }
  ];
  const WIDE = window.matchMedia('(min-width: 1000px)');

  function buildTabs(card, device) {
    const refs = card.refs;
    const root = refs.root;
    const head = root.querySelector('.card-head');
    const nowPlaying = root.querySelector('.now-playing');

    const stage = el('div', { class: 'stage' }, [head, card.faceplate && card.faceplate.root, card.faces && card.faces.root, card.visualizer && card.visualizer.root]);

    // ---- editable heading ----
    const nameEl = head.querySelector('h2');
    const roomEl = head.querySelector('.room');
    const editBtn = el('button', { type: 'button', class: 'mini edit-name', 'aria-label': 'Rename', title: 'Rename', text: '✎' });
    nameEl.append(' ', editBtn);
    editBtn.addEventListener('click', () => {
      const nameIn = el('input', { type: 'text', maxlength: '60', value: device.name, 'aria-label': 'Name' });
      const roomIn = el('input', { type: 'text', maxlength: '60', value: device.room || '', placeholder: 'Room or note (optional)', 'aria-label': 'Room' });
      const save = el('button', { type: 'submit', class: 'primary', text: 'Save' });
      const cancel = el('button', { type: 'button', text: 'Cancel' });
      const form = el('form', { class: 'rename-form' }, [nameIn, roomIn, el('div', { class: 'row' }, [save, cancel])]);
      const original = head.firstChild;
      original.replaceWith(form);
      nameIn.focus();
      nameIn.select();
      cancel.addEventListener('click', () => form.replaceWith(original));
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
          const label = await api(`/api/devices/${card.id}/label`, { method: 'POST', body: JSON.stringify({ name: nameIn.value, room: roomIn.value }) });
          device.name = label.name;
          device.room = label.room;
          nameEl.firstChild.textContent = label.name;
          roomEl.textContent = label.room;
          form.replaceWith(original);
        } catch (e) { toast(e.message); }
      });
    });

    // ---- front panel choice: the photo (if added) or a digital face ----
    const FACE_KEY = `soundcontrol.face.${device.id}`;
    const faceSelect = el('select', { 'aria-label': 'Front panel' }, [
      card.faceplate ? el('option', { value: 'photo', text: 'Photo of the amp' }) : null,
      ...(window.Faces ? window.Faces.SKINS.map((s) => el('option', { value: s.id, text: s.label })) : [])
    ]);
    function applyFace(choice) {
      const valid = [...faceSelect.options].some((o) => o.value === choice);
      const pick = valid ? choice : (card.faceplate ? 'photo' : 'neon');
      faceSelect.value = pick;
      if (card.faceplate) card.faceplate.root.hidden = pick !== 'photo';
      if (card.faces) {
        card.faces.root.hidden = pick === 'photo';
        if (pick !== 'photo') card.faces.setSkin(pick);
      }
      try { localStorage.setItem(FACE_KEY, pick); } catch (e) { /* fine */ }
    }
    let savedFace = null;
    try { savedFace = localStorage.getItem(FACE_KEY); } catch (e) { savedFace = null; }
    applyFace(savedFace);
    faceSelect.addEventListener('change', () => applyFace(faceSelect.value));
    const faceSection = el('section', { class: 'section appearance' }, [
      el('div', { class: 'section-label', text: 'Front panel' }),
      el('label', { class: 'row' }, [el('span', { class: 'grow', text: 'Look' }), faceSelect])
    ]);

    refs.radioHint = el('p', { class: 'muted small tab-hint', text: 'Internet radio needs the amp signed in to HEOS: see the Settings tab.', hidden: 'hidden' });
    const panels = {
      remote: el('div', { class: 'tab-panel', role: 'tabpanel' }, [nowPlaying, refs.transport, refs.volume, refs.inputSection]),
      handset: el('div', { class: 'tab-panel', role: 'tabpanel' }),
      radio: el('div', { class: 'tab-panel', role: 'tabpanel' }, [refs.radioHint, refs.radioSection, refs.presetSection, refs.streamForm]),
      settings: el('div', { class: 'tab-panel', role: 'tabpanel' }, [faceSection, refs.accountSection]),
      clock: el('div', { class: 'tab-panel', role: 'tabpanel' })
    };
    refs.accountSection.open = true;

    const storeKey = `soundcontrol.tab.${device.id}`;
    const buttons = {};
    const bar = el('div', { class: 'tabs', role: 'tablist' });
    function select(id) {
      for (const tab of TABS) {
        const active = tab.id === id;
        buttons[tab.id].classList.toggle('active', active);
        buttons[tab.id].setAttribute('aria-selected', String(active));
        buttons[tab.id].tabIndex = active ? 0 : -1;
        panels[tab.id].hidden = !active;
      }
      card.tab = id;
      try { localStorage.setItem(storeKey, id); } catch (e) { /* fine */ }
    }
    TABS.forEach((tab, index) => {
      const [icon, ...words] = tab.label.split(' ');
      const button = el('button', { type: 'button', class: 'tab', role: 'tab', id: `tab-${device.id}-${tab.id}`, dataset: { tab: tab.id } },
        [el('span', { class: 'tab-icon', text: icon }), el('span', { class: 'tab-text', text: words.join(' ') })]);
      panels[tab.id].setAttribute('aria-labelledby', button.id);
      button.addEventListener('click', () => select(tab.id));
      button.addEventListener('keydown', (event) => {
        const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
        if (!step) return;
        const shown = TABS.filter((item) => !buttons[item.id].hidden);
        const position = shown.findIndex((item) => item.id === tab.id);
        const next = shown[(position + step + shown.length) % shown.length].id;
        select(next);
        buttons[next].focus();
      });
      buttons[tab.id] = button;
      bar.append(button);
    });

    const deck = el('div', { class: 'deck' }, [bar, panels.remote, panels.handset, panels.radio, panels.clock, panels.settings, refs.note]);

    // A virtual amp plays internet radio in the page itself.
    if (device.virtual && window.WebRadioPanel) {
      card.webradio = window.WebRadioPanel.create({ device, api, toast, visualizer: card.visualizer, refresh: () => refresh(card.id, { quiet: true }) });
      panels.radio.prepend(card.webradio.section);
      refs.accountSection.hidden = true;
      card.webradio.init();
    }

    // The clock: ghosted over the visualiser, chips under it, its own tab.
    if (window.Clock && !window.__soundcontrolClock) {
      window.__soundcontrolClock = true;
      card.clock = window.Clock.create({ device, api, toast, onOpen: () => select('clock'), getLastStation: card.webradio ? () => card.webradio.lastStation() : null });
      if (card.visualizer) card.clock.mount(card.visualizer.root);
      else stage.append(card.clock.ghost, card.clock.chips);
      panels.clock.append(card.clock.panel);
      panels.settings.append(card.clock.appearance);
    } else {
      buttons.clock.hidden = true;
    }
    root.replaceChildren(stage, deck);
    root.classList.add('tabbed');

    // The handset: its own column beside the amp on wide screens, a tab on phones.
    let handset = null;
    if (device.handset && window.Handset) {
      handset = window.Handset.create({
        post: (path, body) => api(`/api/devices/${card.id}/${path}`, { method: 'POST', body: JSON.stringify(body) }),
        refresh: () => refresh(card.id, { quiet: true }),
        toast,
        local: (what) => {
          if (what === 'internet_radio' && card.playLastStation) card.playLastStation();
          if (what === 'fav_call') {
            select('radio');
            refs.presetSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        }
      });
      root.classList.add('has-handset');
    }
    const handsetCol = el('div', { class: 'handset-col' });
    function placeHandset() {
      const wide = WIDE.matches;
      buttons.handset.hidden = !handset || wide;
      if (handset) (wide ? handsetCol : panels.handset).append(handset.root);
      if (wide && handset) root.prepend(handsetCol); else handsetCol.remove();
      if (buttons.handset.hidden && card.tab === 'handset') select('remote');
    }

    let saved = null;
    try { saved = localStorage.getItem(storeKey); } catch (e) { saved = null; }
    select(TABS.some((tab) => tab.id === saved) ? saved : 'remote');
    placeHandset();
    WIDE.addEventListener('change', placeHandset);
    card.selectTab = select;
  }

  function applyPower(card, data) {
    const power = data.power || 'unknown';
    const label = power === 'on' ? 'On' : power === 'standby' ? 'Standby' : 'Unknown';
    card.refs.badge.textContent = label;
    card.refs.badge.className = `badge ${power === 'on' ? 'on' : power === 'standby' ? 'standby' : 'offline'}`;
    card.refs.power.textContent = power === 'on' ? 'Standby' : 'Turn on';
  }

  function applyNowPlaying(card, nowPlaying) {
    const np = nowPlaying || {};
    const title = np.song || np.station || 'Nothing playing';
    const station = np.station && np.station !== title ? np.station : '';
    const sub = [np.artist, np.album, station].filter(Boolean).join(' · ');
    card.refs.title.textContent = title;
    card.refs.sub.textContent = sub;

    if (np.image_url) {
      card.refs.art.src = np.image_url;
      card.refs.art.hidden = false;
      card.refs.artIcon.hidden = true;
      card.refs.art.onerror = () => {
        card.refs.art.hidden = true;
        card.refs.art.removeAttribute('src');
        card.refs.artIcon.hidden = false;
      };
    } else {
      card.refs.art.hidden = true;
      card.refs.art.removeAttribute('src');
      card.refs.artIcon.hidden = false;
    }
  }

  const RADIO_INPUT = '__radio';

  function applyInputs(card, inputs) {
    const list = (Array.isArray(inputs) ? inputs : []).slice();
    // Internet radio is a HEOS source, not a physical input: offer it here too.
    if (card.account && card.account.signedIn) list.push({ id: RADIO_INPUT, label: '📻 Internet radio' });
    const key = list.map((entry) => `${entry.id}:${entry.label}`).join('|');
    if (key !== card.inputsKey) {
      card.inputsKey = key;
      card.refs.inputs.replaceChildren(...list.map((entry) => el('option', { value: entry.id, text: entry.label })));
    }
    if (list.length > 0) {
      card.refs.inputSection.hidden = false;
      const np = (card.data && card.data.nowPlaying) || {};
      const physical = list.some((entry) => entry.id !== RADIO_INPUT && card.data && entry.id === card.data.input);
      // TuneIn is HEOS source 3; Bluetooth also reports type "station", so check the source.
      if (!physical && Number(np.sid) === 3 && list.some((entry) => entry.id === RADIO_INPUT)) card.refs.inputs.value = RADIO_INPUT;
      else if (card.data && card.data.input) card.refs.inputs.value = card.data.input;
    } else {
      card.refs.inputSection.hidden = true;
    }
  }

  function applyPresets(card, presets) {
    const list = Array.isArray(presets) ? presets : [];
    const key = list.map((entry) => `${entry.id}:${entry.label}`).join('|');
    if (key !== card.presetsKey) {
      card.presetsKey = key;
      card.refs.presets.replaceChildren(...list.map((entry) => el('button', {
        type: 'button',
        text: entry.label,
        onclick: async () => {
          try {
            await api(`/api/devices/${card.id}/preset`, {
              method: 'POST',
              body: JSON.stringify({ preset: entry.id })
            });
            setNote(card, '');
            setTimeout(() => refresh(card.id), 800);
          } catch (e) {
            setNote(card, e.message, true);
          }
        }
      })));
    }
    card.refs.presetSection.hidden = list.length === 0;
  }

  function applyStatus(card, data) {
    card.data = data;
    const caps = data.capabilities || {};

    applyPower(card, data);
    applyNowPlaying(card, data.nowPlaying);
    if (card.faceplate) card.faceplate.update(data);
    if (card.faces) card.faces.update(data);
    if (card.webradio) card.webradio.update(data);
    if (card.clock) card.clock.fillActions(data.inputs);
    if (card.visualizer) card.visualizer.update(data, data.volumeCap);

    card.refs.transport.hidden = !caps.transport;
    card.refs.play.textContent = data.playState === 'play' ? '⏸' : '▶';
    card.refs.play.setAttribute('aria-label', data.playState === 'play' ? 'Pause' : 'Play');
    card.refs.prev.hidden = !caps.transport;
    card.refs.next.hidden = !caps.transport;

    card.refs.volume.hidden = !caps.volume;
    if (caps.volume) {
      const cap = Number(data.volumeCap) || 40;
      card.refs.slider.max = String(cap);
      if (!card.sliderActive) {
        card.refs.slider.value = String(data.volume == null ? 0 : data.volume);
      }
      const min = Number(card.refs.slider.min) || 0;
      const max = Number(card.refs.slider.max) || 100;
      const value = Number(card.refs.slider.value);
      card.refs.slider.style.setProperty('--fill', `${max > min ? ((value - min) / (max - min)) * 100 : 0}%`);
      card.refs.volumeValue.textContent = `${Math.round(value)}%`;
      card.refs.mute.textContent = data.mute ? '🔊' : '🔇';
      card.refs.mute.classList.toggle('active', Boolean(data.mute));
      card.refs.mute.setAttribute('aria-label', data.mute ? 'Unmute' : 'Mute');
    }

    applyInputs(card, data.inputs);
    applyPresets(card, data.presets);

    card.refs.streamForm.hidden = !caps.playStream;
    if (card.showRadio) card.showRadio(Boolean(caps.radio && card.account && card.account.signedIn));
    if (card.refs.radioHint) card.refs.radioHint.hidden = !(card.account && card.account.signedIn === false);
    // Presets and stream URLs only work once the amp is signed in to HEOS.
    if (card.account && card.account.signedIn === false) {
      card.refs.presetSection.hidden = true;
      card.refs.streamForm.hidden = true;
    }

    const anyControl = caps.power || caps.volume || caps.inputs || caps.presets || caps.playStream || caps.transport;
    if (!anyControl) setNote(card, 'This device has no network control yet.');
  }

  async function refresh(id, { quiet = false } = {}) {
    const card = cards.get(id);
    if (!card) return;
    try {
      const data = await api(`/api/devices/${id}/status`);
      const badge = card.refs.badge;
      if (badge.classList.contains('offline')) {
        badge.className = 'badge';
        setNote(card, '');
      }
      applyStatus(card, data);
    } catch (e) {
      if (e.message === 'Session expired') return;
      card.refs.badge.textContent = 'Offline';
      card.refs.badge.className = 'badge offline';
      if (!quiet) setNote(card, e.message, true);
    }
  }

  async function load() {
    try {
      const devices = await api('/api/devices');
      if (!Array.isArray(devices) || devices.length === 0) {
        devicesEl.replaceChildren(el('p', { class: 'muted', text: 'No devices configured. Add one to config/devices.json.' }));
        return;
      }
      devicesEl.replaceChildren();
      for (const device of devices) {
        const card = buildCard(device);
        cards.set(device.id, card);
        devicesEl.append(card.refs.root);
        refresh(device.id, { quiet: true });
        if (card.loadAccount && !device.virtual) card.loadAccount();
      }
    } catch (e) {
      if (e.message === 'Session expired') return;
      devicesEl.replaceChildren(el('p', { class: 'muted', text: `Could not load devices: ${e.message}` }));
    }
  }

  const logout = document.getElementById('logout');
  if (logout) {
    logout.addEventListener('click', async () => {
      try {
        await api('/logout', { method: 'POST' });
      } catch (e) {
        // Redirect anyway; the session is either gone or the page will say so.
      }
      window.location.assign('/login');
    });
  }

  setInterval(() => {
    if (document.hidden) return;
    for (const id of cards.keys()) refresh(id, { quiet: true });
  }, 5000);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      for (const id of cards.keys()) refresh(id, { quiet: true });
    }
  });

  load();
})();
