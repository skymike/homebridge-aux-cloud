# AUX Home Provider Design

## Objective

Add AUX Home as a separate provider to `homebridge-aux-cloud` while preserving the existing AC Freedom cloud and LAN behavior. The provider will authenticate with AUX Home, discover account devices, send normal air-conditioner controls over MQTT, and apply pushed state changes to existing HAP and Matter accessories in real time.

## Scope

The first release supports:

- power;
- target temperature, including half-degree values;
- auto, cool, dry, heat, and fan modes;
- auto, low, medium, high, turbo, and quiet fan settings;
- vertical automatic swing and five fixed vertical positions;
- horizontal swing on and off;
- display, ECO, sleep, and health controls;
- MQTT acknowledgements and unsolicited state updates, including changes made with a physical remote.

The first release does not implement iFavor, Pet Hosting, Sleep Curves, Timers, or Power Limit. Those are separate cloud automations rather than normal device-control fields and require independent protocol work.

## Configuration and Compatibility

Add a provider setting with these values:

- `ac-freedom`: the current implementation and default for backward compatibility;
- `aux-home`: the new REST and MQTT implementation.

Existing configurations without `provider` continue to use AC Freedom. AUX Home uses the existing `username`, `password`, device filtering, exposure, temperature, and feature-switch settings where applicable. Provider-specific validation gives a clear startup error when required credentials are missing.

The existing AC Freedom cloud client, Broadlink LAN control, HAP accessories, and Matter accessories remain behaviorally unchanged.

## Architecture

Introduce a narrow provider interface consumed by the platform. It exposes login/startup, device listing and refresh, parameter updates, state-change subscription, and shutdown. Existing AC Freedom behavior is wrapped by one adapter; AUX Home is implemented by another. Both return the existing normalized `AuxDevice` shape so accessory code does not need to know which cloud is in use.

The AUX Home provider has four focused components:

1. **REST client** — retrieves the server RSA public key, encrypts login fields according to AUX Home 2.3.2, authenticates, stores the token and user ID only in memory, and discovers devices.
2. **MQTT session** — constructs the verified client identity and credentials, connects to the regional AUX Home broker with TLS, subscribes to device state topics, publishes commands, reconnects, and resubscribes.
3. **AUXLink codec** — encodes commands and decodes the direct 25-byte AUXLink state frame. It shares field meanings with the existing Broadlink protocol but has no two-byte LAN envelope.
4. **Provider coordinator** — maps REST device metadata to normalized devices, associates MQTT messages with devices, correlates command acknowledgements by sequence, and emits normalized state updates to the platform.

This separation keeps credentials, transport lifecycle, and binary protocol logic independently testable.

## Data Flow

At startup, the platform selects a provider from configuration. For AUX Home, the REST client logs in and retrieves the account's devices. The coordinator starts MQTT using the authenticated session and subscribes to `dev2app/<device-id>/#` for each discovered device.

When HomeKit or Matter changes a setting, the existing accessory layer produces normalized parameter changes. The provider coordinator merges those changes with the last confirmed device state, encodes a complete AUXLink command, assigns a sequence, and publishes it to `app2dev/<device-id>/#`. The returned promise resolves after a matching acknowledgement or confirmed pushed state.

Inbound messages are routed by topic, decoded, and applied to the normalized device cache. The platform receives a state-change callback and updates both HAP and Matter characteristics immediately. Sequence-zero state frames are accepted as unsolicited physical-remote updates.

Periodic reconciliation remains enabled at a slower interval. It repairs missed messages and supplies degraded operation while MQTT is reconnecting, but MQTT is the primary live-update mechanism.

## Session Lifecycle and Error Handling

REST credentials and tokens remain in memory and are never logged. Authentication failures produce a concise provider-specific error. An expired REST session triggers one controlled re-login and retry; repeated failure is surfaced without an infinite loop.

MQTT uses TLS on port 8883. Disconnects trigger bounded exponential reconnect with jitter. A successful reconnect resubscribes all current devices. Authentication rejection causes REST re-authentication before one fresh MQTT attempt. Shutdown cancels reconnect timers, rejects pending commands, removes listeners, and closes the client cleanly.

Each command has a timeout and a pending-sequence entry. A matching acknowledgement completes it. A negative acknowledgement or timeout rejects it and marks the accessory temporarily faulted through the existing error path. The last confirmed state is retained. Malformed frames, unknown devices, and unrelated topics are ignored with redacted debug logging.

No password, account token, passcode, raw login response, full device-specific topic, or captured identifier may be committed or logged.

## Testing

Development follows test-first red/green/refactor cycles. Tests use synthetic identifiers and deterministic cryptographic fixtures only.

Unit tests cover:

- AUX Home login request encryption and response parsing;
- provider credential and topic construction;
- REST device normalization and filtering;
- every supported AUXLink control encoding;
- whole- and half-degree temperature handling;
- all modes, fan settings, swing positions, and feature bits;
- direct state-frame and unsolicited sequence-zero decoding;
- acknowledgement correlation and timeout;
- MQTT reconnect, token refresh, and resubscription;
- redaction of errors and logs.

A mocked integration test covers login, discovery, MQTT connection, command publication, acknowledgement, and pushed state propagation. Existing AC Freedom, LAN, HAP, and Matter tests remain green.

Before delivery, run the complete Jest suite, lint, TypeScript build, and a live validation against the user's emulator and authorized AUX account. Live secrets and captures remain outside the repository.

## Delivery

Implementation is based on `skymike/homebridge-aux-cloud:main` in branch `agent/aux-home-provider-main`. After automated verification and live testing, push the branch to the user's fork and open a pull request targeting the maintainer's `main` branch only with the user's explicit approval.
