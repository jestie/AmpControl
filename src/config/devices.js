const fs = require('fs');
const path = require('path');

function loadDevices() {
  const configPath = process.env.DEVICES_CONFIG || path.join(__dirname, '../../config/devices.json');
  try {
    const data = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return [];
  }
}

module.exports = { loadDevices };
