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
  name: "Locked",
  transitPolicy: { idleLock: true },
};

const openPolicy: DeviceTransitPolicy = {
  deviceTransitPolicyId: 2,
  deviceId: "dev-1",
  name: "Open",
  transitPolicy: { idleLock: false },
};

function build(record: Partial<DeviceRecord> = {}) {
  const log = createMockLogger();
  const api = createMockApi();
  const socket = createMockSocket();
  const client = new OnlyCatClient({ token: "tok", log, socket });
  const device: DeviceRecord = {
    deviceId: "dev-1",
    description: "Front",
    deviceTransitPolicyId: 2,
    ...record,
  };
  const accessory = new MockPlatformAccessory("Front", "uuid:dev-1");
  const flap = new FlapAccessory({
    api,
    log,
    client,
    device,
    accessory: asPlatformAccessory(accessory),
  });
  return { flap, accessory, client, socket, log };
}

describe("FlapAccessory lock", () => {
  it("starts in UNKNOWN state with no policies loaded", () => {
    const { accessory } = build();
    const lock = accessory.getService("LockMechanism", "lock")!;
    expect(lock.getCharacteristic("LockCurrentState").value).toBe(3);
  });

  it("reflects unlocked when active policy has idleLock=false", () => {
    const { flap, accessory } = build();
    flap.applyPolicy(openPolicy);
    flap.applyPolicy(lockedPolicy);
    const lock = accessory.getService("LockMechanism", "lock")!;
    expect(lock.getCharacteristic("LockCurrentState").value).toBe(0);
  });

  it("reflects locked when active policy has idleLock=true", () => {
    const { flap, accessory } = build({ deviceTransitPolicyId: 1 });
    flap.applyPolicy(lockedPolicy);
    const lock = accessory.getService("LockMechanism", "lock")!;
    expect(lock.getCharacteristic("LockCurrentState").value).toBe(1);
  });

  it("locking sends activateDeviceTransitPolicy with the locked policy", async () => {
    const { flap, accessory, socket } = build();
    flap.applyPolicy(openPolicy);
    flap.applyPolicy(lockedPolicy);
    const lock = accessory.getService("LockMechanism", "lock")!;
    socket.__ackResponses.set("activateDeviceTransitPolicy", { success: true });
    const spy = vi.spyOn(socket, "emitWithAck");

    const setHandler = lock.getCharacteristic("LockTargetState").onSetHandler!;
    await setHandler(1);
    expect(spy).toHaveBeenCalledWith("activateDeviceTransitPolicy", {
      deviceId: "dev-1",
      deviceTransitPolicyId: 1,
    });
    expect(lock.getCharacteristic("LockCurrentState").value).toBe(1);
  });

  it("unlocking sends activateDeviceTransitPolicy with the open policy", async () => {
    const { flap, accessory, socket } = build({ deviceTransitPolicyId: 1 });
    flap.applyPolicy(lockedPolicy);
    flap.applyPolicy(openPolicy);
    const lock = accessory.getService("LockMechanism", "lock")!;
    socket.__ackResponses.set("activateDeviceTransitPolicy", { success: true });
    const spy = vi.spyOn(socket, "emitWithAck");

    await lock.getCharacteristic("LockTargetState").onSetHandler!(0);
    expect(spy).toHaveBeenCalledWith("activateDeviceTransitPolicy", {
      deviceId: "dev-1",
      deviceTransitPolicyId: 2,
    });
    expect(lock.getCharacteristic("LockCurrentState").value).toBe(0);
  });

  it("warns and marks JAMMED when no matching policy exists", async () => {
    const { flap, accessory, log } = build();
    flap.applyPolicy(openPolicy); // no locked policy available
    const lock = accessory.getService("LockMechanism", "lock")!;
    await lock.getCharacteristic("LockTargetState").onSetHandler!(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("No transit policy"),
      "dev-1",
      expect.any(String),
    );
    expect(lock.getCharacteristic("LockCurrentState").value).toBe(2);
  });

  it("logs error and marks JAMMED if activation fails", async () => {
    const { flap, accessory, socket, log } = build();
    flap.applyPolicy(openPolicy);
    flap.applyPolicy(lockedPolicy);
    socket.__ackResponses.set("activateDeviceTransitPolicy", () => {
      throw new Error("server-down");
    });
    const lock = accessory.getService("LockMechanism", "lock")!;
    await lock.getCharacteristic("LockTargetState").onSetHandler!(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to activate policy"),
      1,
      "dev-1",
      "server-down",
    );
    expect(lock.getCharacteristic("LockCurrentState").value).toBe(2);
  });

  it("device update changing the active policy updates the lock state", () => {
    const { flap, accessory } = build();
    flap.applyPolicy(openPolicy);
    flap.applyPolicy(lockedPolicy);
    flap.applyDeviceUpdate({ deviceTransitPolicyId: 1 });
    const lock = accessory.getService("LockMechanism", "lock")!;
    expect(lock.getCharacteristic("LockCurrentState").value).toBe(1);
  });
});
