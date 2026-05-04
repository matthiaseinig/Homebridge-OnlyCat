<p align="center">
  <img src="https://raw.githubusercontent.com/matthiaseinig/Homebridge-OnlyCat/main/assets/onlycat-logo.jpg" alt="OnlyCat logo" width="180" />
</p>

# Homebridge-OnlyCat

<p align="center">
  <a href="https://www.npmjs.com/package/homebridge-onlycat"><img src="https://img.shields.io/npm/v/homebridge-onlycat?logo=npm&label=npm" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/homebridge-onlycat"><img src="https://img.shields.io/npm/dt/homebridge-onlycat?logo=npm&label=downloads" alt="total npm downloads" /></a>
  <a href="https://www.npmjs.com/package/homebridge-onlycat"><img src="https://img.shields.io/npm/dm/homebridge-onlycat?logo=npm&label=monthly" alt="monthly npm downloads" /></a>
  <a href="https://github.com/matthiaseinig/Homebridge-OnlyCat/releases/latest"><img src="https://img.shields.io/github/v/release/matthiaseinig/Homebridge-OnlyCat?logo=github&label=release" alt="latest release" /></a>
  <a href="https://github.com/matthiaseinig/Homebridge-OnlyCat/actions/workflows/ci.yml"><img src="https://github.com/matthiaseinig/Homebridge-OnlyCat/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/matthiaseinig/Homebridge-OnlyCat/blob/main/LICENSE"><img src="https://img.shields.io/github/license/matthiaseinig/Homebridge-OnlyCat" alt="MIT License" /></a>
  <a href="https://homebridge.io"><img src="https://img.shields.io/badge/homebridge-1.8%20%7C%202.0--beta-blue" alt="Homebridge 1.8 / 2.0-beta" /></a>
</p>

Homebridge plugin for the [OnlyCat](https://www.onlycat.com) smart cat flap.

It turns your OnlyCat flap into a fully-featured HomeKit accessory: a real camera tile with the latest event clip on loop, HomeKit Secure Video recording on every transit, per-cat presence sensors, contraband and breach alarms, plus a door-policy lock you can drive from the Home app or with Siri.

<p align="center">
  <a href="https://raw.githubusercontent.com/matthiaseinig/Homebridge-OnlyCat/main/docs/screenshots/setup-11-camera-added.png">
    <img src="https://raw.githubusercontent.com/matthiaseinig/Homebridge-OnlyCat/main/docs/screenshots/setup-11-camera-added.png" alt="iOS Home: live cat-flap snapshot in the camera tile" width="280" />
  </a>
  &nbsp;
  <a href="https://raw.githubusercontent.com/matthiaseinig/Homebridge-OnlyCat/main/docs/screenshots/home-tile-all-accessories.png">
    <img src="https://raw.githubusercontent.com/matthiaseinig/Homebridge-OnlyCat/main/docs/screenshots/home-tile-all-accessories.png" alt="iOS Home: every OnlyCat service grouped under the camera" width="280" />
  </a>
</p>

## Features

- **Camera tile**: snapshot from the latest event's poster frame, live view replays the latest clip on loop (with a configurable boundary slate), and HomeKit Secure Video records every flap event to your iCloud timeline.
- **Per-cat presence sensors**: one HomeKit occupancy sensor per RFID profile, driven by OnlyCat's `getEventSummary` so a peeking cat does not flip presence.
- **Contraband alarm**: separate occupancy sensor that fires when the flap detects unwanted prey.
- **Human-at-flap sensor**: fires when the camera sees a person, useful for "someone is touching the flap" notifications.
- **Breach sensor**: security alarm that fires when the lock was engaged but a cat transited anyway.
- **Blocked sensor**: fires when the door policy denied a cat. Handy for "unknown cat tried to enter" notifications.
- **Online sensor**: fires when the flap loses (or regains) its connection to the OnlyCat gateway.
- **Door-policy lock**: a HomeKit `LockMechanism` that toggles between two configurable OnlyCat transit policies.
- **Remote unlock** and **reboot** as momentary switches.

## Quick start

1. Install the plugin. Either via the Homebridge UI (search for **OnlyCat** in the Plugins tab) or from the command line:

   ```sh
   sudo npm install -g homebridge-onlycat
   ```

2. Generate an API token in the OnlyCat mobile app under **Settings → Developer**.
3. Paste the token into the plugin settings, save, restart Homebridge.
4. Pair the bridge with iOS Home if you have not already.

For the full pairing flow with screenshots, see [docs/getting-started.md](docs/getting-started.md).

The plugin is published on npm at [homebridge-onlycat](https://www.npmjs.com/package/homebridge-onlycat).

## Triggering automations

Every binary sensor the plugin exposes can drive a HomeKit automation. The most common patterns:

- **"Cat X came home"**: trigger on the per-cat occupancy sensor going Triggered. Use it for welcome lights, scenes, or a notification to family members.
- **"Someone at the flap"**: trigger on the *Activity* (motion) sensor or *Human at flap* sensor.
- **"Contraband alarm"**: trigger on the *Contraband* sensor and flash a smart light, send a notification, or open the camera live view automatically.
- **"Security breach"**: trigger on the *Breach* sensor for a hard alarm cascade. The lock was engaged but something got through.
- **"Unknown cat denied"**: trigger on the *Blocked* sensor and notify, log, or pull up a snapshot.
- **"Flap offline"**: trigger on *Online* going Idle to alert you when the flap loses its gateway connection.

In the Home app, go to **Automation → Add Automation → A Sensor Detects Something**, pick the OnlyCat sensor, and set actions. The sensor stays Triggered for the duration of the flap event and resets automatically.

## Door-policy switching with two profiles

The cat flap appears in HomeKit as a `LockMechanism`, but instead of a literal latch it toggles between two OnlyCat transit policies that you configure once. For example:

- **Unlocked profile** = `without Alarm` (lets known cats in, no contraband alarm)
- **Locked profile** = `Locked` (everything blocked, e.g. for the night)

Configure the names in the plugin settings (case-insensitive) and the lock will activate the named policy whenever you toggle it. Once configured you can:

- Tap the lock in the Home app
- Use Siri: "Hey Siri, lock the cat flap" or "unlock the cat flap"
- Drive it from a HomeKit automation, e.g. lock at sunset and unlock at sunrise

If you do not configure named policies, the lock falls back to a heuristic: it picks the first policy with `idleLock=false` for unlocking, and `idleLock=true` for locking.

## Configuration

Use the Homebridge UI's settings form:

<p align="center">
  <img src="https://raw.githubusercontent.com/matthiaseinig/Homebridge-OnlyCat/main/docs/screenshots/homebridge-settings.png" alt="Homebridge UI settings for the OnlyCat plugin" width="600" />
</p>

Or add the platform block to your `config.json`:

```json
{
  "platforms": [
    {
      "platform": "OnlyCat",
      "name": "OnlyCat",
      "token": "YOUR_ONLYCAT_TOKEN",
      "unlockPolicyName": "without Alarm",
      "lockPolicyName": "Locked"
    }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `platform` | string | yes | Must be `OnlyCat` |
| `name` | string | yes | Display name in Homebridge logs |
| `token` | string | yes | API token from the OnlyCat mobile app (Settings → Developer) |
| `unlockPolicyName` | string | no | OnlyCat transit policy to activate when HomeKit unlocks the flap. Case-insensitive. |
| `lockPolicyName` | string | no | OnlyCat transit policy to activate when HomeKit locks the flap. Case-insensitive. |
| `loopSlate` | boolean | no | Show a 1-second black slate between live-view replay loops so it is visually obvious you are looking at a replay rather than continuous live video. Default `true`. |
| `disableCamera` | boolean | no | Suppress the camera service. Sensors, lock, and switches still appear, but as separate tiles in the Home app. Default `false`. |
| `ffmpegPath` | string | no | Override path to the ffmpeg binary. Default uses the bundled `ffmpeg-for-homebridge` build. |
| `replayHistoryOnStartup` | integer (0-30) | no | When > 0, replay the last N days of events through HKSV on startup. The clip content is correct, but HomeKit timestamps the recordings at the moment of replay (an Apple HKSV API limitation we cannot bypass). Default `0`. |
| `debug` | boolean | no | Verbose Socket.IO logging. Leave off for normal use. |

## Requirements

- Node.js 18.20+, 20.15+, or 22+ (Node 22+ recommended)
- Homebridge 1.8+ (HKSV recording also requires an iCloud+ subscription and at least one HomeKit hub: Apple TV, HomePod, or iPad)
- An OnlyCat account with at least one flap, plus an API token from the OnlyCat mobile app

A pre-built `ffmpeg` ships with the plugin via [`ffmpeg-for-homebridge`](https://github.com/homebridge/ffmpeg-for-homebridge), so you don't need to install ffmpeg yourself. To use a custom build set `ffmpegPath` in the plugin config.

## How it works

The plugin opens a single persistent WebSocket (Socket.IO) connection to OnlyCat's gateway. It:

1. Discovers every flap on your account and registers a HomeKit camera accessory for each one.
2. Subscribes to live event updates. Every flap event fires the matching HomeKit sensors and, if HKSV is enabled, records a clip to your Home timeline.
3. Discovers known cats from RFID profiles and registers a presence sensor accessory per cat.
4. Reflects the current door policy as a HomeKit lock; toggling the lock activates the configured transit policy.

For a deeper dive into the architecture see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Privacy and security

- The token is stored only in your Homebridge `config.json`. It is never logged at info level and never transmitted anywhere except OnlyCat's official gateway.
- All traffic is HTTPS / WSS to `gateway.onlycat.com`.
- Snapshots and HKSV clips stay on your Apple devices via iCloud, never through any third-party server.
- See [`SECURITY.md`](SECURITY.md) for the full threat model and how to report a vulnerability.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Bug reports and pull requests are welcome.

## Disclaimer

This project is not affiliated with or endorsed by OnlyCat. *OnlyCat® is a registered trademark of VirtualV Trading Ltd.*

## License

MIT, see [`LICENSE`](LICENSE).
