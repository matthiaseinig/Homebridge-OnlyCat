# Changelog

All notable changes to `homebridge-onlycat` are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
