# AUX Home 2.3.2 Runtime Findings

## Status and scope

The AUX Home integration is experimental and limited to EU-region accounts in this release. The implementation is intentionally isolated from the established AC Freedom provider so existing configurations continue to select AC Freedom unless they explicitly set `provider` to `aux-home`.

This note is a privacy-safe implementation summary. It contains no account data, device identifiers, login payloads, session material, captured traffic, or device-specific transport paths.

## Runtime behavior used by the provider

- The provider authenticates, discovers the account's available devices, and normalizes their state for the existing HomeKit and Matter layers.
- Login credentials and derived session material are retained only in process memory. They must not be emitted in logs or committed to the repository.
- MQTT supplies command acknowledgement and live state updates after discovery. A physical remote change is treated as a pushed state update and is applied to HomeKit and Matter without waiting for periodic polling.
- Periodic refresh remains available as reconciliation when a push is missed or while MQTT is unavailable. It is a fallback for state freshness, not the normal live-update path.
- On a disconnected MQTT session, the provider retries with bounded backoff and automatically resubscribes discovered devices after a successful reconnect. Authentication failures receive a controlled re-authentication attempt rather than an unbounded retry loop.

## Supported controls

- Power; whole- and half-degree target temperatures; Auto, Cool, Dry, Heat, and Fan modes.
- Auto, Low, Medium, High, Turbo, and Quiet fan settings.
- Vertical automatic swing and five fixed vertical positions; horizontal swing on and off.
- Display, ECO, sleep, and health controls when their Homebridge feature switches are enabled.

The following account automation features are deferred: iFavor, Pet Hosting, sleep curves, timers, and power-limit settings. They require independent product behavior and are not represented as normal device-control fields in this release.

## Safe operational guidance

Use only the EU region with an AUX Home account and keep credentials in the Homebridge configuration rather than source control. For support, share the plugin version, approximate timing, and a concise error category only. Do not share account details, raw configuration, session values, device identifiers, full transport paths, or packet captures.

## Outstanding validation

Automated coverage validates the provider integration with synthetic data. Authorized live validation against an AUX Home account and a Homebridge test deployment remains outstanding because this workspace does not include an authorized account or test environment. That validation must cover login, discovery, every supported control, physical-remote push updates, and a network disconnect/reconnect cycle before release or publication.
