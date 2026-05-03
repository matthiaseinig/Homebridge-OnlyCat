# Architecture

This document describes the internal design of `homebridge-onlycat`. End-user documentation lives in [`README.md`](../README.md); the OnlyCat wire protocol is documented separately in [`PROTOCOL.md`](PROTOCOL.md); the HomeKit accessory mapping is in [`ACCESSORIES.md`](ACCESSORIES.md).

## Big picture

```
┌─────────────────────┐  HAP   ┌──────────────────────────┐  WSS   ┌─────────────────┐
│  Apple Home / iOS   │ <───── │   homebridge-onlycat     │ ─────> │ OnlyCat gateway │
│  (HomeKit hub)      │ ─────> │   (this plugin, Node)    │ <───── │ gateway.onlycat │
└─────────────────────┘        └──────────────────────────┘        └─────────────────┘
                                          │
                                          ▼
                                    ffmpeg (camera, HKSV)
```

The plugin is a Homebridge **dynamic platform**. On startup it opens a single Socket.IO/WebSocket connection to OnlyCat's gateway and uses that one connection for the lifetime of the process - no polling, no per-accessory connections.

## Runtime layout

```
┌────────────────────────────────────────────────┐
│              OnlyCatPlatform                   │
│  (entry, lifecycle, accessory cache)           │
└─────┬──────────────────────────────────────────┘
      │
      ├─ OnlyCatClient (Socket.IO, typed RPCs)
      │
      ├─ FlapAccessory[]      (one per device)
      │    ├─ Camera + HKSV (StreamingDelegate / RecordingDelegate)
      │    ├─ MotionSensor (event activity)
      │    ├─ OccupancySensor (contraband)
      │    ├─ OccupancySensor (human activity)
      │    ├─ LockMechanism (door policy)
      │    └─ Switch (remote unlock, reboot)
      │
      └─ CatPresenceAccessory[] (one per RFID profile)
           └─ OccupancySensor (cat is home)
```

## Data flow: a typical event

1. A cat triggers the flap.
2. OnlyCat publishes `deviceEventUpdate` on the WebSocket. The plugin matches the event to a `FlapAccessory` and:
    - Sets `MotionSensor.MotionDetected = true`
    - Decides if the event is contraband / human / clear and updates the corresponding `OccupancySensor`
3. The plugin subscribes to that event's lifecycle. As `eventUpdate` events arrive with RFID codes, it updates the matching `CatPresenceAccessory.OccupancySensor` (inward = home, outward = away).
4. When the event concludes (`frameCount` arrives), the plugin:
    - Sets `MotionSensor.MotionDetected = false`
    - If HKSV is active, fetches the event's HLS clip and feeds a fragmented MP4 stream to HomeKit's recording delegate.

## Module map

| Module | Responsibility |
|--------|----------------|
| `src/index.ts` | Homebridge entrypoint - registers the platform |
| `src/settings.ts` | Constants (plugin name, platform name) |
| `src/platform.ts` | Dynamic platform - discovers, registers, restores accessories |
| `src/api/client.ts` | Typed Socket.IO client with reconnect & RPC wrapper |
| `src/api/types.ts` | TypeScript interfaces matching OnlyCat shared models |
| `src/accessories/flapAccessory.ts` | Flap = camera + sensors + lock |
| `src/accessories/catPresenceAccessory.ts` | Per-cat occupancy sensor |
| `src/streaming/streamingDelegate.ts` | HomeKit camera streaming + snapshots |
| `src/streaming/recordingDelegate.ts` | HomeKit Secure Video recording |
| `src/streaming/ffmpeg.ts` | ffmpeg process management |
| `src/util/logger.ts` | Wraps Homebridge's logger with token redaction |

## Key design decisions

### Single connection, multiplexed

A Homebridge instance with N flaps and M cats opens **one** WebSocket - never N+M. All accessories listen to the same event stream and filter by `deviceId` / `rfidCode`. This matches what the official Home Assistant integration does.

### Event-driven, not polled

We avoid HTTP polling entirely. The only RPCs we make are at startup (discover devices/cats) and on user-driven actions (lock, unlock, reboot). All state updates ride the WebSocket push channel.

### Camera = event-recorder

OnlyCat does not expose a continuous live stream - only per-event HLS clips. The HomeKit camera surface is therefore modelled as an event-recorder:

- **Snapshot** - latest event poster frame
- **Live view** - the most recent event clip; falls back to a static still
- **HKSV** - recordings start when an event begins and end when it concludes

This is unusual for a HomeKit camera but works in practice and matches what HKSV is designed for: motion-triggered recording.

### Stateless accessory lifecycle

Accessories are uniquely identified by `deviceId` (flap) or `rfidCode` (cat). On startup the plugin reconciles cached accessories against the current discovery - additions are registered, removals are unregistered, restarts pick up where they left off.

### Trust boundaries

See [`SECURITY.md`](../SECURITY.md). Briefly: we treat HomeKit as trusted, OnlyCat as trusted-but-validate, and every Socket.IO payload as untrusted input.

## What we explicitly don't do

- **No telemetry / analytics.** The plugin makes no outbound calls except to `gateway.onlycat.com`.
- **No cloud relay.** Snapshots, video, and event data flow only between you, OnlyCat, and your HomeKit hub.
- **No persistence beyond Homebridge's accessory cache.** We don't store an event database - that's HKSV's job.
- **No public API surface.** The plugin doesn't expose its own HTTP endpoints; everything is HAP.
