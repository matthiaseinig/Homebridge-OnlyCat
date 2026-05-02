# Changelog

All notable changes to `homebridge-onlycat` are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0]

### Added

- **Per-cat presence is now driven by OnlyCat's `getEventSummary` endpoint.** When a flap event starts, the plugin subscribes to its server-computed summary and updates presence only on canonical `TRANSIT` subevents. Peeks, denies, and breaches no longer flip presence — fixing the most common false-positive ("cat looked through the flap → marked outside").
- **`OccupancySensor` "Breach"** on each flap. Fires when the summary reports a `BREACH` action — the lock was engaged but a cat transited anyway. Logs a warning at the same time. Use it to drive a security automation (lights, sirens, notifications).
- **`OccupancySensor` "Blocked"** on each flap. Fires when the summary reports a `DENY` action — the door policy refused a cat. Useful for "unknown cat tried to enter" notifications.
- Typed `getEventSummary` RPC + `eventSummaryUpdate` push event in the API client, with runtime payload validation.

### Changed

- `CatPresenceAccessory` retains the v0.1 raw-direction logic as a fallback for events that do not yet have a summary, so behaviour degrades gracefully when the (still-alpha) summary endpoint is unavailable.

### Notes

- The OnlyCat `getEventSummary` endpoint is flagged as alpha by the vendor. Per their docs, an early `TRANSIT` may be demoted to `PEEK` (or vice versa) as the algorithm processes more frames; the plugin therefore updates presence on every summary push, with the final summary winning when `processedFrameCount === frameCount`.

## [0.1.0]

Initial public release.

### Added

- Dynamic-platform Homebridge plugin (TypeScript) targeting Homebridge 1.8+ and the 2.0 beta line.
- Typed Socket.IO/WebSocket client for `gateway.onlycat.com` with token-in-handshake auth, infinite reconnect, and runtime validation of every push payload.
- Per-flap HomeKit camera accessory exposing:
  - Activity `MotionSensor` (used as the HKSV motion trigger)
  - Contraband `OccupancySensor` (raised on `eventClassification = CONTRABAND`)
  - Human `OccupancySensor` (raised on `eventClassification = HUMAN_ACTIVITY`)
  - `LockMechanism` reflecting the active transit policy's `idleLock`
  - Momentary `Switch` services for remote unlock and reboot
- Per-cat presence accessory (one `OccupancySensor` per known RFID profile), driven by subevent direction.
- Camera surface: snapshot from the latest event's poster frame, live stream via ffmpeg from the latest event's HLS clip, and HomeKit Secure Video recording (HLS → fragmented MP4).

### Notes

- Audio is intentionally disabled — OnlyCat clips do not carry an audio track.
- HKSV pre-buffer length is fixed at zero. The plugin records from motion-detected onwards because OnlyCat does not expose a continuous live feed.
- Production dependency tree at release time: 9 packages, all from the `socket.io-client` family, with no known vulnerabilities.
