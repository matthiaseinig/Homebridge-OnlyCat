# HomeKit accessory mapping

How OnlyCat concepts surface as HomeKit services.

## Per-flap accessory

One HomeKit accessory per OnlyCat device, modelled as a camera with linked services.

| OnlyCat surface | HAP service | Behavior |
|---|---|---|
| Device identity | `AccessoryInformation` | Manufacturer="OnlyCat", Serial=`deviceId`, FirmwareRevision from telemetry |
| Live view + snapshot | `CameraController` (with `CameraRecordingManagement` for HKSV) | Snapshot = latest poster frame; live = ffmpeg from latest event HLS, fallback to looped poster |
| Any event in progress | `MotionSensor` "Activity" | True on `deviceEventUpdate`, false when `frameCount` arrives |
| Contraband detected | `OccupancySensor` "Contraband" | Latched on `eventClassification=CONTRABAND` |
| Human activity | `OccupancySensor` "Human at flap" | `HUMAN_ACTIVITY` |
| Door lock state | `LockMechanism` | Reflects active policy's `idleLock`; setter calls `activateDeviceTransitPolicy` |
| Remote unlock pulse | `Switch` "Remote unlock" | Momentary (auto-revert) |
| Reboot | `Switch` "Reboot" | Momentary (auto-revert) |
| Online state | `OccupancySensor` "Online" | True when flap is online; drives HomeKit "is offline" automations and notifications |
| Connectivity badge | `StatusFault` characteristic | Reflects `connectivity.connected` on Lock + Activity services for visual fault indicator |

## Per-cat accessory

One HomeKit accessory per RFID profile.

| Surface | Service | Behavior |
|---|---|---|
| Identity | `AccessoryInformation` | Name = pet label, Serial = `rfidCode` |
| Presence | `OccupancySensor` "Home" | True after last sighting was inward, false after outward |

## Why these specific services

- **`OccupancySensor`** for cat presence (not `MotionSensor`): occupancy is sticky, motion is transient. "Whiskers is home" is a state, not a momentary event.
- **`LockMechanism`** for door policy (not a custom select): gives first-class Siri ("lock the cat flap"), HomeKit automations ("when door locks, …"), and a single binary that maps to "current policy is restrictive vs permissive". Multi-policy switching can be added later as a set of preset switches if needed.
- **Stateless `Switch`** for unlock/reboot: standard HomeKit pattern for momentary actions; auto-revert after 1s.
- **One camera per flap** with linked sensors (rather than separate accessories for each surface): cleaner Home-app UX, and HKSV requires the motion sensor to be linked to the camera.
