const fs = require('fs');
const path = require('path');

/**
 * ♥ Favourite stations: each signed-in user's own list, kept by SoundControl
 * (data/favourites.json, never in git). Separate from the amp's HEOS
 * Favourites (= presets): this list works for every source, needs no HEOS
 * account, and one person's list never changes another's.
 *
 * Sources:
 *   tunein    - a TuneIn station played through HEOS (mid, optional folder cid)
 *   directory - an open-directory (radio-browser.info) station (uuid)
 *
 * Only what is needed to play a station again is stored: no stream addresses
 * (directory stations are looked up again by uuid), so a list cannot be used
 * to make the server fetch an arbitrary address.
 */

const MAX_PER_USER = 200;
const SAFE_MID = /^[A-Za-z0-9%._~:/+-]{1,128}$/;
const SAFE_CID = /^[A-Za-z0-9%._~:/+-]{1,1500}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const USER_RE = /^[A-Za-z0-9._-]{1,32}$/;

function cleanText(value, max) {
  // Strip control characters; the page always renders these as text.
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanImage(value) {
  const url = String(value || '').trim();
  if (url.length > 500 || !/^https?:\/\/[^\s"'<>]+$/i.test(url)) return '';
  return url;
}

/** Validate a station from the page; returns the stored shape or throws. */
function normalise(input) {
  const item = input && typeof input === 'object' ? input : {};
  const name = cleanText(item.name, 120);
  const image = cleanImage(item.image);
  if (item.source === 'tunein') {
    const mid = String(item.mid || '');
    if (!SAFE_MID.test(mid)) throw new Error('invalid station');
    const cid = item.cid == null || item.cid === '' ? null : String(item.cid);
    if (cid !== null && !SAFE_CID.test(cid)) throw new Error('invalid radio folder');
    return { id: `tunein:${mid}`, source: 'tunein', mid, cid, name: name || 'TuneIn station', image };
  }
  if (item.source === 'directory') {
    const uuid = String(item.uuid || '');
    if (!UUID_RE.test(uuid)) throw new Error('invalid station');
    return { id: `directory:${uuid}`, source: 'directory', uuid, name: name || 'Radio station', image };
  }
  throw new Error('unknown station source');
}

class Favourites {
  constructor({ file, logger, max = MAX_PER_USER } = {}) {
    this.file = file || process.env.FAVOURITES_FILE || path.join(__dirname, '../data/favourites.json');
    this.logger = logger || { info() {}, warn() {} };
    this.max = max;
    this.users = new Map();   // username -> [station]; a Map, so no name can reach Object.prototype
    this.load();
  }

  load() {
    this.users = new Map();
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      return;   // no file yet: everyone starts empty
    }
    const users = data && typeof data.users === 'object' && data.users ? data.users : {};
    for (const [user, list] of Object.entries(users)) {
      if (!USER_RE.test(user) || !Array.isArray(list)) continue;
      const clean = [];
      for (const raw of list.slice(0, this.max)) {
        try {
          const station = normalise(raw);
          if (!clean.some((s) => s.id === station.id)) clean.push({ ...station, addedAt: String(raw.addedAt || '').slice(0, 40) });
        } catch (e) { /* skip a damaged entry rather than lose the list */ }
      }
      this.users.set(user, clean);
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const body = { version: 1, users: Object.fromEntries(this.users) };
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  static checkUser(user) {
    if (typeof user !== 'string' || !USER_RE.test(user)) throw new Error('not signed in');
  }

  list(user) {
    Favourites.checkUser(user);
    return (this.users.get(user) || []).map((s) => ({ ...s }));
  }

  /** Add (or refresh the name/logo of) a station. Returns the new list. */
  add(user, input, now = new Date()) {
    Favourites.checkUser(user);
    const station = normalise(input);
    const list = this.users.get(user) || [];
    const existing = list.find((s) => s.id === station.id);
    if (existing) {
      existing.name = station.name;
      if (station.image) existing.image = station.image;
      if (station.source === 'tunein' && station.cid) existing.cid = station.cid;
    } else {
      if (list.length >= this.max) throw new Error(`you can keep up to ${this.max} favourites: remove one first`);
      list.push({ ...station, addedAt: now.toISOString() });
    }
    this.users.set(user, list);
    this.save();
    return this.list(user);
  }

  remove(user, id) {
    Favourites.checkUser(user);
    const list = this.users.get(user) || [];
    const next = list.filter((s) => s.id !== String(id));
    if (next.length === list.length) throw new Error('not found');
    this.users.set(user, next);
    this.save();
    return this.list(user);
  }

  /** Reorder: ids in the new order. Unknown ids are refused; missing ones keep their place at the end. */
  reorder(user, ids) {
    Favourites.checkUser(user);
    if (!Array.isArray(ids) || ids.length > this.max) throw new Error('invalid order');
    const list = this.users.get(user) || [];
    const byId = new Map(list.map((s) => [s.id, s]));
    const seen = new Set();
    const next = [];
    for (const id of ids) {
      const key = String(id);
      if (!byId.has(key)) throw new Error('invalid order');
      if (seen.has(key)) continue;
      seen.add(key);
      next.push(byId.get(key));
    }
    for (const s of list) if (!seen.has(s.id)) next.push(s);
    this.users.set(user, next);
    this.save();
    return this.list(user);
  }
}

module.exports = { Favourites, normalise, MAX_PER_USER };
