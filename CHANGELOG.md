# Changelog

All notable changes to `homebridge-onlycat` are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.4]

### Fixed

- **Plugin now subscribes to live event pushes.** The previous releases only called `getDevice { subscribe: true }` after discovery, but never `getDeviceEvents { subscribe: true }`. The OnlyCat gateway therefore stopped delivering `deviceEventUpdate` and `eventUpdate` pushes — events fired in the OnlyCat app would not reach the plugin. As a result the camera tile reported "no event clip available" on every live-view request and HKSV had nothing to record. We now subscribe on startup and re-subscribe on every reconnect.
- **Snapshot pre-population.** The most recent concluded event from `getDeviceEvents` is fed into the event cache on startup, so the camera tile shows the latest poster frame immediately rather than waiting for the next live event.
- **Service names appear in the Home app again.** Restored `ConfiguredName` (removed in 0.2.3) on every service. iOS Home reads `ConfiguredName` over `Name` for service tiles in newer versions, so the previous removal made every service show up as the generic type label ("Motion Sensor", "Occupancy Sensor 2", "Switch"). HAP-NodeJS still logs a cosmetic warning when adding `ConfiguredName` to services that don't list it as required/optional — the characteristic is exposed correctly regardless.

## [0.2.3]

### Fixed

- Remove the `ConfiguredName` characteristic added in 0.2.1. HAP-NodeJS doesn't list it as required/optional on most of the services we use (`MotionSensor`, `OccupancySensor`, `LockMechanism`, `Switch`), so it generated a warning per service at startup. The `Name` characteristic alone is sufficient for service labelling.

## [0.2.2]

### Fixed

- **HKSV recording configuration now declares an audio codec.** Camera attachment was failing on every flap with `CameraRecordingOptions.audio: At least one audio codec configuration must be specified!`. We declare AAC-LC at 24 kHz mono / variable bit-rate; the actual stream remains silent (OnlyCat clips have no audio).

### Added

- `unlockPolicyName` and `lockPolicyName` config options. Set the name of the OnlyCat transit policy to activate when the HomeKit Cat Flap lock is unlocked or locked. Useful when you want a specific behaviour like "No Contraband" on unlock or "All Locked" on lock instead of the auto-pick first-match heuristic. Names are matched case-insensitively. Falls back to the previous heuristic when blank or when the named policy doesn't exist (with a warning).

## [0.2.1]

### Fixed

- **Camera service is now attached by default.** A leftover guard (`enableCamera ?? false`) was preventing the `CameraController` from being wired up on the flap accessory. The camera tile now appears in the Home app and HKSV is reachable.
- Set `accessory.category = CAMERA` so iOS Home groups the flap's sensors and switches under one camera tile, rather than scattering them as individual tiles in the room view.
- Set `ConfiguredName` (in addition to `Name`) on every service so the Home app and Siri pick up clear, predictable labels.
- `StatusFault` is no longer set on `LockMechanism` (HAP doesn't list it as required/optional there). It now reflects the offline state on `MotionSensor` "Activity" and `OccupancySensor` "Online" only — eliminating the warning at startup.

### Added

- `disableCamera` config option for users who specifically don't want the camera service.
- `ffmpegPath` config option to override the resolved ffmpeg binary.

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
