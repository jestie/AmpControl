const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');

/**
 * Browser radio for people without a network amp: stations come from the
 * open Radio Browser directory (https://www.radio-browser.info, public domain
 * data), and the audio plays in the page.
 *
 * The server passes the stream through (/api/webradio/stream/:uuid) so the
 * page can analyse the real audio for the visualiser: most stations do not
 * allow cross-origin analysis. To keep that from becoming a way to fetch
 * anything, the server only streams stations it got from the directory (by
 * uuid; the browser never sends a URL), and refuses any address on a private,
 * loopback or link-local network, also after redirects.
 */

const API_HOSTS = ['de1.api.radio-browser.info', 'all.api.radio-browser.info'];
const USER_AGENT = 'SoundControl/1.0 (+https://github.com/jestie/AmpControl)';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GENRES = ['pop', 'rock', 'jazz', 'classical', 'dance', 'chillout', 'lounge', 'ambient', 'electronic', 'hip hop', 'soul', 'blues', 'country', 'reggae', 'metal', 'news', '80s', '90s'];
const MAX_STREAMS = 4;

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (/^f[cd]/.test(lower) || /^fe[89ab]/.test(lower)) return true;     // unique-local, link-local
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true;
}

// DNS lookup that refuses private answers, so a public name cannot point the
// server at the home network.
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family || 4 }];
    const bad = list.find((entry) => isPrivateAddress(entry.address));
    if (bad || list.length === 0) return callback(new Error('blocked: private network address'));
    if (options.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

function fetchFrom(host, path) {
  return new Promise((resolve, reject) => {
    const req = https.get({ host, path, headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, timeout: 8000, lookup: safeLookup }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`directory answered ${res.statusCode}`)); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; if (body.length > 2000000) req.destroy(new Error('directory reply too large')); });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('directory reply was not JSON')); } });
    });
    req.on('timeout', () => req.destroy(new Error('directory timed out')));
    req.on('error', reject);
  });
}

// Try each directory server in turn.
async function getJson(path) {
  let last = null;
  for (const host of API_HOSTS) {
    try { return await fetchFrom(host, path); } catch (e) { last = e; }
  }
  throw last || new Error('directory unavailable');
}

class WebRadio {
  constructor({ fetchJson = getJson, logger } = {}) {
    this.fetchJson = fetchJson;
    this.logger = logger || { info() {}, error() {} };
    this.known = new Map();     // uuid -> station (only these can be streamed)
    this.active = 0;
  }

  static genres() { return GENRES.slice(); }

  _remember(raw) {
    const url = String(raw.url_resolved || raw.url || '');
    if (!/^https?:\/\//i.test(url) || raw.hls === 1 || /\.m3u8(\?|$)/i.test(url)) return null;
    if (!UUID_RE.test(String(raw.stationuuid || ''))) return null;
    const station = {
      uuid: raw.stationuuid,
      name: String(raw.name || 'Radio').trim().slice(0, 120),
      favicon: /^https:\/\//i.test(raw.favicon || '') ? raw.favicon : '',
      tags: String(raw.tags || '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 4),
      country: String(raw.countrycode || '').slice(0, 2),
      codec: String(raw.codec || '').slice(0, 10),
      bitrate: Number(raw.bitrate) || 0
    };
    this.known.set(station.uuid, { ...station, url });
    if (this.known.size > 3000) this.known.delete(this.known.keys().next().value);
    return station;
  }

  async search({ q = '', tag = '', country = '' } = {}) {
    const params = new URLSearchParams({ limit: '40', hidebroken: 'true', order: 'clickcount', reverse: 'true' });
    const name = String(q).replace(/[\r\n]/g, ' ').trim().slice(0, 60);
    const genre = String(tag).trim().toLowerCase();
    if (name) params.set('name', name);
    if (genre) {
      if (!GENRES.includes(genre)) throw new Error('unknown genre');
      params.set('tag', genre);
      params.set('tagExact', 'true');
    }
    if (/^[A-Z]{2}$/.test(country)) params.set('countrycode', country);
    const list = await this.fetchJson(`/json/stations/search?${params}`);
    return (Array.isArray(list) ? list : []).map((s) => this._remember(s)).filter(Boolean);
  }

  async station(uuid) {
    if (!UUID_RE.test(String(uuid))) throw new Error('invalid station');
    if (this.known.has(uuid)) return this.known.get(uuid);
    const list = await this.fetchJson(`/json/stations/byuuid/${uuid}`);
    const station = Array.isArray(list) && list[0] ? this._remember(list[0]) : null;
    if (!station) throw new Error('station not found');
    return this.known.get(uuid);
  }

  /** Pipe the station's audio to the browser, following at most 3 safe redirects. */
  async stream(uuid, req, res) {
    const station = await this.station(uuid);
    if (this.active >= MAX_STREAMS) { res.status(429).json({ error: 'too many streams playing' }); return; }
    this.active += 1;
    let released = false;
    const release = () => { if (!released) { released = true; this.active -= 1; } };

    const open = (url, hops) => {
      let target;
      try { target = new URL(url); } catch (e) { throw new Error('bad stream address'); }
      if (!['http:', 'https:'].includes(target.protocol)) throw new Error('bad stream address');
      if (net.isIP(target.hostname) && isPrivateAddress(target.hostname)) throw new Error('blocked: private network address');
      const lib = target.protocol === 'https:' ? https : http;
      const upstream = lib.get(target, { headers: { 'User-Agent': USER_AGENT, 'Icy-MetaData': '0' }, timeout: 10000, lookup: safeLookup }, (up) => {
        if ([301, 302, 303, 307, 308].includes(up.statusCode) && up.headers.location && hops < 3) {
          up.resume();
          try { open(new URL(up.headers.location, target).toString(), hops + 1); } catch (e) { fail(e); }
          return;
        }
        if (up.statusCode !== 200) { up.resume(); fail(new Error(`station answered ${up.statusCode}`)); return; }
        const type = String(up.headers['content-type'] || '');
        res.status(200);
        res.set({
          'Content-Type': /^(audio|application\/ogg)/i.test(type) ? type.split(';')[0] : 'audio/mpeg',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        });
        up.pipe(res);
        up.on('end', release);
        up.on('error', () => { release(); res.destroy(); });
      });
      upstream.on('timeout', () => upstream.destroy(new Error('station timed out')));
      upstream.on('error', fail);
      req.on('close', () => { upstream.destroy(); release(); });
    };
    const fail = (e) => {
      release();
      if (!res.headersSent) res.status(502).json({ error: e.message });
      else res.destroy();
    };
    try { open(station.url, 0); } catch (e) { fail(e); }
  }
}

module.exports = { WebRadio, isPrivateAddress, GENRES };
