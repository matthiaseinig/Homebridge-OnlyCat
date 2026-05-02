# OnlyCat wire protocol

This is what we know about the OnlyCat Socket.IO API based on observation of the official integrations. The protocol is undocumented and may change without notice — this file is a living reference, not a contract.

## Connection

- **Transport:** Socket.IO v4 over WebSocket (TLS only)
- **Endpoint:** `wss://gateway.onlycat.com`
- **Namespace:** `/`
- **Auth:** token in handshake `auth` payload — `{ token: "..." }`
- **Headers:** `platform: homebridge`, `device: homebridge-onlycat`
- **Reconnect:** infinite, ~10s delay between attempts

## Outbound RPCs

Each is a Socket.IO ack-style call: `socket.emitWithAck(name, args)` and we await the reply.

| Event | Args | Returns |
|---|---|---|
| `getDevices` | `{ subscribe: true }` | `[{ deviceId }, …]` |
| `getDevice` | `{ deviceId, subscribe: true }` | `Device` |
| `getDeviceTransitPolicies` | `{ deviceId }` | `[{ deviceTransitPolicyId, name }, …]` |
| `getDeviceTransitPolicy` | `{ deviceTransitPolicyId }` | `DeviceTransitPolicy` |
| `activateDeviceTransitPolicy` | `{ deviceId, deviceTransitPolicyId }` | activation result |
| `updateDeviceTransitPolicy` | `DeviceTransitPolicy` | updated policy |
| `getDeviceEvents` | `{ deviceId, subscribe?: true }` | `Event[]` |
| `getEvent` | `{ deviceId, eventId, subscribe?: true }` | `Event` |
| `getLastSeenRfidCodesByDevice` | `{ deviceId }` | `[{ rfidCode, timestamp }, …]` |
| `getRfidProfile` | `{ deviceId, rfidCode }` | `RfidProfile` (includes `label`) |
| `getDeviceErrorLogs` | `{ deviceId, limit, hours, measureName }` | error log entries |
| `getEventSummary` | `{ deviceId, eventId, subscribe? }` | `EventSummary \| null` |
| `runDeviceCommand` | `{ deviceId, command: "reboot" \| "unlock" }` | command result |

## Inbound (push) events

| Event | When | Payload |
|---|---|---|
| `connect` | After successful handshake (incl. reconnect) | — |
| `userUpdate` | User identity changed (treat as "re-subscribe everything") | user record |
| `deviceUpdate` | Device state changed (policy, connectivity, settings) | `{ deviceId, type, body }` |
| `deviceEventUpdate` | A new flap event started | partial `Event` (no `frameCount`) |
| `eventUpdate` | An ongoing event progressed | partial `Event` (may add `rfidCodes`) |
| `eventSummaryUpdate` | The ML-fused summary for an event has changed | `{ deviceId, eventId, type, body: EventSummary }` |
| `getEvent` | Ack for `getEvent` RPC | `Event` |

An event is **in progress** while `frameCount` is `null` and **concluded** once `frameCount` is set.

## Core types (subset)

Adapted from [`OnlyCatAI/onlycat-shared-models`](https://github.com/OnlyCatAI/onlycat-shared-models). We reimplement these in TypeScript rather than vendor them.

### `Event`

| Field | Type | Notes |
|---|---|---|
| `globalId` | number | Cross-device unique |
| `deviceId` | string | |
| `eventId` | number | Per-device |
| `timestamp` | ISO 8601 string | |
| `frameCount` | number \| null | null = in progress |
| `eventTriggerSource` | enum | `MANUAL=0`, `REMOTE=1`, `INDOOR_MOTION=2`, `OUTDOOR_MOTION=3` |
| `eventClassification` | enum | `UNKNOWN=0`, `CLEAR=1`, `SUSPICIOUS=2`, `CONTRABAND=3`, `HUMAN_ACTIVITY=4`, `REMOTE_UNLOCK=10` |
| `posterFrameIndex` | number | For thumbnail rendering |
| `accessToken` | string | Required to fetch the event's video |
| `rfidCodes` | string[] | Cats detected during the event |

### `SubEvent`

| Field | Type | Notes |
|---|---|---|
| `direction` | `"INWARD"` \| `"OUTWARD"` | |
| `action` | `"PEEK"` \| `"TRANSIT"` \| `"DENY"` \| `"BREACH"` | |
| `rfidCode` | string \| null | |
| `startFrameIndex` | number | |
| `endFrameIndex` | number | |

### `EventSummary`

The canonical interpretation of an event, computed server-side. Subscribe with `getEventSummary { subscribe: true }` and listen for `eventSummaryUpdate` push events. The summary is provisional during an event and may change (e.g. a `TRANSIT` may be demoted to `PEEK` if the cat retreats); it's final when `processedFrameCount === Event.frameCount`.

| Field | Type | Notes |
|---|---|---|
| `deviceId` | string | |
| `eventId` | number | |
| `processedFrameCount` | number | When this matches the event's `frameCount`, the summary is final |
| `subevents` | `SubEvent[]` | Per-cat per-action timeline within the event |

## Media URLs

- **Thumbnail (per frame):** `https://gateway.onlycat.com/events/{deviceId}/{eventId}/{frameIndex}` — JPEG
- **Video (HLS playlist):** `https://gateway.onlycat.com/sharing/video/{deviceId}/{eventId}?t={accessToken}`

There is **no continuous live stream** — only per-event clips. This shapes how the camera surface is modelled (see [`ARCHITECTURE.md`](ARCHITECTURE.md)).
