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
  return url.toString();
}

module.exports = { clampVolume, validateStreamUrl };
