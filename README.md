![Logo](admin/junghome-bt-mesh.png)

# ioBroker.junghome-bt-mesh

**Tests:** ![Test and Release](https://github.com/Sven-83/ioBroker.junghome-bt-mesh/workflows/Test%20and%20Release/badge.svg)

## JUNG HOME room thermostats for ioBroker

Reads and controls JUNG HOME Bluetooth room thermostats directly over **Bluetooth Mesh**, without the JUNG HOME gateway.
The adapter reaches the mesh through an **ESPHome Bluetooth proxy** (ESP32 with `bluetooth_proxy: active: true`) in the LAN
and talks to any thermostat that acts as mesh proxy node; the thermostats relay to each other.

Status: early version, tested with one room thermostat (JUNG HOME app 2.3.0, export version 1.1).

### What it does

- Setpoint (5–30 °C in 0.5 °C steps) read and write, confirmed by the thermostat; changes at the wall display arrive within a second (push)
- Room temperature measured by the thermostat (polled, default every 5 minutes)
- Heating output (valve open) and operating mode
- **Boost** with own duration (default 60 min, the device boost lasts only 5 min): raises the setpoint and restores the previous value afterwards, also across adapter restarts. A manual setpoint change ends the boost without restore.
- **Lead sensor** per thermostat: any temperature state (e.g. a Zigbee sensor) can replace the thermostat's value for display and colour. The thermostat still regulates with its own sensor.
- Colour per room (blue = cold, neutral, orange = warm) for floor plans

### Requirements

- js-controller >= 6.0.11, admin >= 7.6.20, Node.js >= 22
- An ESPHome Bluetooth proxy with **active** connections in range of at least one mains powered JUNG HOME device; Ethernet proxies work best
- The JUNG HOME project export (`JungHome.json`): JUNG HOME app → Project → Project handover

### Configuration

| Field | Meaning |
|---|---|
| JUNG HOME project export | Complete content of `JungHome.json`. It holds **all keys of your mesh** and is stored encrypted. |
| Own mesh address | Unicast address of the adapter, outside the range of the app (default `0D01`). Use a different address for every instance or tool. |
| Proxy 1 / Proxy 2 | Host or IP of the ESPHome proxies; proxy 2 is used when proxy 1 fails. |
| API encryption key | `api: encryption: key` of the proxy (base64), empty without encryption. |
| Poll interval | Fallback polling in minutes. |
| Boost duration / setpoint | Duration in minutes and setpoint during a boost. |

### States (per thermostat, `thermostats.<address>`)

| State | Type | Write | Meaning |
|---|---|---|---|
| `setpoint` | number °C | yes | Setpoint, confirmed by the device |
| `temperature` | number °C | no | Lead sensor if set, else thermostat |
| `thermostatTemperature` | number °C | no | Value measured by the thermostat |
| `heating` | boolean | no | Heating output active |
| `mode` | number | no | JUNG operating mode (1 = comfort) |
| `boost` | boolean | yes | Start / stop the boost |
| `boostUntil` | timestamp | no | End of the running boost |
| `leadSensor` | string | yes | Object ID of a temperature state, empty = thermostat |
| `color` | string | no | `#rrggbb` for the floor plan |
| `lastSeen` | timestamp | no | Last message from the thermostat |

`info.connection` is `true` while the mesh connection through a proxy is up; `info.proxy` and `info.rssi` show which proxy is used.

### Security

- The export contains the network, application and device keys. It is only stored in `encryptedNative` and never logged.
- Sequence numbers are reserved in blocks and persisted, so a restart never reuses a number (the mesh would drop such messages as replays).
- The adapter never provisions or reconfigures devices. It only sends Generic Level Set to the setpoint element and Get messages.
- Use API encryption on the ESPHome proxy.

### Credits

Protocol knowledge builds on [junghome-bt-mesh / jhmesh](https://github.com/ernetas/junghome-bt-mesh) (MIT) and the Bluetooth Mesh Protocol specification.
JUNG and JUNG HOME are trademarks of ALBRECHT JUNG GMBH & CO. KG; this project is not affiliated with JUNG.

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->
### 0.0.1 (2026-11-15)

- (Sven-83) initial release

## License

MIT License

Copyright (c) 2026 Sven-83 <276080681+Sven-83@users.noreply.github.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
