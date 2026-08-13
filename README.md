[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=flat)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
[![npm version](https://badgen.net/npm/v/homebridge-aux-cloud)](https://www.npmjs.com/package/homebridge-aux-cloud)
[![npm](https://badgen.net/npm/dt/homebridge-aux-cloud?label=downloads)](https://www.npmjs.com/package/homebridge-aux-cloud)
[![Donate](https://badgen.net/badge/donate/paypal/yellow)](https://paypal.me/feparrav)

# Homebridge AUX Cloud Platform

Homebridge platform plugin that brings AUX air conditioners and heat pumps into Apple HomeKit.

Supports **three control modes** — an AUX Cloud account is optional:

| Mode | Requires cloud account | How commands are sent |
|------|----------------------|----------------------|
| **LAN-only** | No | Direct UDP to device over local network |
| **Cloud-only** | Yes | AUX Cloud API (same as AC Freedom app) |
| **Cloud + LAN** | Yes | LAN first, cloud as fallback |

This project is a TypeScript port of [maeek/ha-aux-cloud](https://github.com/maeek/ha-aux-cloud) — huge thanks to Maeek & contributors.

---

## Installation

> **Requirements:** Node.js 20.x or 22.x (LTS) and Homebridge 1.7.0 or newer.

```bash
sudo npm install -g homebridge-aux-cloud
```

Beta builds:
```bash
sudo npm install -g homebridge-aux-cloud@beta
```

---

## Configuration

### Mode 1 — LAN-only (no AUX Cloud account required)

Use this mode if your ACs are on your local network and you either don't have an AUX Cloud account or prefer to keep the devices off the internet (e.g., to prevent unwanted firmware updates).

Each device needs its **MAC address** and a **display name**. If the device isn't found via UDP broadcast, add its IP.

```jsonc
{
  "platform": "AuxCloudPlatform",
  "name": "Aux Cloud",
  "localControlEnabled": true,
  "devices": [
    {
      "mac": "c8:f7:42:9c:9c:cc",
      "name": "Living Room AC"
    },
    {
      "mac": "ec:0b:ae:0b:c4:c8",
      "name": "Bedroom AC",
      "ip": "192.168.1.100"
    }
  ]
}
```

- No `username` or `password` needed.
- Commands go directly over UDP — no internet required.
- State is polled locally every `pollInterval` seconds (default 60).
- If a device is unreachable the HomeKit command fails immediately (no cloud retry).

---

### Mode 2 — Cloud-only

Use this mode if your devices are registered in AUX Cloud and you don't need local control.

```jsonc
{
  "platform": "AuxCloudPlatform",
  "name": "Aux Cloud",
  "username": "your@email.com",
  "password": "your-password",
  "region": "eu"
}
```

All devices in your AUX Cloud account are discovered automatically — no `devices` list needed.

---

### Experimental — AUX Home (EU only)

> **Experimental in this release.** Select this provider only for an AUX Home account in the EU region. Existing configurations that omit `provider` continue to use AC Freedom.

```jsonc
{
  "platform": "AuxCloudPlatform",
  "name": "Aux Cloud",
  "provider": "aux-home",
  "region": "eu",
  "username": "your-aux-home-email",
  "password": "your-aux-home-password"
}
```

The plugin keeps the supplied credentials and the resulting session material in process memory only. Do not share your Homebridge configuration, account information, device identifiers, or transport diagnostics in support requests.

#### Supported AUX Home controls

- Power, whole- and half-degree target temperatures, and Auto, Cool, Dry, Heat, and Fan modes.
- Auto, Low, Medium, High, Turbo, and Quiet fan settings.
- Vertical automatic swing and five fixed vertical positions; horizontal swing on or off.
- Display, ECO, sleep, and health switches when enabled with `featureSwitches`.

Account automations are intentionally deferred: iFavor, Pet Hosting, sleep curves, timers, and power-limit settings are not supported by this experimental provider.

#### State updates and reconnects

MQTT is the primary source of live state. Changes from the physical remote are pushed into the HomeKit and Matter accessories without waiting for the normal polling interval. If a pushed update is missed or MQTT is reconnecting, the normal periodic refresh continues as a fallback reconciliation path. A disconnected MQTT session automatically retries with bounded backoff and resubscribes to the account's discovered devices after reconnecting.

#### Troubleshooting AUX Home safely

- Confirm `provider` is `aux-home`, `region` is `eu`, and both `username` and `password` are set in Homebridge.
- After changing credentials or provider settings, restart Homebridge and allow the next periodic refresh while a reconnect is in progress.
- For a login or connectivity problem, record only the time, the provider error class/message, and the installed plugin version. Never attach raw configuration files, login responses, account/session values, device IDs, or MQTT diagnostics containing identifiers.
- If physical-remote changes do not appear promptly, note whether Homebridge later catches up on its periodic refresh; this helps distinguish a live-update connection issue from device-state discovery without exposing private data.

---

### Mode 3 — Cloud + LAN (local-first with cloud fallback)

Use this mode to get the responsiveness of local control while retaining cloud as a backup. Requires both cloud credentials and the `devices` list for devices you want to control locally.

```jsonc
{
  "platform": "AuxCloudPlatform",
  "name": "Aux Cloud",
  "username": "your@email.com",
  "password": "your-password",
  "region": "eu",
  "controlStrategy": "local-first",
  "localControlEnabled": true,
  "devices": [
    {
      "mac": "c8:f7:42:9c:9c:cc",
      "name": "Living Room AC"
    },
    {
      "mac": "ec:0b:ae:a4:65:fb",
      "ip": "192.168.1.101",
      "endpointId": "00000000000000000000ec0baea465fb"
    }
  ]
}
```

- Devices **without** `endpointId` are LAN-only (cloud never attempted).
- Devices **with** `endpointId` use LAN first and fall back to cloud after 3 failures.
- Devices registered in AUX Cloud but **not in the `devices` list** are controlled via cloud only.

---

## Configuration Reference

### Platform options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | string | `"Aux Cloud"` | Platform name shown in Homebridge |
| `username` | string | — | AUX Cloud **email address**. **Not required for LAN-only mode.** See note below about phone numbers. |
| `password` | string | — | AUX Cloud password. **Not required for LAN-only mode.** |
| `provider` | `ac-freedom` / `aux-home` | `ac-freedom` | Cloud service. `aux-home` is experimental and EU-only; omit this option to retain AC Freedom compatibility. |
| `region` | `eu` / `usa` / `cn` | `eu` | AUX Cloud region |
| `controlStrategy` | `cloud-only` / `local-first` | `cloud-only` | Global command routing strategy |
| `localControlEnabled` | boolean | `false` | Enable LAN control and UDP discovery |
| `pollInterval` | integer (30–600) | `60` | State refresh cadence in seconds |
| `temperatureUnit` | `C` / `F` | `C` | Display unit for setpoints and ambient temp |
| `temperatureStep` | `0.5` / `1` | `0.5` | Setpoint increment (0.5 replicates AC Freedom) |
| `featureSwitches` | array | `[]` | Extra HomeKit switches: `screenDisplay`, `mildewProof`, `clean`, `health`, `eco`, `sleep` |
| `expose` | `hap` / `matter` / `both` | `hap` | Platform exposure mode. `hap` = HomeKit only (default). `matter` = Matter only (replaces HAP). `both` = HAP for Apple Home + Matter for Alexa/Google simultaneously. Requires Homebridge 2.x with Matter plugin for `matter` or `both`. |
| `commandRetryCount` | integer (0–5) | `2` | Cloud command retry attempts before failing |
| `commandTimeoutMs` | integer (1000–15000) | `5000` | Per-attempt cloud command timeout in ms |
| `includeDeviceIds` | string[] | `[]` | Only expose these cloud endpoint IDs (empty = all) |
| `excludeDeviceIds` | string[] | `[]` | Hide these cloud endpoint IDs |
| `devices` | array | `[]` | LAN device list (see below) |

> **`commandRetryCount` and `commandTimeoutMs`** apply only to cloud commands. They also determine the *pending guard* duration — the window during which HomeKit poll results are ignored to protect the optimistic UI state after a command. Formula: `commandTimeoutMs × (commandRetryCount + 1) + 3000 ms`. With defaults this is 18 s. Reduce `commandTimeoutMs` or `commandRetryCount` if HomeKit takes too long to reflect command failures.

> **Phone number login:** The AUX Cloud API requires an email address as username. If your account was created with a phone number, you must associate an email address first: open the **AC Freedom** app → Profile → Account Settings → add an email address. Then use that email as `username` in this plugin. See [issue #5](https://github.com/fparrav/homebridge-aux-cloud/issues/5).

### Device options (inside `devices`)

| Option | Required | Description |
|--------|----------|-------------|
| `mac` | Yes | MAC address (`aa:bb:cc:dd:ee:ff`) |
| `name` | For LAN-only | Display name shown in HomeKit |
| `ip` | No | Static IP — use if discovery doesn't find the device |
| `endpointId` | For cloud+LAN | AUX Cloud endpoint ID for this device |
| `controlStrategy` | No | Override per device: `local` or `cloud` |

---

## LAN Control — How It Works

Local control uses the **Broadlink UDP protocol** (used by AC Freedom-compatible devices). The plugin:

1. **Authenticates** — sends an auth packet (command `0x65`) and receives a session key.
2. **Polls state** — sends `getState` (32-byte response) and `getInfo` (48-byte response with ambient temperature) periodically.
3. **Sends commands** — encrypts the AC state payload (AES-128-CBC) and sends it directly to the device via UDP port 80.

**Notes:**
- Devices must be reachable on UDP port 80. If they're on a VLAN or behind a firewall, add a static IP and ensure UDP is allowed.
- Only one UDP session per device is allowed at a time. The plugin manages a persistent session per device.
- `getInfo` (ambient temperature) is sent after every `getState` to keep `CurrentTemperature` updated in HomeKit.

> **⚠️ LAN control may not work on newer devices.** Local LAN control relies on the Broadlink UDP protocol, which may conflict with newer firmware versions. Some newer AC units have updated firmware that blocks or ignores local UDP commands. If your device does not respond to HomeKit commands, try switching to `cloud-only` mode or check for a firmware update in the AC Freedom app. See [makleso6/homebridge-broadlink-heater-cooler](https://github.com/makleso6/homebridge-broadlink-heater-cooler) for more details on this limitation.

### Discovery and static IPs

When `localControlEnabled: true`, the plugin broadcasts a UDP discovery packet at startup. Devices found via broadcast don't need the `ip` field. If a device is on a different subnet or broadcast is blocked, set `ip` explicitly and ensure `localControlEnabled: true`.

---

## Features

- Secure login using the same encrypted flow as the official AUX Cloud mobile app.
- Automatic discovery of families and devices (owned + shared) when using cloud mode.
- HomeKit `HeaterCooler` accessory for AUX air conditioners:
  - Power control (`Active`)
  - Mode selection (Auto / Heat / Cool)
  - Ambient temperature and setpoints in °C or °F with configurable steps
  - Fan speed slider with dedicated Auto switch
  - Dry Mode and Fan Mode switches (mutually exclusive, fall back to Auto when off)
  - Optional switches: screen display, mildew proof, self-clean, health, eco, sleep
- LAN-only devices work with no internet and no AUX Cloud account.
- Cloud + LAN hybrid mode with automatic fallback.
- Fast local polling with configurable interval.

---

## Development

```bash
npm install
npm run build
npm run lint
```

- `npm run watch` — incremental build during development.
- Compiled plugin is in `dist/`. Do not edit it directly.

### Testing LAN communication

A standalone test script is included for verifying LAN connectivity before deploying:

```bash
# Build first
npm run build

# Test auth → SET pwr=1 → GET state → assert pwr=1
node dist/test-lan.js <ip> <mac>
# Example:
node dist/test-lan.js 192.168.1.100 aa:bb:cc:dd:ee:ff
```

This script requires homebridge to be stopped first (only one UDP session per device).

---

## Acknowledgements

- [maeek/ha-aux-cloud](https://github.com/maeek/ha-aux-cloud) – original Home Assistant integration that inspired this port.
- [makleso6/homebridge-broadlink-heater-cooler](https://github.com/makleso6/homebridge-broadlink-heater-cooler) – Broadlink LAN API reference implementation.
- [maekpow](https://github.com/maekpow) – Broadlink protocol reverse engineering and packet captures.
- The Homebridge community for the plugin template and documentation.
- AUX users who provided packet captures and protocol hints in the HA forums/repo.

If you publish derivative work, please retain the upstream attribution. Enjoy keeping your AUX kit in sync with HomeKit!
