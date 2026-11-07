const fs = require('fs');
const path = require('path');

/**
 * App version (package.json) and release notes (CHANGELOG.md) for the Help
 * centre. Served to signed-in users only: a version on the login page would
 * be a free fingerprint for attackers.
 */
function parseChangelog(text) {
  const releases = [];
  let current = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const head = /^##\s+\[([^\]]+)\]\s*(?:[-–—]\s*(\d{4}-\d{2}-\d{2}))?/.exec(line);
    if (head) {
      current = { version: head[1], date: head[2] || '', items: [] };
      releases.push(current);
    } else if (current && /^\s*[-*]\s+/.test(line)) {
      current.items.push(line.replace(/^\s*[-*]\s+/, '').trim());
    }
  }
  return releases;
}

function versionInfo(root = path.join(__dirname, '..')) {
  let version = '0.0.0';
  try { version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || version; } catch (e) { /* keep default */ }
  let releases = [];
  try { releases = parseChangelog(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')); } catch (e) { releases = []; }
  return { name: 'SoundControl', version, releases, repo: 'https://github.com/jestie/AmpControl', license: 'MIT' };
}

module.exports = { versionInfo, parseChangelog };
