/*
 * Settings → Devices (admins only): list, detect by IP, scan the network,
 * add and remove amplifiers. All checks happen on the server.
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

  const DRIVER_NAMES = {
    heos: 'HEOS', denon_avr: 'Denon/Marantz control', yamaha: 'Yamaha MusicCast', onkyo: 'Onkyo/Pioneer (eISCP)',
    bluos: 'BluOS', virtual: 'Virtual amp'
  };
  const EXPERIMENTAL = new Set(['yamaha', 'onkyo', 'bluos']);

  function create({ api, toast }) {
    const section = el('section', { class: 'section devices-admin', hidden: true });
    const list = el('ul', { class: 'clock-list dev-list' });

    // ---- detect one address ----
    const ip = el('input', { type: 'text', inputmode: 'decimal', placeholder: 'IP address, e.g. 192.168.1.40', 'aria-label': 'Device IP address', maxlength: '15' });
    const detectBtn = el('button', { type: 'submit', class: 'primary', text: 'Detect' });
    const detectForm = el('form', { class: 'row dev-detect' }, [ip, detectBtn]);
    const detectOut = el('div', { class: 'dev-results' });

    // ---- scan ----
    const subnet = el('input', { type: 'text', placeholder: '192.168.1.0/24', 'aria-label': 'Network to scan', maxlength: '18' });
    const scanBtn = el('button', { type: 'submit', text: 'Scan network' });
    const stopBtn = el('button', { type: 'button', text: 'Stop', hidden: true });
    const bar = el('div', { class: 'dev-progress', hidden: true }, [el('span')]);
    const scanState = el('p', { class: 'muted small', text: '' });
    const scanOut = el('div', { class: 'dev-results' });
    const scanForm = el('form', { class: 'row dev-detect' }, [subnet, scanBtn, stopBtn]);

    section.append(
      el('div', { class: 'section-label', text: '🔌 Devices' }),
      list,
      el('details', { class: 'dev-add' }, [
        el('summary', { text: '+ Add a device' }),
        el('p', { class: 'small', text: 'Type the amp\'s IP address and press Detect. SoundControl asks the amp who it is (nothing on the amp changes) and suggests the right setup.' }),
        detectForm, detectOut,
        el('p', { class: 'small', text: 'Don\'t know the address? Scan your network:' }),
        scanForm,
        el('p', { class: 'help-warn small', text: '⚠ A scan connects to every address in the network on the amps\' control ports. Security tools (an IPS, firewall or SIEM) may report it as a port scan. It only looks and changes nothing; only home-network ranges can be scanned.' }),
        bar, scanState, scanOut
      ])
    );

    function suggestionCard(s) {
      const name = el('input', { type: 'text', value: s.name || '', maxlength: '60', 'aria-label': 'Name' });
      const room = el('input', { type: 'text', value: s.room || '', maxlength: '60', placeholder: 'Room (optional)', 'aria-label': 'Room' });
      const cap = el('input', { type: 'number', min: '1', max: '100', value: '40', 'aria-label': 'Volume cap' });
      const experimental = s.drivers.some((d) => EXPERIMENTAL.has(d));
      const add = el('button', { type: 'button', class: 'primary', text: 'Add' });
      add.addEventListener('click', async () => {
        add.disabled = true;
        try {
          await api('/api/devices', { method: 'POST', body: JSON.stringify({ name: name.value, room: room.value, volumeCap: Number(cap.value), host: s.host, config: s.config }) });
          toast(`${name.value} added. Reloading…`);
          setTimeout(() => location.reload(), 900);
        } catch (e) { toast(e.message); add.disabled = false; }
      });
      return el('div', { class: 'dev-card' }, [
        el('div', { class: 'dev-card-head' }, [
          el('strong', { text: s.model && s.model.toLowerCase().startsWith(String(s.brand).toLowerCase()) ? s.model : `${s.brand}${s.model ? ` ${s.model}` : ''}` }),
          el('span', { class: 'muted small', text: ` · ${s.host} · ${s.drivers.map((d) => DRIVER_NAMES[d] || d).join(' + ')}` })
        ]),
        experimental ? el('p', { class: 'small warn-text', text: 'Experimental driver: not yet tested on real hardware. Please report how it works.' }) : null,
        s.drivers.includes('denon_avr') ? el('p', { class: 'muted small', text: 'Inputs start empty: add the input codes your amp accepts in config/devices.json (see docs/DRIVERS.md).' }) : null,
        el('div', { class: 'row dev-fields' }, [name, room, el('label', { class: 'small' }, ['Max volume ', cap, ' %'])]),
        add
      ]);
    }

    function showProbe(target, result) {
      if (result && result.suggestion) target.replaceChildren(suggestionCard(result.suggestion));
      else {
        target.replaceChildren(el('p', { class: 'small', text: result && result.openPorts && result.openPorts.length
          ? 'Something answered, but not as a supported amp. Check the brand is supported and that the amp\'s network control is switched on.'
          : 'No supported amp answered at this address. Check the IP, that the amp is on (or Network Control is "Always On"), and that nothing blocks the connection.' }));
      }
    }

    detectForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      detectBtn.disabled = true;
      detectOut.replaceChildren(el('p', { class: 'muted small', text: 'Asking the device…' }));
      try { showProbe(detectOut, await api('/api/discovery/probe', { method: 'POST', body: JSON.stringify({ host: ip.value.trim() }) })); } catch (err) { detectOut.replaceChildren(el('p', { class: 'small warn-text', text: err.message })); }
      detectBtn.disabled = false;
    });

    let poll = null;
    function renderScan(st) {
      const running = st.state === 'running';
      bar.hidden = st.state === 'idle';
      bar.firstChild.style.width = `${st.total ? Math.round((st.done / st.total) * 100) : 0}%`;
      scanBtn.disabled = running;
      stopBtn.hidden = !running;
      scanState.textContent = st.state === 'idle' ? '' : `${running ? 'Scanning' : st.state === 'stopped' ? 'Stopped' : 'Finished'} ${st.subnet}: ${st.done}/${st.total} addresses, ${st.results.length} amp${st.results.length === 1 ? '' : 's'} found`;
      scanOut.replaceChildren(...(st.results || []).filter((r) => r.suggestion).map((r) => suggestionCard(r.suggestion)));
      if (!running && poll) { clearInterval(poll); poll = null; }
    }
    async function pollScan() { try { renderScan(await api('/api/discovery/scan')); } catch (e) { /* keep trying */ } }
    scanForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!window.confirm('Scan the whole network for amps? Security tools may report this as a port scan.')) return;
      try {
        renderScan(await api('/api/discovery/scan', { method: 'POST', body: JSON.stringify({ subnet: subnet.value.trim() }) }));
        if (!poll) poll = setInterval(pollScan, 1000);
      } catch (err) { toast(err.message); }
    });
    stopBtn.addEventListener('click', async () => { try { renderScan(await api('/api/discovery/scan/stop', { method: 'POST' })); } catch (e) { toast(e.message); } });

    async function load() {
      let session;
      try { session = await api('/api/session'); } catch (e) { return; }
      if (session.role !== 'admin') return;          // the server enforces this too
      section.hidden = false;
      try {
        const data = await api('/api/admin/devices');
        if (!subnet.value && data.subnets[0]) subnet.value = data.subnets[0];
        list.replaceChildren(...data.devices.map((d) => el('li', { class: 'clock-item' }, [
          el('div', { class: 'grow' }, [
            el('div', { text: d.name }),
            el('div', { class: 'muted small', text: [d.room, d.drivers.map((x) => DRIVER_NAMES[x] || x).join(' + '), d.host].filter(Boolean).join(' · ') })
          ]),
          el('button', { type: 'button', class: 'mini', 'aria-label': `Remove ${d.name}`, title: 'Remove', text: '✕', onclick: async () => {
            if (!window.confirm(`Remove "${d.name}" from SoundControl? (The amp itself is not changed.)`)) return;
            try { await api(`/api/devices/${encodeURIComponent(d.id)}`, { method: 'DELETE' }); toast('Removed. Reloading…'); setTimeout(() => location.reload(), 900); } catch (e) { toast(e.message); }
          } })
        ])));
        renderScan(await api('/api/discovery/scan'));
        if ((await api('/api/discovery/scan')).state === 'running' && !poll) poll = setInterval(pollScan, 1000);
      } catch (e) { list.replaceChildren(el('li', { class: 'muted small', text: e.message })); }
    }
    load();
    return { section };
  }

  window.DevicesAdmin = { create };
})();
