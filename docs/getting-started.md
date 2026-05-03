# Getting started

End-to-end walkthrough for setting up `homebridge-onlycat`: install the plugin, configure your OnlyCat token, and pair the cat flap as a HomeKit camera in the iOS Home app.

## 1. Install the plugin

In the Homebridge UI, search for **OnlyCat** in the Plugins tab and install it. Or from a terminal:

```sh
sudo npm install -g homebridge-onlycat
```

## 2. Generate an OnlyCat API token

1. Open the OnlyCat mobile app
2. Go to **Settings → Developer**
3. Generate (or copy) your API token

Treat the token like a password: anyone with it can control your flap.

## 3. Configure the plugin in Homebridge

In the Homebridge UI, click the gear icon next to OnlyCat and paste your token. The settings panel exposes everything in one form:

<p align="center">
  <img src="https://raw.githubusercontent.com/matthiaseinig/Homebridge-OnlyCat/main/docs/screenshots/homebridge-settings.png" alt="Homebridge UI settings for OnlyCat" width="640" />
</p>

What each field does:

- **OnlyCat API Token**: the token from step 2.
- **Verbose logging**: leave off for normal use. Turn on if you need to send a debug log to a maintainer.
- **ffmpeg path**: leave blank. The plugin uses the bundled `ffmpeg-for-homebridge` binary.
- **Policy to activate when unlocking** / **Policy to activate when locking**: the names of two OnlyCat transit policies that the HomeKit `LockMechanism` toggles between. Case-insensitive. See [Door-policy switching](#door-policy-switching) below.
- **Disable camera service**: leave off unless you specifically don't want the camera tile in HomeKit.
- **Show divider between live-view replay loops**: live view replays the most recent flap event continuously. With this on, a 1-second black slate plays between iterations so you can tell the loop boundary. Off for a seamless loop.
- **Replay event history on startup (days)**: when > 0, the plugin pushes the last N days of events through HomeKit Secure Video on startup. Useful for backfilling history. HomeKit timestamps replayed clips at the moment of replay (not the original event time): an Apple HKSV API limitation we cannot bypass.

Save and restart Homebridge. The plugin connects to the OnlyCat gateway and exposes the flap as a HomeKit accessory.

## 4. Pair the bridge with your iOS Home app

If this is a fresh Homebridge install, your iPhone will pick up the bridge automatically. If not, scan the Homebridge QR code from **Status → Setup**.

<p align="center">
  <img src="https://raw.githubusercontent.com/matthiaseinig/Homebridge-OnlyCat/main/docs/screenshots/setup-01-add-bridge.png" alt="iOS Home: Add Bridge prompt" width="320" />
</p>

Tap **Add to Home**.

## 5. Acknowledge the uncertified-accessory warning

Homebridge is not Apple-certified and never will be (it is community software). Tap **Add Anyway**.

<p align="center">
  <img src="https://raw.githubusercontent.com/matthiaseinig/Homebridge-OnlyCat/main/docs/screenshots/setup-02-uncertified-accessory.png" alt="iOS Home: Uncertified Accessory warning" width="320" />
</p>

## 6. Wait for the bridge to register

This takes a few seconds.

<p align="center">
  <img src="https://raw.githubusercontent.com/matthiaseinig/Homebridge-OnlyCat/main/docs/screenshots/setup-03-adding-to-home.png" alt="iOS Home: Adding to home..." width="320" />
</p>

## 7. Pick a room for the bridge

<p align="center">
  <img src="https://raw.githubusercontent.com/matthiaseinig/Homebridge-OnlyCat/main/docs/screenshots/setup-04-bridge-location.png" alt="iOS Home: Bridge Location" width="320" />
</p>

## 8. Confirm or rename the bridge

The default name is the OnlyCat device serial. Rename if you like; HomeKit only uses this label internally.

<p align="center">
  <img src="https://raw.githubusercontent.com/matthiaseinig/Homebridge-OnlyCat/main/docs/screenshots/setup-05-bridge-name.png" alt="iOS Home: Bridge Name" width="320" />
</p>

## 9. iOS finds the cat-flap camera

iOS now walks you through each accessory the bridge exposes, starting with the camera.

<p align="center">
  <img src="https://raw.githubusercontent.com/matthiaseinig/Homebridge-OnlyCat/main/docs/screenshots/setup-06-camera-found.png" alt="iOS Home: Ylvi Door camera found" width="320" />
</p>

## 10. Pick a room for the camera

Usually the same room as the bridge.

<p align="center">
  <img src="https://raw.githubusercontent.com/matthiaseinig/Homebridge-OnlyCat/main/docs/screenshots/setup-07-camera-location.png" alt="iOS Home: Camera Location" width="320" />
</p>

## 11. Confirm the camera name

<p align="center">
  <img src="https://raw.githubusercontent.com/matthiaseinig/Homebridge-OnlyCat/main/docs/screenshots/setup-08-camera-name.png" alt="iOS Home: Camera Name" width="320" />
</p>

## 12. Choose streaming and recording behaviour

Pick **Stream & Allow Recording** for both **When Home** and **When Away** if you want HomeKit Secure Video to record every flap event to your iCloud timeline.

<p align="center">
  <img src="https://raw.githubusercontent.com/matthiaseinig/Homebridge-OnlyCat/main/docs/screenshots/setup-09-stream-and-record.png" alt="iOS Home: Stream and Record" width="320" />
</p>

HKSV requires an iCloud+ subscription with at least one HomeKit hub (Apple TV, HomePod, or iPad). 50 GB iCloud+ supports one camera; 200 GB supports five; 2 TB supports unlimited.

## 13. Confirm the linked services

Each flap brings a bundle of sensors plus the door-policy lock and remote unlock / reboot switches. iOS lets you confirm the names. Defaults are descriptive and you can change them later.

<p align="center">
  <img src="https://raw.githubusercontent.com/matthiaseinig/Homebridge-OnlyCat/main/docs/screenshots/setup-10-camera-details.png" alt="iOS Home: Camera Details with linked services" width="320" />
</p>

See [docs/ACCESSORIES.md](ACCESSORIES.md) for what each service does.

## 14. Camera added

The camera is in HomeKit. The snapshot tile already shows the most recent flap event.

<p align="center">
  <img src="https://raw.githubusercontent.com/matthiaseinig/Homebridge-OnlyCat/main/docs/screenshots/setup-11-camera-added.png" alt="iOS Home: Camera Added" width="320" />
</p>

## 15. Per-cat occupancy sensors

For each RFID profile in your OnlyCat account, the plugin exposes a separate occupancy sensor: "is this cat home?" iOS prompts you for each one.

<p align="center">
  <img src="https://raw.githubusercontent.com/matthiaseinig/Homebridge-OnlyCat/main/docs/screenshots/setup-12-cat-occupancy-sensor.png" alt="iOS Home: Cat RFID occupancy sensor" width="320" />
</p>

If you have not labelled the RFID profile in the OnlyCat app, the sensor name is "Cat RFID *RFID code*". Set a friendly name in the OnlyCat app and it will be picked up automatically next time the plugin restarts.

Pick a room and confirm the name as before:

<p align="center">
  <img src="https://raw.githubusercontent.com/matthiaseinig/Homebridge-OnlyCat/main/docs/screenshots/setup-13-cat-occupancy-location.png" alt="iOS Home: Cat occupancy location" width="320" />
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/matthiaseinig/Homebridge-OnlyCat/main/docs/screenshots/setup-14-cat-occupancy-name.png" alt="iOS Home: Cat occupancy name" width="320" />
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/matthiaseinig/Homebridge-OnlyCat/main/docs/screenshots/setup-15-cat-occupancy-added.png" alt="iOS Home: Cat occupancy added" width="320" />
</p>

## 16. Done

You should now see all the OnlyCat services in the Home app, organised under the camera tile.

<p align="center">
  <img src="https://raw.githubusercontent.com/matthiaseinig/Homebridge-OnlyCat/main/docs/screenshots/home-tile-all-accessories.png" alt="iOS Home: All accessories under Ylvi Door" width="320" />
</p>

The shared occupancy view groups every binary sensor in one place:

<p align="center">
  <img src="https://raw.githubusercontent.com/matthiaseinig/Homebridge-OnlyCat/main/docs/screenshots/setup-16-occupancy-sensors.png" alt="iOS Home: Occupancy sensors" width="320" />
</p>

Tap the camera tile to see the latest event clip on loop:

<p align="center">
  <img src="https://raw.githubusercontent.com/matthiaseinig/Homebridge-OnlyCat/main/docs/screenshots/live-view.png" alt="iOS Home: Live view" width="320" />
</p>

## Triggering automations

Every binary sensor that the plugin exposes can drive a HomeKit automation. The most useful ones:

- **Activity (motion)**: fires the moment a flap event begins. Good for "cat is at the flap" quick notifications.
- **Cat RFID *<id>***: a per-cat occupancy sensor that goes Triggered when that specific cat enters the home, and Idle when it leaves. Useful for "Welcome home, Ylvi" automations or for switching a different scene per cat.
- **Contraband**: fires when the flap detects unwanted prey. Wire it to a smart-light flash or a phone notification.
- **Human at flap**: fires when the flap detects a person. Handy for security automations.
- **Breach**: fires when the lock was engaged but a cat got through anyway. A real security alarm: wire to lights, sirens, or a notification cascade.
- **Blocked**: fires when the door policy denied a cat. Use for "unknown cat tried to enter" notifications.
- **Online**: fires when the flap loses (or regains) its connection to the OnlyCat gateway. Useful for monitoring the flap itself.

In the Home app, go to **Automation → Add → A Sensor Detects Something**, pick the relevant sensor, and set the actions. The sensor stays Triggered for the duration of the flap event and resets to Idle when the event concludes.

## Door-policy switching

The HomeKit lock on the cat flap toggles between two named OnlyCat transit policies. You configure the policy names once in the plugin settings:

- **Policy to activate when unlocking** maps to the HomeKit lock's *Unlocked* state. Common choices: "without Alarm", "No Contraband".
- **Policy to activate when locking** maps to the HomeKit lock's *Locked* state. Common choices: "Locked", "All Locked".

Names are matched case-insensitively against the policies in your OnlyCat account. Leave both blank to fall back to a heuristic (auto-pick the first policy with `idleLock=false` for unlocking and `idleLock=true` for locking).

Once configured, you can:

- Toggle the lock from the Home app
- Use Siri: "Hey Siri, lock the cat flap" or "unlock the cat flap"
- Drive the lock from a HomeKit automation (e.g., "lock the flap automatically at sunset")
