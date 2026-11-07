const fs = require('fs');
const path = require('path');
const { loadDevices, saveDevices } = require('./config/devices');
const { isPrivateLan } = require('./discovery');
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

  async reload() {
    await this.close();
    await this.init();
  }

  /** Add a device from the "Add device" screen (admin only, see api.js). */
  async addDevice(input = {}) {
    const { drivers: known } = require('./drivers');
    const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
    const name = clean(input.name, 60);
    if (!name) throw new Error('give the device a name');
    const host = clean(input.host, 15);
    if (!isPrivateLan(host)) throw new Error('the address must be a home-network IP, e.g. 192.168.1.40');
    const config = input.config && typeof input.config === 'object' ? input.config : {};
    const drivers = Array.isArray(config.drivers) ? config.drivers.filter((d) => typeof d === 'string' && known[d]) : [];
    if (!drivers.length || drivers.length > 3) throw new Error('unknown device type');
    const cap = Number(input.volumeCap);
    const volumeCap = Number.isInteger(cap) && cap >= 1 && cap <= 100 ? cap : 40;

    const all = loadDevices();
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'device';
    let id = base;
    for (let i = 2; all.some((d) => d && d.id === id); i += 1) id = `${base}-${i}`;
    if (all.some((d) => d && [d.host, ...drivers.map((t) => d[t] && d[t].host)].includes(host) && d.enabled !== false)) {
      throw new Error('a device with that address is already set up');
    }
    // Only known fields are copied: the browser cannot add anything else to the config.
    const device = { id, name, room: clean(input.room, 60), enabled: true, host, volumeCap, drivers, type: drivers[0] };
    for (const t of drivers) {
      const block = config[t] && typeof config[t] === 'object' ? config[t] : {};
      device[t] = { host };
      if (Number.isInteger(block.port) && block.port > 0 && block.port < 65536) device[t].port = block.port;
      if (t === 'denon_avr') { device[t].volumeMax = 100; device[t].inputs = []; }
    }
    if (drivers.includes('heos')) device.port = 1255;
    saveDevices([...all, device]);
    await this.reload();
    return { id, name };
  }

  async removeDevice(id) {
    const all = loadDevices();
    if (!all.some((d) => d && d.id === id)) throw new Error('device not found');
    saveDevices(all.filter((d) => d && d.id !== id));
    await this.reload();
  }
}

module.exports = new DeviceManager();
module.exports.DeviceManager = DeviceManager;
