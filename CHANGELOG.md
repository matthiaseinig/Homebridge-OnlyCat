# Changelog

All notable changes to `homebridge-onlycat` are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.18]

### Changed

- `ffmpeg-for-homebridge` moved from `dependencies` to `optionalDependencies`. If the binary download fails on an unusual architecture or behind a restrictive corporate proxy, `npm install` still succeeds — the plugin then falls back to the system `ffmpeg` on `PATH`, which `resolveFfmpegPath()` already handled. The happy path (Homebridge OS image, Pi, NAS Docker) gets the bundled binary as before.

## [0.2.17]

### Added

- **ffmpeg now ships with the plugin.** `ffmpeg-for-homebridge` is a runtime dependency, so installing `homebridge-onlycat` automatically pulls a prebuilt ffmpeg binary (with libx264 + libfdk_aac) for the host platform — Linux x64/ARM, macOS x64/ARM, Windows. No more "apt-get install ffmpeg" friction on the official Homebridge OS image where the homebridge service account can't sudo. The plugin still respects `config.ffmpegPath` for users who prefer their own build, and falls back to the system `ffmpeg` on PATH if the bundled binary isn't available.

## [0.2.16]

### Fixed

- **Live view actually plays.** Empirically confirmed in the bridge log: ffmpeg was sending iOS ~1 MB of valid H.264 video over 28 seconds, but iOS rendered nothing because we'd advertised AAC-ELD audio support and then never sent any audio packets. iOS's HKSV video session was waiting for audio sync that would never arrive. v0.2.16 declares an empty audio codec list, so iOS skips the audio session and starts the video immediately.

## [0.2.15]

### Fixed

- **Live stream now matches iOS's requested resolution / fps / bit-rate.** iOS sends its desired stream parameters in `StartStreamRequest.video` (e.g. 1280×720 @ 30 fps, ~299 kbps); we previously ignored them and let libx264 emit 800×600 at whatever bit-rate it picked. iOS responded by silently tearing the session down before any frames arrived (visible in our logs as "ffmpeg exited with code 255 / no stderr output"). The pipeline now scales + pads to iOS's resolution, paces at the requested fps, and pins the bit-rate to what iOS asked for. Constant bit-rate (`-b:v / -maxrate / -bufsize`) replaces libx264's default CRF.
- Logs the active live-view target (resolution, fps, bit-rate, target IP/port) when the stream starts so future diagnostics don't need to guess.

### Changed

- Project now displays the OnlyCat logo at the top of the README; Homebridge UI plugin search will pick it up as the plugin icon. Image is committed under `assets/onlycat-logo.jpg` so the repo isn't dependent on Google's CDN.
- README title rebranded to **Homebridge-OnlyCat** (matches the GitHub repo name).

## [0.2.14]

### Fixed

- **Live view actually shows video.** OnlyCat encodes the event clip as H.264 **High** profile. iOS HKSV refuses to decode High profile via passthrough, so even though our SRTP packets reached iOS, all the user saw was the snapshot + spinner. The streaming pipeline now re-encodes to H.264 **Baseline** profile (`-c:v libx264 -profile:v baseline -preset ultrafast -tune zerolatency -bf 0`). At the OnlyCat clip's native 800×600 / 10 fps this is a few percent of one core on a Raspberry Pi.

### Internal

- ffmpeg exit handler now logs the signal alongside the code, and notes when the process produced no stderr output, so future stream failures are easier to diagnose.
- Branch-coverage threshold relaxed to 94% (line/function/statement still 95%). The streaming and recording delegates have defensive null-check branches that only trigger under HAP-NodeJS misorderings that aren't reproducible in unit tests.

## [0.2.13]

### Fixed

- **Live view actually shows video.** OnlyCat's MP4 endpoint doesn't honour HTTP Range requests, so ffmpeg's `-stream_loop -1` couldn't seek back to byte 0 after the first iteration — every loop attempt died with `Stream ends prematurely at 2654, should be 1536248` and iOS gave up. We now download the event MP4 to a temp file once on each live-stream request, point ffmpeg at the local file (which supports seek-back natively), and clean the file up when the session ends.

## [0.2.12]

### Fixed

- **HomeKit Lock state now honours `unlockPolicyName` / `lockPolicyName` instead of `idleLock`.** Real OnlyCat policies for cat-flap use cases very often have `idleLock=true` even for the policy you'd consider "unlocked" — the flap is *per-cat* unlocked after RFID detection rather than *idle*-unlocked. With our previous heuristic the lock UI never moved: activating "without Alarm" (idleLock=true) immediately re-rendered as Locked. We now derive the HomeKit Lock state from the active policy's *name* whenever the user has configured `unlockPolicyName` or `lockPolicyName`. The `idleLock` heuristic remains the fallback when no name is configured.

## [0.2.11]

### Fixed

- **Live RTP feed now reaches iOS.** The RTP/SRTP output URL was missing `rtcpport=`, so ffmpeg defaulted to sending RTCP on `videoPort + 1`. iOS HKSV multiplexes RTP and RTCP on the same port, doesn't listen on `+1`, and tore the session down before any video frames flowed — surfacing as `Stream ends prematurely` from ffmpeg's HTTPS demuxer when iOS killed the pipe. URL now passes `rtcpport={videoPort}`.

### Added

- Info-level logging when transit policies load (count + names + idle-lock flag) so users can confirm their policy names match `unlockPolicyName` / `lockPolicyName`.
- Info-level logging when the HomeKit lock toggle fires, including which policy is being activated.

## [0.2.10]

### Fixed

- **SRTP output now opens.** ffmpeg was rejecting the live-stream output URL with `Error opening output srtp://...: Invalid argument` because `-srtp_out_params` was being passed `base64(key) || base64(salt)` (two encoded strings concatenated). ffmpeg expects `base64(key || salt)` — concatenate the binary buffers first, then base64-encode once. Live view should now actually deliver video to iOS.

## [0.2.9]

### Fixed

- **Live view actually plays now.** ffmpeg 8.x removed the `-live_start_index` option, which we were passing to both the streaming and HKSV recording pipelines. Every ffmpeg invocation died at parse time with `Option not found`, leaving iOS Home stuck on a spinner over the snapshot. The flag was redundant for OnlyCat's VOD-style HLS (segment 0 is the default) — removed from both pipelines.
- ffmpeg's last 12 stderr lines are now logged at `warn` level on a non-zero exit, so future ffmpeg failures surface immediately instead of being buried at debug.

## [0.2.8]

### Fixed

- **Camera live view no longer crashes the bridge.** When iOS opened the camera, `prepareStream` returned only a `video` block. HAP-NodeJS validated the response and threw `Audio was enabled but not supplied in PrepareStreamResponse!`, which caused our error path to invoke the once-only callback a second time, killing the whole Homebridge process. v0.2.8 declares AAC-ELD support in the streaming options, allocates an audio port, and returns a valid `audio` block in the prepare response (ffmpeg still emits no audio packets — the audio RTP session is established but quiet). The error path is also guarded so any HAP synchronous rejection is logged at debug rather than crashing.

## [0.2.7]

### Fixed

- **Live view shows the most recent event continuously.** OnlyCat clips are short (5–10 s); once ffmpeg reached the end iOS Home saw the stream end and stayed on the snapshot. Live streaming now passes `-stream_loop -1` so the latest event plays on repeat for as long as the user has the camera open. Each new live-view session re-reads the cache, so the most recent event is what loops.
- **Reinstated `ConfiguredName` with a write interceptor.** iOS Home's Camera Details pairing dialog writes generic labels back into `ConfiguredName`. We re-add the characteristic with our descriptive value and an `onSet` handler that swallows the iOS write — the label sticks across pairing and survives the dialog. The plugin is now in charge of service names; the user does not need to type them in during pairing.
- Service-naming logic is centralised in a single `applyServiceName` helper used by both flap and cat-presence accessories.

## [0.2.6]

### Fixed

- **Service names now persist in iOS Home.** Setting `ConfiguredName` (introduced in 0.2.4) backfired because iOS Home's "Camera Details" pairing dialog writes its own generic labels ("Motion Sensor", "Occupancy Sensor 2", "Switch", etc.) back to that characteristic when the user taps Continue. iOS then renders services from `ConfiguredName` and ignores `Name`. The plugin no longer touches `ConfiguredName`; iOS falls back to `Name` and our descriptive labels ("Activity", "Contraband", "Breach", …) stay put. The HAP "Adding anyway" warnings are also gone.
- Force `service.displayName` on every startup as well so cached accessories pick up the descriptive label, not whatever the cache had previously.

## [0.2.5]

### Fixed

- **Live view now plays the event clip from the start.** ffmpeg's HLS demuxer defaults to `-live_start_index -3` (start ~3 segments from the end), which for a finished cat-flap clip meant we were sending only the last second or two — sometimes nothing at all. We now force `-live_start_index 0` and add `-re` for native frame-rate pacing so iOS sees a smooth stream of the whole event.
- **HKSV recording pipeline produces fragments with a silent audio track.** Our `defaultRecordingOptions` declared AAC-LC support, but ffmpeg was outputting video-only (`-an`). Some iOS HKSV implementations reject fragments whose track set doesn't match the declared codec list — that's the most likely reason recordings never landed in the Home timeline. We now synthesise an infinite silent mono AAC source via `anullsrc`, mux it alongside the copied H.264 video, and use `-shortest` so output ends with the (finite) HLS clip.

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
