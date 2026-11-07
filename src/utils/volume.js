/**
 * Server-side volume safety. The browser slider is a hint; this is the rule.
 * Values are 0-100 percent of the device's range, capped per device.
 */
function clampVolume(value, cap) {
  const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) {
    throw new Error('volume must be a number');
  }

  const parsedCap = Number(cap);
  const maximum = Number.isFinite(parsedCap) && parsedCap > 0 && parsedCap <= 100 ? parsedCap : 40;
  const level = Math.max(0, Math.min(maximum, Math.round(numeric)));
  return { level, capped: numeric > maximum };
}

/** Only plain http(s) stream URLs; keeps file:// and friends out of the amp. */
function validateStreamUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('stream URL is required');
  if (value.length > 2048) throw new Error('stream URL is too long');
  let url;
  try {
    url = new URL(value);
  } catch (e) {
    throw new Error('stream URL is not valid');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('stream URL must be http or https');
  const service = streamingService(url.hostname);
  if (service) throw new Error(service);
  return url.toString();
}

// Links to music services are web pages, not audio: say what to do instead.
const SERVICES = [
  [/(^|\.)spotify\.com$|(^|\.)spotify\.link$/, 'That is a Spotify link, not an audio stream. Spotify only plays through its own app: open the playlist in Spotify, tap the devices icon and pick your amp (Spotify Connect).'],
  [/(^|\.)(youtube\.com|youtu\.be)$/, 'That is a YouTube link, not an audio stream. YouTube cannot be streamed to the amp from a link; use the YouTube Music app and cast to the amp if it supports it.'],
  [/(^|\.)music\.apple\.com$/, 'That is an Apple Music link, not an audio stream. Use AirPlay from an iPhone, iPad or Mac to play it on the amp.'],
  [/(^|\.)(deezer\.com|deezer\.page\.link)$/, 'That is a Deezer link, not an audio stream. Link Deezer in the HEOS app; then it plays on the amp.'],
  [/(^|\.)tidal\.com$/, 'That is a TIDAL link, not an audio stream. Use TIDAL Connect in the TIDAL app, or link TIDAL in the HEOS app.'],
  [/(^|\.)soundcloud\.com$/, 'That is a SoundCloud link, not an audio stream. Link SoundCloud in the HEOS app; then it plays on the amp.'],
  [/(^|\.)music\.amazon\.[a-z.]+$|(^|\.)amazon\.[a-z.]+$/, 'That is an Amazon Music link, not an audio stream. Link Amazon Music in the HEOS app; then it plays on the amp.']
];
function streamingService(hostname) {
  const host = String(hostname || '').toLowerCase();
  const hit = SERVICES.find(([re]) => re.test(host));
  return hit ? hit[1] : null;
}

module.exports = { clampVolume, validateStreamUrl, streamingService };
