const fs = require('fs');
const path = require('path');
const { loadDevices } = require('./config/devices');
const { createDriver } = require('./drivers');
const CompositeDriver = require('./drivers/composite');

class DeviceManager {
  constructor() {
    this.labelsFile = process.env.LABELS_FILE || path.join(__dirname, '../data/labels.json');
    this.labels = {};
    this.devices = [];
    this.drivers = new Map();
    this.errors = [];
  }

  _driverConfig(device, type) {
    const base = {
      id: device.id,
      name: device.name,
      room: device.room,
      presets: device.presets
    };
    if (device[type] && typeof device[type] === 'object') {
      return { ...base, ...device, ...device[type] };
    }
    if (type === (device.type || 'heos')) {
      return { ...base, ...device };
    }
    // Secondary protocol without its own block: use driver defaults for the port.
    return { ...base, ...device, port: undefined };
  }

  // Names people give their devices in the app (data/labels.json, not in git).
  _loadLabels() {
    try {
      const data = JSON.parse(fs.readFileSync(this.labelsFile, 'utf8'));
      this.labels = data && typeof data === 'object' ? data : {};
    } catch (e) {
      this.labels = {};
    }
  }

  setLabel(deviceId, { name, room } = {}) {
    if (!this.getDevice(deviceId)) throw new Error('device not found');
    const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
    const label = { name: clean(name, 60), room: clean(room, 60) };
    if (!label.name) throw new Error('give it a name');
    this.labels[deviceId] = label;
    fs.mkdirSync(path.dirname(this.labelsFile), { recursive: true });
    const tmp = `${this.labelsFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.labels, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.labelsFile);
    return label;
  }

  async init() {
    this._loadLabels();
    const devices = loadDevices();
    this.devices = [];
    this.drivers.clear();
    this.errors = [];

    for (const device of devices) {
      if (!device || !device.id || device.enabled === false) continue;

      const types = Array.isArray(device.drivers) && device.drivers.length > 0
        ? [...new Set(device.drivers)]
        : [device.type || 'heos'];

      const entries = [];
      for (const type of types) {
        try {
          const driver = createDriver(type, this._driverConfig(device, type));
          entries.push({ type, driver });
        } catch (e) {
          this.errors.push({ device: device.id, driver: type, error: e.message });
        }
      }

      if (entries.length === 0) {
        this.errors.push({ device: device.id, driver: null, error: 'no usable drivers' });
        continue;
      }

      const composite = new CompositeDriver(device, entries);
      await composite.init();
      this.devices.push(device);
      this.drivers.set(device.id, composite);
    }

    return this;
  }

  /**
   * The amp and remote photos are not in the public repo (they are the
   * maker's images). Offer the faceplate and handset only when the photo
   * has been dropped into public/img/ (see public/img/README.md).
   */
  static artwork(device) {
    const img = (name) => fs.existsSync(path.join(__dirname, '../public/img', name));
    const faceplate = device.faceplate === 'pm7000n' && img('pm7000n-face.png') ? 'pm7000n' : null;
    const handset = device.faceplate === 'pm7000n' && img('rc004pm.png') ? 'rc004pm' : null;
    return { faceplate, handset };
  }

  /** Public device list: never expose hosts, ports or credentials to the browser. */
  getDevices() {
    return this.devices.map((device) => ({
      id: device.id,
      name: (this.labels[device.id] && this.labels[device.id].name) || device.name,
      room: this.labels[device.id] ? this.labels[device.id].room : (device.room || ''),
      ...DeviceManager.artwork(device),
      virtual: (Array.isArray(device.drivers) ? device.drivers : [device.type]).includes('virtual'),
      volumeCap: this.getVolumeCap(device.id)
    }));
  }

  getDevice(deviceId) {
    return this.devices.find((device) => device.id === deviceId) || null;
  }

  getVolumeCap(deviceId) {
    const device = this.getDevice(deviceId);
    const configured = device && device.volumeCap !== undefined ? Number(device.volumeCap) : NaN;
    const fallback = parseInt(process.env.DEFAULT_VOLUME_CAP, 10) || 40;
    return Number.isFinite(configured) ? configured : fallback;
  }

  getDriver(deviceId) {
    return this.drivers.get(deviceId) || null;
  }

  async close() {
    await Promise.allSettled([...this.drivers.values()].map((driver) => driver.close()));
  }
}

module.exports = new DeviceManager();
module.exports.DeviceManager = DeviceManager;
