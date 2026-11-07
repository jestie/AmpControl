const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Spotify: play playlists, albums and tracks on a Spotify Connect speaker
 * (such as the amp) through Spotify's Web API.
 *
 * Sign-in uses the Authorization Code flow with PKCE, so only a Client ID is
 * needed (no client secret) and no Spotify password ever touches this app.
 * Tokens stay on the server in data/spotify.json (mode 600, not in git) and
 * are never sent to the browser. Playback control needs Spotify Premium.
 *
 * Spotify only accepts http redirect addresses on the loopback address, so
 * the one-time "Connect" is done from the server's own browser at
 * http://127.0.0.1:<port> (or set SPOTIFY_REDIRECT_URI to an https address).
 */

const ACCOUNTS = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';
const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-read-private'
].join(' ');
const CLIENT_ID_RE = /^[a-f0-9]{32}$/i;
const KINDS = ['playlist', 'album', 'track', 'artist', 'show', 'episode'];

/** Turn a pasted Spotify link or URI into what the player wants. */
function parseLink(input) {
  const text = String(input || '').trim();
  let kind;
  let id;
  const uri = /^spotify:(playlist|album|track|artist|show|episode):([A-Za-z0-9]{10,40})$/.exec(text);
  if (uri) [, kind, id] = uri;
  else {
    let url;
    try { url = new URL(text); } catch (e) { throw new Error('paste a Spotify link, e.g. https://open.spotify.com/playlist/…'); }
    if (!/(^|\.)spotify\.com$/i.test(url.hostname)) throw new Error('that is not a Spotify link');
    const parts = url.pathname.split('/').filter(Boolean).filter((p) => !/^intl-/.test(p));
    const at = parts.findIndex((p) => KINDS.includes(p));
    if (at === -1 || !parts[at + 1] || !/^[A-Za-z0-9]{10,40}$/.test(parts[at + 1])) throw new Error('that Spotify link does not point to a playlist, album or track');
    kind = parts[at];
    id = parts[at + 1];
  }
  const spotifyUri = `spotify:${kind}:${id}`;
  return kind === 'track' || kind === 'episode' ? { kind, id, body: { uris: [spotifyUri] } } : { kind, id, body: { context_uri: spotifyUri } };
}

class Spotify {
  constructor({ file, logger, fetchImpl = globalThis.fetch, port = 8095, https = false } = {}) {
    this.file = file || process.env.SPOTIFY_FILE || path.join(__dirname, '../data/spotify.json');
    this.logger = logger || { info() {}, error() {} };
    this.fetch = fetchImpl;
    this.redirectUri = process.env.SPOTIFY_REDIRECT_URI || `${https ? 'https' : 'http'}://127.0.0.1:${port}/spotify/callback`;
    this.data = {};
    this.load();
  }

  load() {
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {}; } catch (e) { this.data = {}; }
    if (!this.data.clientId && CLIENT_ID_RE.test(process.env.SPOTIFY_CLIENT_ID || '')) this.data.clientId = process.env.SPOTIFY_CLIENT_ID;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  setClientId(clientId) {
    const id = String(clientId || '').trim();
    if (!CLIENT_ID_RE.test(id)) throw new Error('a Spotify Client ID is 32 letters and numbers (from developer.spotify.com)');
    if (id !== this.data.clientId) this.data = { clientId: id };   // a new app means a new sign-in
    this.save();
  }

  disconnect() {
    this.data = { clientId: this.data.clientId };
    this.save();
  }

  get configured() { return Boolean(this.data.clientId); }
  get connected() { return Boolean(this.data.refreshToken); }

  // ---- sign-in (PKCE) ----

  /** Start sign-in: returns the Spotify address and what the session must remember. */
  beginLogin() {
    if (!this.configured) throw new Error('add your Spotify Client ID in Settings first');
    const verifier = crypto.randomBytes(48).toString('base64url');
    const state = crypto.randomBytes(16).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const params = new URLSearchParams({
      client_id: this.data.clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      state,
      scope: SCOPES
    });
    return { url: `${ACCOUNTS}/authorize?${params}`, verifier, state };
  }

  async finishLogin(code, verifier) {
    const tokens = await this._token({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri, client_id: this.data.clientId, code_verifier: verifier });
    this._store(tokens);
  }

  async _token(form) {
    const res = await this.fetch(`${ACCOUNTS}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString()
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Spotify sign-in failed: ${body.error_description || body.error || res.status}`);
    return body;
  }

  _store(tokens) {
    this.data.accessToken = tokens.access_token;
    const seconds = Number.isFinite(Number(tokens.expires_in)) ? Number(tokens.expires_in) : 3600;
    this.data.expiresAt = Date.now() + seconds * 1000 - 60000;
    if (tokens.refresh_token) this.data.refreshToken = tokens.refresh_token;
    this.save();
  }

  async _access() {
    if (!this.connected) throw new Error('Spotify is not connected: connect it in Settings');
    if (this.data.accessToken && Date.now() < this.data.expiresAt) return this.data.accessToken;
    const tokens = await this._token({ grant_type: 'refresh_token', refresh_token: this.data.refreshToken, client_id: this.data.clientId });
    this._store(tokens);
    return this.data.accessToken;
  }

  // ---- Web API ----

  async api(method, pathAndQuery, body) {
    const token = await this._access();
    const res = await this.fetch(`${API}${pathAndQuery}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const reason = data && data.error && (data.error.reason || data.error.message);
      if (res.status === 401) { this.data.accessToken = null; this.save(); }
      if (reason === 'PREMIUM_REQUIRED' || res.status === 403) throw new Error('Spotify says this needs a Premium account');
      if (reason === 'NO_ACTIVE_DEVICE' || res.status === 404) throw new Error('Spotify cannot see that speaker right now: open Spotify once and play something on the amp, then try again');
      throw new Error(`Spotify: ${reason || res.status}`);
    }
    return data;
  }

  async status() {
    if (!this.configured) return { configured: false, connected: false, redirectUri: this.redirectUri };
    if (!this.connected) return { configured: true, connected: false, redirectUri: this.redirectUri };
    try {
      const me = await this.api('GET', '/me');
      return { configured: true, connected: true, redirectUri: this.redirectUri, user: me.display_name || me.id, premium: me.product === 'premium' };
    } catch (e) {
      return { configured: true, connected: true, redirectUri: this.redirectUri, error: e.message };
    }
  }

  async devices() {
    const data = await this.api('GET', '/me/player/devices');
    return (data && data.devices ? data.devices : []).map((d) => ({ id: d.id, name: d.name, type: d.type, active: d.is_active, restricted: d.is_restricted }));
  }

  async playlists() {
    const data = await this.api('GET', '/me/playlists?limit=50');
    return (data && data.items ? data.items : []).filter(Boolean).map((p) => ({
      name: p.name,
      link: `spotify:playlist:${p.id}`,
      tracks: p.tracks ? p.tracks.total : null,
      image: p.images && p.images.length ? p.images[p.images.length - 1].url : ''
    }));
  }

  async play(link, deviceId) {
    const target = parseLink(link);
    if (deviceId !== undefined && deviceId !== null && !/^[A-Za-z0-9]{10,64}$/.test(String(deviceId))) throw new Error('invalid speaker');
    const query = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
    await this.api('PUT', `/me/player/play${query}`, target.body);
    return target;
  }

  async control(action) {
    const map = { play: ['PUT', '/me/player/play'], pause: ['PUT', '/me/player/pause'], next: ['POST', '/me/player/next'], previous: ['POST', '/me/player/previous'] };
    if (!map[action]) throw new Error('unknown action');
    await this.api(map[action][0], map[action][1]);
  }

  async nowPlaying() {
    const data = await this.api('GET', '/me/player');
    if (!data || !data.item) return { playing: false };
    const item = data.item;
    const images = (item.album && item.album.images) || item.images || [];
    return {
      playing: Boolean(data.is_playing),
      title: item.name,
      artist: (item.artists || []).map((a) => a.name).join(', ') || (item.show && item.show.name) || '',
      image: images.length ? images[images.length > 1 ? 1 : 0].url : '',
      device: data.device ? data.device.name : '',
      link: item.external_urls ? item.external_urls.spotify : ''
    };
  }
}

module.exports = { Spotify, parseLink };
