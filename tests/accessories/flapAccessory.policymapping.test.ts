import { describe, expect, it, vi } from "vitest";
import { FlapAccessory } from "../../src/accessories/flapAccessory.js";
import { OnlyCatClient } from "../../src/api/client.js";
import type {
  DeviceRecord,
  DeviceTransitPolicy,
} from "../../src/api/types.js";
import {
  MockPlatformAccessory,
  asPlatformAccessory,
  createMockApi,
  createMockLogger,
} from "../helpers/homebridge.js";
import { createMockSocket } from "../helpers/mockSocket.js";

const lockedPolicy: DeviceTransitPolicy = {
  deviceTransitPolicyId: 1,
  deviceId: "dev-1",
  name: "All Locked",
  transitPolicy: { idleLock: true },
};

const noContrabandPolicy: DeviceTransitPolicy = {
  deviceTransitPolicyId: 2,
  deviceId: "dev-1",
  name: "No Contraband",
  transitPolicy: { idleLock: false },
};

const noAlarmPolicy: DeviceTransitPolicy = {
  deviceTransitPolicyId: 3,
  deviceId: "dev-1",
  name: "No Alarm",
  transitPolicy: { idleLock: false },
};

function build(overrides: { unlockPolicyName?: string; lockPolicyName?: string } = {}) {
  const log = createMockLogger();
  const api = createMockApi();
  const socket = createMockSocket();
  const client = new OnlyCatClient({ token: "tok", log, socket });
  const device: DeviceRecord = { deviceId: "dev-1", deviceTransitPolicyId: 1 };
  const accessory = new MockPlatformAccessory("Flap", "uuid:dev-1");
  const flap = new FlapAccessory({
    api,
    log,
    client,
    device,
    accessory: asPlatformAccessory(accessory),
    disableCamera: true,
    ...overrides,
  });
  flap.applyPolicy(lockedPolicy);
  flap.applyPolicy(noContrabandPolicy);
  flap.applyPolicy(noAlarmPolicy);
  return { flap, accessory, socket, log };
}

describe("FlapAccessory policy mapping", () => {
  it("uses the configured unlockPolicyName instead of the first idleLock=false policy", async () => {
    const { accessory, socket } = build({ unlockPolicyName: "No Alarm" });
    socket.__ackResponses.set("activateDeviceTransitPolicy", { success: true });
    const spy = vi.spyOn(socket, "emitWithAck");
    const lock = accessory.getService("LockMechanism", "lock")!;
    await lock.getCharacteristic("LockTargetState").onSetHandler!(0); // unlock
    expect(spy).toHaveBeenCalledWith("activateDeviceTransitPolicy", {
      deviceId: "dev-1",
      deviceTransitPolicyId: 3, // No Alarm
    });
  });

  it("matches policy names case-insensitively", async () => {
    const { accessory, socket } = build({ unlockPolicyName: "no contraband" });
    socket.__ackResponses.set("activateDeviceTransitPolicy", { success: true });
    const spy = vi.spyOn(socket, "emitWithAck");
    const lock = accessory.getService("LockMechanism", "lock")!;
    await lock.getCharacteristic("LockTargetState").onSetHandler!(0);
    expect(spy).toHaveBeenCalledWith("activateDeviceTransitPolicy", {
      deviceId: "dev-1",
      deviceTransitPolicyId: 2, // No Contraband
    });
  });

  it("warns and falls back to first idleLock match when configured name is unknown", async () => {
    const { accessory, socket, log } = build({ unlockPolicyName: "ghost" });
    socket.__ackResponses.set("activateDeviceTransitPolicy", { success: true });
    const spy = vi.spyOn(socket, "emitWithAck");
    const lock = accessory.getService("LockMechanism", "lock")!;
    await lock.getCharacteristic("LockTargetState").onSetHandler!(0);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("Configured"),
      "unlock",
      "ghost",
      "dev-1",
    );
    // Falls back to first idleLock=false (No Contraband, id 2)
    expect(spy).toHaveBeenCalledWith("activateDeviceTransitPolicy", {
      deviceId: "dev-1",
      deviceTransitPolicyId: 2,
    });
  });

  it("uses the configured lockPolicyName when locking", async () => {
    const { accessory, socket } = build({ lockPolicyName: "All Locked" });
    socket.__ackResponses.set("activateDeviceTransitPolicy", { success: true });
    const spy = vi.spyOn(socket, "emitWithAck");
    const lock = accessory.getService("LockMechanism", "lock")!;
    await lock.getCharacteristic("LockTargetState").onSetHandler!(1);
    expect(spy).toHaveBeenCalledWith("activateDeviceTransitPolicy", {
      deviceId: "dev-1",
      deviceTransitPolicyId: 1,
    });
  });

  it("lock state follows the configured name even when the policy's idleLock disagrees", () => {
    // Real-world OnlyCat: "without Alarm" still has idleLock=true (flap is
    // per-cat unlocked, not idle-unlocked). HomeKit should still show this
    // as the unlocked state when the user has set unlockPolicyName.
    const log = createMockLogger();
    const api = createMockApi();
    const socket = createMockSocket();
    const client = new OnlyCatClient({ token: "tok", log, socket });
    const device = { deviceId: "dev-1", deviceTransitPolicyId: 3 };
    const accessory = new MockPlatformAccessory("Flap", "uuid:dev-1");
    const flap = new FlapAccessory({
      api,
      log,
      client,
      device,
      accessory: asPlatformAccessory(accessory),
      disableCamera: true,
      unlockPolicyName: "without Alarm",
      lockPolicyName: "Locked",
    });
    flap.applyPolicy({
      deviceTransitPolicyId: 1,
      deviceId: "dev-1",
      name: "Locked",
      transitPolicy: { idleLock: true },
    });
    flap.applyPolicy({
      deviceTransitPolicyId: 3,
      deviceId: "dev-1",
      name: "without Alarm",
      // idleLock=true but the user considers this "unlocked"
      transitPolicy: { idleLock: true },
    });
    const lock = accessory.getService("LockMechanism", "lock")!;
    // Should be unlocked because the active policy name matches unlockPolicyName.
    expect(lock.getCharacteristic("LockCurrentState").value).toBe(0);
  });

  it("falls back to idleLock heuristic when neither override is configured", async () => {
    const { accessory, socket } = build();
    socket.__ackResponses.set("activateDeviceTransitPolicy", { success: true });
    const spy = vi.spyOn(socket, "emitWithAck");
    const lock = accessory.getService("LockMechanism", "lock")!;
    await lock.getCharacteristic("LockTargetState").onSetHandler!(0);
    // First idleLock=false in registration order: No Contraband
    expect(spy).toHaveBeenCalledWith("activateDeviceTransitPolicy", {
      deviceId: "dev-1",
      deviceTransitPolicyId: 2,
    });
  });

  it("treats blank/whitespace policy name as unset", async () => {
    const { accessory, socket } = build({ unlockPolicyName: "   " });
    socket.__ackResponses.set("activateDeviceTransitPolicy", { success: true });
    const spy = vi.spyOn(socket, "emitWithAck");
    const lock = accessory.getService("LockMechanism", "lock")!;
    await lock.getCharacteristic("LockTargetState").onSetHandler!(0);
    expect(spy).toHaveBeenCalledWith("activateDeviceTransitPolicy", {
      deviceId: "dev-1",
      deviceTransitPolicyId: 2, // first idleLock=false
    });
  });
});
