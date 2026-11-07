# Writing a driver

A driver talks one protocol to one device. It lives in `src/drivers/`, extends
`BaseDriver` and is registered in `src/drivers/index.js`. Nothing in the UI or
the API is device-specific: adding a device should be a config entry plus (at
most) a new driver.

## The contract

Implement only what the protocol can really do, and say so in `capabilities()`.
The API refuses actions a device does not advertise, and the UI hides them.

| Capability  | Method(s)                                            | Notes |
|-------------|------------------------------------------------------|-------|
| `power`     | `getPowerState()`, `powerOn()`, `powerOff()`         | `getPowerState` returns `on`, `standby` or `unknown`. |
| `volume`    | `getVolume()`, `setVolume(percent)`                  | 0-100 percent, not raw device units. |
| `mute`      | `getMute()`, `mute()`, `unmute()`                    | |
| `inputs`    | `getInputs()`, `getInput()`, `setInput(id)`          | `getInputs()` is sync and returns `[{id, label}]`. |
| `presets`   | `getPresets()`, `playPreset(id)`                     | `getPresets()` is sync and returns `[{id, label}]`. |
| `playStream`| `playStream(url)`                                    | URL is validated by the API (http/https only). Only resolve `true` once playback has actually started; throw a clear error if the device accepts the URL and does nothing. |
| `transport` | `getPlayState()`, `setPlayState(state)`, `next()`, `previous()` | state is `play`, `pause` or `stop`; `playPause()` is optional. |
| `nowPlaying`| `getNowPlaying()`                                    | Returned as-is to the UI; use `song`, `artist`, `album`, `station`, `image_url` where available. |

Also implement:

- `async init()` - connect or validate reachability. Return `true`/`false`;
  never throw on startup, the app must start with a device offline.
- `async close()` - release sockets/timers.
- `async getStatus()` - return the fields you can read. Missing values are
  fine (`null`/`unknown`); the composite driver handles failures.
- `capabilities()` - a boolean per capability above.

## Adding a driver

```js
// src/drivers/my_protocol.js
const BaseDriver = require('./base');

class MyProtocolDriver extends BaseDriver {
  constructor(config = {}) {
    super(config);
    this.host = config.host;
    this.port = config.port || 1234;
  }

  async init() { /* prove it answers, return boolean */ return true; }

  async getStatus() {
    return { power: 'on', volume: 15, mute: false };
  }

  async getPowerState() { return 'on'; }
  async powerOn() { /* send command */ }
  async powerOff() { /* send command */ }

  async getVolume() { return 15; }
  async setVolume(percent) { /* convert 0-100 to device units */ }

  async getMute() { return false; }
  async mute() {}
  async unmute() {}

  capabilities() {
    return {
      power: true, volume: true, mute: true, inputs: false,
      presets: false, playStream: false, transport: false, nowPlaying: false
    };
  }
}

module.exports = MyProtocolDriver;
```

Register it:

```js
// src/drivers/index.js
const MyProtocolDriver = require('./my_protocol');
const drivers = { /* existing */ my_device: MyProtocolDriver };
```

## Devices are configuration

`config/devices.json` (copy `config/devices.json.example`):

```json
{
  "id": "living-room",
  "name": "Living room speaker",
  "room": "Living room",
  "enabled": true,
  "volumeCap": 35,
  "drivers": ["my_device"],
  "my_device": { "host": "device.example.lan", "port": 1234 }
}
```

- `id` is stable and used in URLs and the activity log.
- `drivers` lists protocol drivers for one physical device. The first is the
  default; each may have its own block (`"my_device": {...}`) that overrides
  the top-level `host`/`port`.
- `precedence` optionally overrides which driver handles a capability, e.g.
  `{"volume": ["my_device", "other_protocol"]}`. Without it, AVR-style drivers
  win power/volume/mute/inputs and HEOS-style drivers win playback.
- Use hostnames, not IPs, wherever the network has names for the device.
- `volumeCap` is enforced server-side for that device (0-100).

## Other brands (experimental)

These drivers are written from each maker's published control protocol and
tested against fake devices in `tests/basic.test.js`. They have **not yet been
confirmed on real hardware**: if you own one, please try it and report back.

### Yamaha MusicCast — `yamaha` (alias `musiccast`)
Yamaha Extended Control (HTTP/JSON, port 80). Power, volume (scaled to the
model's own maximum), mute, inputs (discovered from the device with their
names), play/pause/skip and now playing for network sources, presets 1-40.

```json
{ "id": "lounge", "name": "Lounge receiver", "drivers": ["yamaha"],
  "yamaha": { "host": "192.0.2.20", "zone": "main" }, "volumeCap": 40 }
```
Optional: `"zone": "zone2"`, `"inputs": [{"id": "hdmi1", "label": "TV"}]` to
limit the list, `"presets": [{"id": 1, "label": "Jazz"}]`.

### Onkyo / Pioneer (2016+) / Integra — `onkyo` (aliases `pioneer`, `integra`, `eiscp`)
eISCP over TCP 60128. Power, volume, mute, inputs, play/pause/skip and now
playing on the network input. Network Control / "Network Standby" must be on.

```json
{ "id": "den", "name": "Den receiver", "drivers": ["onkyo"],
  "onkyo": { "host": "192.0.2.21", "volumeMax": 80,
             "inputs": [{"id": "10", "label": "BD/DVD"}, {"id": "2B", "label": "Network"}, {"id": "2E", "label": "Bluetooth"}] },
  "volumeCap": 40 }
```
`volumeMax` is the receiver's top volume step in the protocol (most use 80;
some 100 or 200). Input ids are the two-character `SLI` codes (e.g. `23` CD,
`22` Phono, `24` FM, `29` USB). Without `inputs` a common default list is used.

### Bluesound / NAD (BluOS) — `bluos` (aliases `bluesound`, `nad`)
BluOS HTTP API (port 11000). Volume, mute, play/pause/skip, now playing,
BluOS presets (read from the player) and playing stream addresses, so the
open-directory radio stations play on it. BluOS has no standby command in
this API, so the power button is not shown.

```json
{ "id": "kitchen", "name": "Kitchen Node", "drivers": ["bluos"],
  "bluos": { "host": "192.0.2.22" }, "volumeCap": 40 }
```

Album art served by the device itself is not passed to the browser (that
would reveal the device's address); public https artwork is.

## Multi-protocol devices

The Marantz PM7000N uses two:

```json
{
  "id": "marantz-office",
  "type": "heos",
  "host": "marantz-pm7000n.example.lan",
  "port": 1255,
  "volumeCap": 40,
  "drivers": ["heos", "denon_avr"],
  "denon_avr": { "host": "marantz-pm7000n.example.lan", "port": 23, "volumeMax": 100, "inputs": [] }
}
```

HEOS handles playback/now playing/presets; the AVR protocol handles power,
hardware volume/mute and physical inputs. The composite driver in
`src/drivers/composite.js` merges them and falls back if one is unreachable.

PM7000N notes from the hardware check (2026-10-25, HEOS 3.139.173):

- Raw `MV` equals the HEOS volume level 1:1, so `volumeMax` is `100`; app
  percent and the amp's own number are the same.
- Only `ANALOG1` and `BT` accepted `SI` input codes on this unit. Standard
  codes for CD/PHONO/OPT/COAX/NET/USB were ignored. Enable a source on the amp
  before advertising it in `inputs`.
- `browse/play_stream` can answer `success` without starting playback when HEOS
  online services are unavailable. The HEOS driver waits for a real `play` or
  `pause` state and otherwise throws, so the API does not claim a false success.
- Cloud presets (`play_preset`) require a HEOS account signed in on the amp.

## Testing a driver without the device

`tests/basic.test.js` uses plain fake driver objects; no network or hardware is
touched. Add cases for any new parsing/conversion logic (raw units to percent,
reply parsing, error handling) there.
