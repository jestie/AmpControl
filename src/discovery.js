const net = require('net');
const http = require('http');

/**
 * Find amplifiers on the home network.
 *
 * WSL in NAT mode (and many containers) cannot hear multicast/broadcast
 * announcements (SSDP, mDNS), but direct connections work. So discovery is
 * unicast: try each brand's control port, then send that protocol's harmless
 * "who are you?" query (read-only; nothing on the device changes).
 *
 *   HEOS 1255   heos://player/get_players      Denon / Marantz (HEOS)
 *   AVR  23     PW?                             Denon / Marantz network control
 *   YXC  80     /YamahaExtendedControl/v1/system/getDeviceInfo   Yamaha MusicCast
 *   eISCP 60128 ECNQSTN                         Onkyo / Pioneer / Integra
 *   BluOS 11000 /SyncStatus                     Bluesound / NAD
 *
 * Only private (home-network) IPv4 addresses are allowed, so the server
 * cannot be used to probe the internet. Scans are admin-only (see api.js).
 */
const DEFAULT_PORTS = { heos: 1255, avr: 23, yamaha: 80, eiscp: 60128, bluos: 11000 };

function isPrivateLan(ip) {
  if (!net.isIPv4(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function parseSubnet(text) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/24$/.exec(String(text || '').trim());
  if (!m || m.slice(1).some((n) => Number(n) > 255)) throw new Error('enter a /24 network, e.g. 192.168.1.0/24');
  const base = `${m[1]}.${m[2]}.${m[3]}`;
  if (!isPrivateLan(`${base}.1`)) throw new Error('only home-network (private) addresses can be scanned');
  return base;
}

function portOpen(host, port, timeout) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeout);
    s.on('connect', () => done(true));
    s.on('timeout', () => done(false));
    s.on('error', () => done(false));
  });
}

function tcpAsk(host, port, payload, { timeout = 1500, until } = {}) {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const s = net.createConnection({ host, port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeout);
    s.on('connect', () => s.write(payload));
    s.on('data', (c) => { buf = Buffer.concat([buf, c]); if (buf.length > 65536 || (until && until(buf))) done(buf); });
    s.on('timeout', () => done(buf));
    s.on('error', () => done(buf));
  });
}

function httpAsk(host, port, path, timeout = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path, timeout }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
      res.on('end', () => resolve(res.statusCode === 200 ? body : ''));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(''));
  });
}

const clean = (s, max = 60) => String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);

// ---- fingerprints (read-only queries) ----
const fingerprint = {
  async heos(host, port) {
    const raw = (await tcpAsk(host, port, 'heos://player/get_players\r\n', { until: (b) => b.includes('\r\n') && b.includes('"heos"') })).toString('utf8');
    const line = raw.split('\r\n').find((l) => l.includes('"heos"'));
    if (!line) return null;
    try {
      const d = JSON.parse(line);
      const p = Array.isArray(d.payload) && d.payload[0] ? d.payload[0] : {};
      const model = clean(p.model);
      const brand = /marantz/i.test(model) ? 'Marantz' : /denon/i.test(model) ? 'Denon' : 'Denon / Marantz';
      return { protocol: 'heos', brand, model, name: clean(p.name) };
    } catch (e) { return null; }
  },
  async avr(host, port) {
    const raw = (await tcpAsk(host, port, 'PW?\r', { until: (b) => b.includes('\r') })).toString('latin1');
    return /^PW(ON|STANDBY)/m.test(raw.replace(/\r/g, '\n')) ? { protocol: 'denon_avr', brand: 'Denon / Marantz', model: '', name: '' } : null;
  },
  async yamaha(host, port) {
    const body = await httpAsk(host, port, '/YamahaExtendedControl/v1/system/getDeviceInfo');
    try {
      const d = JSON.parse(body);
      if (d.response_code !== 0) return null;
      return { protocol: 'yamaha', brand: 'Yamaha', model: clean(d.model_name), name: '' };
    } catch (e) { return null; }
  },
  async eiscp(host, port) {
    const data = Buffer.from('!1ECNQSTN\r', 'ascii');
    const header = Buffer.alloc(16);
    header.write('ISCP', 0, 'ascii'); header.writeUInt32BE(16, 4); header.writeUInt32BE(data.length, 8); header.writeUInt8(1, 12);
    const raw = (await tcpAsk(host, port, Buffer.concat([header, data]), { until: (b) => b.includes('ECN') })).toString('latin1');
    const m = /!1ECN([^/\r\n\x1a]*)\//.exec(raw);
    if (!m && !raw.startsWith('ISCP')) return null;
    const model = clean(m ? m[1] : '');
    const brand = /^(VSX|SC-|VSA|SX-)/i.test(model) ? 'Pioneer' : /^(DRX|DTR|DHC)/i.test(model) ? 'Integra' : 'Onkyo / Pioneer';
    return { protocol: 'onkyo', brand, model, name: '' };
  },
  async bluos(host, port) {
    const body = await httpAsk(host, port, '/SyncStatus');
    if (!/<SyncStatus\b/.test(body)) return null;
    const attr = (k) => (new RegExp(`\\b${k}="([^"]*)"`).exec(body) || [])[1] || '';
    return { protocol: 'bluos', brand: clean(attr('brand')) || 'Bluesound / NAD', model: clean(attr('modelName') || attr('model')), name: clean(attr('name')) };
  }
};

/** Suggested devices.json entry for what was found on one address. */
function suggest(host, found) {
  const by = Object.fromEntries(found.map((f) => [f.protocol, f]));
  const named = found.find((f) => f.name) || {};
  const modelOf = found.find((f) => f.model) || {};
  const base = { name: named.name || modelOf.model || `${found[0].brand} amp`, room: '', host };
  if (by.heos || by.denon_avr) {
    const drivers = [by.heos && 'heos', by.denon_avr && 'denon_avr'].filter(Boolean);
    return { ...base, brand: (by.heos || by.denon_avr).brand, model: modelOf.model || '', drivers, config: { type: drivers[0], host, port: by.heos ? 1255 : 23, drivers, ...(by.denon_avr ? { denon_avr: { host, port: 23, volumeMax: 100, inputs: [] } } : {}) } };
  }
  if (by.yamaha) return { ...base, brand: 'Yamaha', model: by.yamaha.model, drivers: ['yamaha'], config: { drivers: ['yamaha'], yamaha: { host } } };
  if (by.onkyo) return { ...base, brand: by.onkyo.brand, model: by.onkyo.model, drivers: ['onkyo'], config: { drivers: ['onkyo'], onkyo: { host } } };
  if (by.bluos) return { ...base, brand: by.bluos.brand, model: by.bluos.model, drivers: ['bluos'], config: { drivers: ['bluos'], bluos: { host } } };
  return null;
}

/** Check one address: which control ports answer, and what is there. */
async function probe(host, { ports = DEFAULT_PORTS, timeout = 700, allowLoopback = false } = {}) {
  const ip = String(host || '').trim();
  if (!(isPrivateLan(ip) || (allowLoopback && ip === '127.0.0.1'))) throw new Error('enter a home-network IP address, e.g. 192.168.1.40');
  const open = {};
  await Promise.all(Object.entries(ports).map(async ([kind, port]) => { open[kind] = await portOpen(ip, port, timeout); }));
  const found = [];
  for (const [kind, port] of Object.entries(ports)) {
    if (!open[kind]) continue;
    const hit = await fingerprint[kind](ip, port).catch(() => null);
    if (hit) found.push(hit);
  }
  return { host: ip, openPorts: Object.keys(open).filter((k) => open[k]), found, suggestion: found.length ? suggest(ip, found) : null };
}

/** Scan a private /24: quick port checks, then identify what answered. */
class Scanner {
  constructor({ logger, probeFn = probe } = {}) {
    this.logger = logger || { info() {} };
    this.probeFn = probeFn;
    this.job = null;
  }

  start(subnet, { user, ports = DEFAULT_PORTS, concurrency = 32, timeout = 500 } = {}) {
    if (this.job && this.job.state === 'running') throw new Error('a scan is already running');
    const base = parseSubnet(subnet);
    const job = { id: Date.now().toString(36), subnet: `${base}.0/24`, state: 'running', done: 0, total: 254, results: [], startedBy: user, startedAt: new Date().toISOString() };
    this.job = job;
    this.logger.info({ action: 'network_scan_start', subnet: job.subnet, user });
    const hosts = Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`);
    let next = 0;
    const worker = async () => {
      while (next < hosts.length && job.state === 'running') {
        const ip = hosts[next++];
        const anyOpen = (await Promise.all(Object.values(ports).map((p) => portOpen(ip, p, timeout)))).some(Boolean);
        if (anyOpen) {
          const r = await this.probeFn(ip, { ports, timeout: timeout + 300 }).catch(() => null);
          if (r && r.found.length) job.results.push(r);
        }
        job.done += 1;
      }
    };
    Promise.all(Array.from({ length: concurrency }, worker)).then(() => {
      if (job.state === 'running') job.state = 'done';
      job.finishedAt = new Date().toISOString();
      this.logger.info({ action: 'network_scan_done', subnet: job.subnet, found: job.results.length, user });
    });
    return this.status();
  }

  stop() { if (this.job && this.job.state === 'running') this.job.state = 'stopped'; return this.status(); }

  status() {
    if (!this.job) return { state: 'idle' };
    const { id, subnet, state, done, total, results, startedAt, finishedAt } = this.job;
    return { id, subnet, state, done, total, results, startedAt, finishedAt };
  }
}

module.exports = { probe, Scanner, parseSubnet, isPrivateLan, suggest, DEFAULT_PORTS };
