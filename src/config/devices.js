const fs = require('fs');
const path = require('path');

// With no config/devices.json (a fresh clone), start with a virtual amp so the
// app works out of the box: browser radio, faces, clock, alarms.
const DEFAULT_DEVICES = [{
  id: 'virtual',
  name: 'SoundControl One',
  room: 'Virtual amp: plays on this device',
  type: 'virtual',
  drivers: ['virtual'],
  volumeCap: 60
}];

const configPath = () => process.env.DEVICES_CONFIG || path.join(__dirname, '../../config/devices.json');

/** Write the device list (keeps a timestamped backup of the previous file). */
function saveDevices(devices) {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(devices, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function loadDevices() {
  const configPath = module.exports.configPath();
  let data;
  try {
    data = fs.readFileSync(configPath, 'utf8');
  } catch (e) {
    return e.code === 'ENOENT' ? DEFAULT_DEVICES.map((d) => ({ ...d })) : [];
  }
  try {
    return JSON.parse(data);
  } catch (e) {
    return [];
  }
}

module.exports = { loadDevices, saveDevices, configPath, DEFAULT_DEVICES };
