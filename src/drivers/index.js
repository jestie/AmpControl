const HEOSDriver = require('./heos');
const DenonAVRDriver = require('./denon_avr');
const UnsupportedDriver = require('./unsupported');
const VirtualDriver = require('./virtual');

/**
 * Driver registry. Add new protocols here; a device only needs a config entry.
 * Contract: see src/drivers/base.js and docs/DRIVERS.md.
 */
const drivers = {
  heos: HEOSDriver,
  'denon-heos': HEOSDriver,
  denon_avr: DenonAVRDriver,
  marantz: DenonAVRDriver,
  avr: DenonAVRDriver,
  unsupported: UnsupportedDriver,
  virtual: VirtualDriver
};

function createDriver(type, config = {}) {
  const DriverClass = drivers[type];
  if (!DriverClass) throw new Error(`unknown driver type: ${type}`);
  return new DriverClass(config);
}

module.exports = { createDriver, drivers };
