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

function loadDevices() {
  const configPath = process.env.DEVICES_CONFIG || path.join(__dirname, '../../config/devices.json');
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

module.exports = { loadDevices, DEFAULT_DEVICES };
