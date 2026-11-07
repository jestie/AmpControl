/*
 * Help centre: a Help button in the top bar opens a searchable guide.
 * Content is plain data rendered with textContent (no HTML strings), so it
 * stays inside the strict Content Security Policy.
 *
 * Block types: p (paragraph), ul (bullets), steps (numbered), tip, warn,
 * qa ([question, answer] pairs), keys ([key, action] pairs).
 */
(() => {
  'use strict';

  const SECTIONS = [
    { id: 'start', icon: '🚀', title: 'Getting started', body: [
      ['p', 'SoundControl is a remote for your amplifier that runs on your home network. Open it on a phone, tablet or PC, sign in, and control the amp without hunting for the IR remote.'],
      ['ul', [
        'Top: the amp itself (a photo of your amp or one of the digital faces), the waves and the clock.',
        'Below: tabs for Controls, Remote, Radio, Clock and Settings. On a wide screen the remote sits on the left and the tabs on the right.',
        'Every change you make is sent to the amp and read back, so what you see is what the amp is really doing.'
      ]],
      ['p', 'No network amp? SoundControl then runs a virtual amp: internet radio plays on the device you are using, and everything else (faces, speakers, clock, alarms) works the same.'],
      ['p', 'Supported amps: Denon and Marantz (HEOS and network control; tested on a Marantz PM7000N). Experimental, not yet tested on real hardware: Yamaha MusicCast, Onkyo / Pioneer / Integra, and Bluesound / NAD (BluOS). Admins add them in Settings → 🔌 Devices (Detect by IP, or Scan network).'],
      ['tip', 'Press ? or F1 at any time to open this Help. Esc closes it.']
    ] },
    { id: 'controls', icon: '🎛', title: 'Controls tab', body: [
      ['ul', [
        'Power: the Standby / Turn on button next to the device name, or the power button on the front panel.',
        'Volume: drag the slider or use − and +. A maximum (shown as "max 40%") is enforced by the server, so a slip can never blast the room.',
        'Mute: the speaker button beside the volume.',
        'Input: pick a source. Only inputs switched on in the amp\'s own setup work; "📻 Internet radio" plays your last station.',
        'Now playing: song, artist and artwork when the amp reports them, with previous, play/pause and next.'
      ]]
    ] },
    { id: 'panel', icon: '🔊', title: 'Front panel & digital faces', body: [
      ['p', 'The amp at the top is not just a picture: its controls work.'],
      ['ul', [
        'Volume knob: drag right or up to turn it up, use the mouse wheel, or tap the left or right half for one step.',
        'Input knob (photo): tap or drag to step through the inputs.',
        'Power and Source Direct buttons, and the display showing the live state.',
        'Bass, treble and balance are front-panel knobs on the real amp: they cannot be changed over the network.'
      ]],
      ['p', 'Choose the look in Settings → Front panel: the photo of your amp (if added) or one of three digital faces: Neon glass, Retro VU (needle meters) or Minimal pro.'],
      ['p', 'Tap the display in a digital face to cycle through ten equaliser looks: Glow bars, Faders, Halo, Terrain, Capsules, Scope, Mirror, LED, Waterfall and Silk. Your choice is remembered.']
    ] },
    { id: 'remote', icon: '📟', title: 'The remote (handset)', body: [
      ['p', 'A clickable copy of the amp\'s own remote, shown when its photo has been added. Each button does its real job; the little screen above it says what the amp reported.'],
      ['ul', [
        'Confirmed by the amp: power, volume (hold to repeat), mute, Source Direct, input, AUX, Bluetooth, play/pause, skip, stop, sleep (10 to 90 minutes), random, repeat, numbers 1 to 9 (HEOS favourites).',
        '"Sent, check the amp display": arrows, Enter, Back, Setup, Option, Info and Dimmer. The amp does not answer these, so watch its display.',
        'Sources the amp has switched off (USB, CD, Phono...) are tried and the remote tells you if the amp ignored them.',
        'CD buttons, Queue, 0, +10 and Clear explain themselves: they are for a CD player or for typing on the amp.'
      ]],
      ['tip', 'The ☰ button at the top left hides or shows the remote. On a phone it is the 📟 Remote tab.']
    ] },
    { id: 'speakers', icon: '🔈', title: 'Speakers', body: [
      ['ul', [
        'Tap the tab on either side of the amp to slide a pair of speakers out; tap again to put them away.',
        'Tap a speaker to take its grille off, and again to put it back.',
        'The bass cones punch out on the beat and the tweeters flick on cymbals, more as the volume goes up. Nothing moves in standby or when muted.'
      ]]
    ] },
    { id: 'visual', icon: '🌈', title: 'Waves, colours & clock', body: [
      ['ul', [
        'Tap the waves to change the colours (Rainbow, Aurora, M²-Squared, Sunset, Ice). With Settings → Appearance → "Match the visualiser colours", the whole app follows.',
        'Normally the waves follow the amp (playing, volume, standby). With browser radio they follow the real music.',
        '🎤 (top left of the waves) listens through the microphone so the waves follow the music in the room. Sound is analysed on your device only; nothing is recorded or sent. Phones only allow this over HTTPS.',
        'The clock floats over the waves. ⤓ moves it underneath, ⤒ floats it again; Settings can also hide it.'
      ]]
    ] },
    { id: 'radio', icon: '📻', title: 'Radio', body: [
      ['p', 'With a HEOS amp (signed in to HEOS):'],
      ['ul', [
        'Browse TuneIn: Local Radio, Trending, Music genres, Talk, Sports, News, By Location, By Language, Podcasts.',
        'Search finds stations by name. Below the TuneIn results, "More stations · open radio directory" adds stations TuneIn search cannot reach; they also play on the amp.',
        'Search understands common abbreviations, such as ASOT (A State of Trance), ABGT (Group Therapy), DnB and EDM, and genre words like "trance".'
      ]],
      ['p', 'Without an amp (virtual amp): pick a genre or search, and the station plays on this device. The amp\'s power, volume and mute still decide what you hear.'],
      ['ul', [
        'Presets 1 to 6 play your HEOS Favourites. They stay empty until you add favourites (in the HEOS app, or with the remote\'s Favorites Add while a station plays).',
        'The stream box takes direct audio addresses only (for example ending in .mp3 or .aac). Links to Spotify, YouTube or Apple Music are web pages, not audio: the box tells you what to do instead.'
      ]]
    ] },
    { id: 'spotify', icon: '🎵', title: 'Spotify', body: [
      ['p', 'Quickest way, nothing to set up: in the Spotify app, play your music, tap the devices icon and pick your amp (Spotify Connect). SoundControl keeps controlling volume, power and the rest.'],
      ['p', 'Built-in Spotify (Radio tab → 🎵 Spotify) needs Spotify Premium and a free developer key:'],
      ['steps', [
        'At developer.spotify.com/dashboard, log in with your Premium account and create an app.',
        'Redirect URI: copy it exactly from Settings → Spotify. Tick "Web API" and save.',
        'Copy the Client ID into Settings → Spotify and press Save.',
        'On the PC running SoundControl, open it at the 127.0.0.1 address shown (https://127.0.0.1:8443 with HTTPS on), then press Connect Spotify (once). Only admins can connect Spotify.',
        'In the Radio tab, paste a playlist, album or track link, choose the speaker and press Play.'
      ]],
      ['warn', '"Web API" greyed out on Spotify\'s site means the account is not Premium (or Spotify has paused app creation).'],
      ['tip', 'Amp not in the speaker list? Play something to it once from the Spotify app, then press ↻.']
    ] },
    { id: 'clock', icon: '⏰', title: 'Clock: alarms, timers & reminders', body: [
      ['ul', [
        '🌅 Wake-up radio: a time (6:00 by default), days, volume and an on/off switch. The amp switches on, tunes your last station and fades up gently.',
        'Alarms: time, days (none ticked = once), and what happens: a chime, your last radio station, or an input. ▶ tests an alarm straight away.',
        'Timers: quick buttons or any length; "standby when done" makes it a sleep timer.',
        'Reminders: a note and a time. Open pages chime and show a banner; allow desktop notifications for a pop-up too.'
      ]],
      ['p', 'Alarms run on the server, so the amp wakes you even with no browser open. Chimes for timers and reminders need a page open somewhere.']
    ] },
    { id: 'settings', icon: '⚙', title: 'Settings', body: [
      ['ul', [
        'Front panel: photo of your amp, Neon glass, Retro VU or Minimal pro.',
        '🎵 Spotify: setup and connection.',
        'HEOS account: sign the amp in to HEOS to unlock TuneIn radio and favourites. The password goes straight to the amp and is never stored by this app.',
        'Appearance: accent colour (match the visualiser, or classic blue) and clock position.',
        'Rename: tap ✎ next to the device name to change its name and room line; every device sees the new name.',
        '🔌 Devices (admins): add an amp by typing its IP address and pressing Detect; SoundControl asks it who it is (nothing on the amp changes) and suggests the setup. Or scan your network to find amps you don\'t know the address of. Remove a device with ✕.'
      ]],
      ['warn', 'Scanning the network connects to every address on the amps\' control ports. Security tools (an IPS, firewall or SIEM) may report it as a port scan. Use Detect with a known IP when you can.']
    ] },
    { id: 'phone', icon: '📱', title: 'Using it on your phone', body: [
      ['ul', [
        'Open the same address on your phone while on the same home network, and sign in.',
        'If the server runs inside WSL on Windows, phones need a Windows port proxy and firewall rule before they can reach it.',
        'Add it to your home screen from the browser menu for an app-like icon.'
      ]],
      ['p', 'HTTPS: SoundControl encrypts the connection with its own certificate. To stop the browser warning, trust the "SoundControl Local CA" once on each device:'],
      ['steps', [
        'On the server, run "npm run cert" (add the address phones use, e.g. "npm run cert -- 192.168.1.45"), then restart SoundControl.',
        'Copy data/tls/ca.crt to the device. Never share data/tls/ca.key.',
        'Windows: double-click ca.crt → Install Certificate → Current User → "Trusted Root Certification Authorities".',
        'iPhone/iPad: open ca.crt, install the profile, then Settings → General → About → Certificate Trust Settings → switch it on.',
        'Android: Settings → Security → Encryption & credentials → Install a certificate → CA certificate.'
      ]],
      ['tip', 'With HTTPS on, the microphone mode works on phones too. Full guide for every device type: docs/HTTPS.md in the project.'],
      ['warn', 'Keep SoundControl on your home network. Never expose its port to the internet.']
    ] },
    { id: 'trouble', icon: '🛠', title: 'Troubleshooting', body: [
      ['qa', [
        ['The card says Offline.', 'The server cannot reach the amp. Check the amp is on the network and that ports 1255 (HEOS) and 23 (control) are reachable from the server.'],
        ['The amp disappears in standby.', 'On the amp, set Network Control to "Always On".'],
        ['Volume stops at 40%.', 'That is the safety maximum for this device, set in its configuration.'],
        ['An input does nothing.', 'That source is switched off in the amp\'s own setup. Switch it on there first.'],
        ['Radio asks me to sign in.', 'Sign the amp in to HEOS in Settings. Without it, TuneIn and favourites are unavailable.'],
        ['A station will not start.', 'Some stations are offline or use formats the amp cannot play. Try another; the open-directory list shows the format and bitrate.'],
        ['No sound from browser radio.', 'Check the virtual amp is on and not muted, and the device volume is up. If the browser blocked autoplay, tap ▶.'],
        ['Every action fails with 403.', 'The page was open while the server restarted, or the action is admin-only ("only an admin can change this"). Reload, or ask an admin.'],
        ['The browser warns the connection is not private.', 'Trust the SoundControl Local CA on that device (see "Using it on your phone"), or open it once and choose to continue.'],
        ['The waves do not follow my amp\'s music.', 'The music plays on the amp, not in the app. Use 🎤 for the room sound, or browser radio.'],
        ['Spotify says Premium required.', 'Spotify only allows playback control and developer apps for Premium accounts.']
      ]]
    ] },
    { id: 'privacy', icon: '🔒', title: 'Privacy & security', body: [
      ['ul', [
        'Runs on your own computer, on your home network. No account with us, no tracking.',
        'App passwords are stored hashed (bcrypt). After five wrong passwords, signing in is paused for 15 minutes.',
        'The HEOS password is sent to the amp only. Spotify sign-in stores tokens on the server only, never in the browser.',
        'The microphone mode analyses sound on your device; nothing is recorded or sent.',
        'Browser radio passes through the server only for stations from the open directory, and never to addresses inside your home network.',
        'The version number is only shown after signing in.',
        'The connection is HTTPS (when set up with npm run cert); plain HTTP only redirects to it. Session cookies are Secure and HSTS is on.',
        'Admins manage account-level settings (Spotify, HEOS account, names); regular users control the amp, radio and clock.',
        'Commands to the amp are checked so a field cannot slip in an extra command, and error messages never show device addresses.'
      ]],
      ['warn', 'The amp\'s own network protocols are not encrypted: the link between the server and the amp (including the HEOS sign-in) stays plain on your home network. Keep the amp and server on a network you trust.']
    ] },
    { id: 'keys', icon: '⌨', title: 'Keyboard shortcuts', body: [
      ['keys', [
        ['? or F1', 'Open Help'],
        ['Esc', 'Close Help or a dialog'],
        ['← →', 'Move between tabs (when a tab has focus)'],
        ['↑ ↓ ← →  PgUp PgDn', 'Turn a volume knob or dial that has focus'],
        ['Enter / Space', 'Next equaliser look, next input, or change the waves\' colours (when focused)']
      ]]
    ] },
    { id: 'new', icon: '✨', title: 'What\'s new', body: [] },
    { id: 'about', icon: 'ℹ', title: 'About', body: [] }
  ];

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function renderBlock([type, data]) {
    if (type === 'p') return el('p', '', data);
    if (type === 'tip') return el('p', 'help-tip', `💡 ${data}`);
    if (type === 'warn') return el('p', 'help-warn', `⚠ ${data}`);
    if (type === 'ul' || type === 'steps') {
      const list = el(type === 'ul' ? 'ul' : 'ol', type === 'steps' ? 'help-steps' : '');
      data.forEach((item) => list.append(el('li', '', item)));
      return list;
    }
    if (type === 'qa') {
      const box = el('div', 'help-qa');
      data.forEach(([q, a]) => {
        const d = el('details');
        d.append(el('summary', '', q), el('p', '', a));
        box.append(d);
      });
      return box;
    }
    if (type === 'keys') {
      const table = el('table', 'help-keys');
      data.forEach(([k, action]) => {
        const tr = el('tr');
        const td = el('td');
        td.append(el('kbd', '', k));
        tr.append(td, el('td', '', action));
        table.append(tr);
      });
      return table;
    }
    return el('p', '', String(data));
  }

  function textOf(section) {
    return [section.title, ...section.body.map(([, d]) => (Array.isArray(d) ? d.flat().join(' ') : d))].join(' ').toLowerCase();
  }

  function create({ api, toast }) {
    let info = null;

    const overlay = el('div', 'help-overlay');
    overlay.hidden = true;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Help');
    const panel = el('div', 'help-panel');
    const search = el('input', 'help-search');
    search.type = 'search';
    search.placeholder = 'Search help, e.g. alarm, Spotify, offline';
    search.setAttribute('aria-label', 'Search help');
    const close = el('button', 'help-close', '✕');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close help');
    const version = el('span', 'help-version', '');
    const head = el('div', 'help-head');
    const title = el('div', 'help-title');
    title.append(el('strong', '', 'Help'), version);
    head.append(title, search, close);
    const nav = el('nav', 'help-nav');
    const content = el('div', 'help-content');
    const empty = el('p', 'help-empty', 'No help matches that search.');
    empty.hidden = true;
    const body = el('div', 'help-body');
    body.append(nav, content);
    panel.append(head, body);
    overlay.append(panel);
    document.body.append(overlay);

    const navButtons = {};
    const blocks = {};
    for (const section of SECTIONS) {
      const b = el('button', 'help-nav-item');
      b.type = 'button';
      b.append(el('span', 'help-nav-icon', section.icon), el('span', '', section.title));
      b.addEventListener('click', () => {
        blocks[section.id].scrollIntoView({ behavior: 'smooth', block: 'start' });
        setActive(section.id);
      });
      navButtons[section.id] = b;
      nav.append(b);
      const s = el('section', 'help-section');
      s.id = `help-${section.id}`;
      s.append(el('h2', '', `${section.icon}  ${section.title}`));
      section.body.forEach((block) => s.append(renderBlock(block)));
      blocks[section.id] = s;
      content.append(s);
    }
    content.append(empty);

    function setActive(id) {
      Object.entries(navButtons).forEach(([k, b]) => b.classList.toggle('active', k === id));
    }

    function fillVersion() {
      if (!info) return;
      version.textContent = `v${info.version}`;
      const news = blocks.new;
      news.replaceChildren(el('h2', '', '✨  What\'s new'));
      (info.releases || []).slice(0, 6).forEach((rel, i) => {
        const box = el(i === 0 ? 'div' : 'details', 'help-release');
        const label = `v${rel.version}${rel.date ? `  ·  ${rel.date}` : ''}${i === 0 ? '  ·  this version' : ''}`;
        box.append(el(i === 0 ? 'h3' : 'summary', '', label));
        const ul = el('ul');
        rel.items.forEach((item) => ul.append(el('li', '', item)));
        box.append(ul);
        news.append(box);
      });
      const about = blocks.about;
      about.replaceChildren(el('h2', '', 'ℹ  About'));
      const p = el('p');
      p.append(el('strong', '', `${info.name} v${info.version}`), document.createTextNode(` · ${info.license} licence · `));
      const link = el('a', '', 'Source code on GitHub');
      link.href = info.repo;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      p.append(link);
      about.append(p,
        el('p', '', 'A self-hosted web remote for network amplifiers, with a virtual amp for people without one.'),
        el('p', 'help-muted', 'Not affiliated with or endorsed by Marantz, Denon, HEOS, TuneIn or Spotify. Product names are used only to say what this works with. Internet radio stations come from the open Radio Browser directory (radio-browser.info).'));
      // Show the version in the top bar too.
      const brand = document.querySelector('.topbar .brand .muted');
      if (brand && !brand.dataset.version) {
        brand.dataset.version = '1';
        brand.append(el('span', 'app-version', `  ·  v${info.version}`));
      }
    }

    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      let shown = 0;
      for (const section of SECTIONS) {
        const hit = !q || textOf(section).includes(q) || (blocks[section.id].textContent || '').toLowerCase().includes(q);
        blocks[section.id].hidden = !hit;
        navButtons[section.id].hidden = !hit;
        if (hit) shown += 1;
      }
      empty.hidden = shown > 0;
    });

    // Highlight the section in view.
    content.addEventListener('scroll', () => {
      const top = content.getBoundingClientRect().top;
      let current = SECTIONS[0].id;
      for (const section of SECTIONS) {
        const b = blocks[section.id];
        if (!b.hidden && b.getBoundingClientRect().top - top < 80) current = section.id;
      }
      setActive(current);
    });

    let lastFocus = null;
    function open(sectionId) {
      lastFocus = document.activeElement;
      overlay.hidden = false;
      document.body.classList.add('help-open');
      if (sectionId && blocks[sectionId]) blocks[sectionId].scrollIntoView({ block: 'start' });
      setTimeout(() => search.focus(), 30);
    }
    function hide() {
      overlay.hidden = true;
      document.body.classList.remove('help-open');
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }
    close.addEventListener('click', hide);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) hide(); });
    document.addEventListener('keydown', (e) => {
      if (!overlay.hidden && e.key === 'Escape') { e.preventDefault(); hide(); return; }
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '') || (e.target && e.target.isContentEditable);
      if (overlay.hidden && (e.key === 'F1' || (e.key === '?' && !typing))) { e.preventDefault(); open(); }
    });

    // Top-bar button, before "Log out".
    const button = el('button', 'help-button ghost');
    button.type = 'button';
    button.append(el('span', 'help-q', '?'), el('span', 'help-label', 'Help'));
    button.setAttribute('aria-label', 'Help');
    button.title = 'Help (? or F1)';
    button.addEventListener('click', () => open());
    const logout = document.getElementById('logout');
    if (logout) logout.before(button);

    api('/api/version').then((v) => { info = v; fillVersion(); }).catch(() => { /* help still works */ });

    return { open };
  }

  window.HelpCentre = { create };
})();
