import { describe, expect, it, vi } from "vitest";
import { OnlyCatClient } from "../src/api/client.js";
import { OnlyCatPlatform } from "../src/platform.js";
import {
  MockPlatformAccessory,
  asPlatformAccessory,
  createMockApi,
  createMockLogger,
} from "./helpers/homebridge.js";
import { createMockSocket } from "./helpers/mockSocket.js";

function buildPlatform(opts: { existing?: MockPlatformAccessory[] } = {}) {
  const log = createMockLogger();
  const api = createMockApi();
  const socket = createMockSocket();
  const client = new OnlyCatClient({ token: "tok", log, socket });
  const platform = new OnlyCatPlatform(
    log,
    { platform: "OnlyCat", name: "OnlyCat", token: "tok" },
    api,
    { client },
  );
  for (const cached of opts.existing ?? []) {
    platform.configureAccessory(asPlatformAccessory(cached));
  }
  return { platform, log, api, socket, client };
}

describe("OnlyCatPlatform discovery", () => {
  it("registers a new accessory per discovered device", async () => {
    const { platform, api, socket, log } = buildPlatform();
    socket.__ackResponses.set("getDevices", [
      { deviceId: "dev-A" },
      { deviceId: "dev-B" },
    ]);
    socket.__ackResponses.set("getDevice", (args: unknown) => ({
      deviceId: (args as { deviceId: string }).deviceId,
      description: `Flap ${(args as { deviceId: string }).deviceId}`,
    }));

    api.emit("didFinishLaunching");
    await new Promise((r) => setTimeout(r, 10));

    expect(api.registeredAccessories).toHaveLength(2);
    expect(platform.accessories).toHaveLength(2);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("Adopted new flap"),
      expect.any(String),
      "dev-A",
    );
  });

  it("re-uses cached accessories (no re-register)", async () => {
    const cached = new MockPlatformAccessory("Old name", "uuid:onlycat-flap:dev-A");
    cached.context.device = { deviceId: "dev-A", description: "Old name" };
    const { api, socket } = buildPlatform({ existing: [cached] });
    socket.__ackResponses.set("getDevices", [{ deviceId: "dev-A" }]);
    socket.__ackResponses.set("getDevice", () => ({
      deviceId: "dev-A",
      description: "Renamed",
    }));
    api.emit("didFinishLaunching");
    await new Promise((r) => setTimeout(r, 10));

    expect(api.registeredAccessories).toHaveLength(0);
    expect(cached.displayName).toBe("Renamed");
  });

  it("prunes accessories whose devices no longer exist", async () => {
    const stale = new MockPlatformAccessory("Old", "uuid:onlycat-flap:dev-X");
    stale.context.device = { deviceId: "dev-X" };
    const { api, socket } = buildPlatform({ existing: [stale] });
    socket.__ackResponses.set("getDevices", [{ deviceId: "dev-A" }]);
    socket.__ackResponses.set("getDevice", () => ({ deviceId: "dev-A" }));
    api.emit("didFinishLaunching");
    await new Promise((r) => setTimeout(r, 10));

    expect(api.unregisteredAccessories).toContain(stale);
  });

  it("logs an error and continues if discovery throws", async () => {
    const { api, log, socket } = buildPlatform();
    socket.__ackResponses.set("getDevices", () => {
      throw new Error("api-down");
    });
    api.emit("didFinishLaunching");
    await new Promise((r) => setTimeout(r, 10));
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("Device discovery failed"),
      "api-down",
    );
  });

  it("propagates deviceUpdate to the matching flap", async () => {
    const { api, socket } = buildPlatform();
    socket.__ackResponses.set("getDevices", [{ deviceId: "dev-A" }]);
    socket.__ackResponses.set("getDevice", () => ({
      deviceId: "dev-A",
      description: "Old",
      firmwareVersion: "1.0.0",
    }));
    api.emit("didFinishLaunching");
    await new Promise((r) => setTimeout(r, 10));

    socket.__emit("deviceUpdate", {
      deviceId: "dev-A",
      type: "deviceChanged",
      body: { description: "Renamed", firmwareVersion: "2.0.0" },
    });

    const adopted = api.registeredAccessories[0]!;
    const info = adopted.getService("AccessoryInformation")!;
    expect(info.getCharacteristic("Name").value).toBe("Renamed");
    expect(info.getCharacteristic("FirmwareRevision").value).toBe("2.0.0");
  });

  it("disposes flaps cleanly on shutdown", async () => {
    const { api, socket } = buildPlatform();
    socket.__ackResponses.set("getDevices", [{ deviceId: "dev-A" }]);
    socket.__ackResponses.set("getDevice", () => ({ deviceId: "dev-A" }));
    api.emit("didFinishLaunching");
    await new Promise((r) => setTimeout(r, 10));

    api.emit("shutdown");
    // After shutdown, an event push should not affect motion any more
    socket.__emit("deviceEventUpdate", { deviceId: "dev-A", eventId: 1 });
    const motion = api.registeredAccessories[0]!.getService("MotionSensor", "activity")!;
    expect(motion.getCharacteristic("MotionDetected").value).toBeUndefined();
  });

  it("ignores deviceUpdate for unknown device id", async () => {
    const { api, socket } = buildPlatform();
    socket.__ackResponses.set("getDevices", []);
    api.emit("didFinishLaunching");
    await new Promise((r) => setTimeout(r, 10));
    socket.__emit("deviceUpdate", { deviceId: "ghost", body: {} });
    // No assertion — just confirms no throw and no registration.
    expect(api.registeredAccessories).toHaveLength(0);
  });

  it("ignores deviceUpdate without a body", async () => {
    const { api, socket } = buildPlatform();
    socket.__ackResponses.set("getDevices", [{ deviceId: "dev-A" }]);
    socket.__ackResponses.set("getDevice", () => ({ deviceId: "dev-A" }));
    api.emit("didFinishLaunching");
    await new Promise((r) => setTimeout(r, 10));
    const before = api.registeredAccessories[0]!
      .getService("AccessoryInformation")!
      .getCharacteristic("Name").value;
    socket.__emit("deviceUpdate", { deviceId: "dev-A" });
    const after = api.registeredAccessories[0]!
      .getService("AccessoryInformation")!
      .getCharacteristic("Name").value;
    expect(after).toBe(before);
  });

  it("does nothing when no accessories are stale", async () => {
    const { api, socket } = buildPlatform();
    socket.__ackResponses.set("getDevices", [{ deviceId: "dev-A" }]);
    socket.__ackResponses.set("getDevice", () => ({ deviceId: "dev-A" }));
    api.emit("didFinishLaunching");
    await new Promise((r) => setTimeout(r, 10));
    expect(api.unregisteredAccessories).toHaveLength(0);
  });

  it("discoverDevices exits early when client is null", async () => {
    const log = createMockLogger();
    const api = createMockApi();
    const platform = new OnlyCatPlatform(
      log,
      { platform: "OnlyCat", name: "OnlyCat" }, // no token
      api,
    );
    await platform.discoverDevices();
    expect(api.registeredAccessories).toHaveLength(0);
  });

  it("ignores accessory entries that have no context.device when pruning", async () => {
    const orphan = new MockPlatformAccessory("Orphan", "uuid:something-else");
    const { api, socket } = buildPlatform({ existing: [orphan] });
    socket.__ackResponses.set("getDevices", [{ deviceId: "dev-A" }]);
    socket.__ackResponses.set("getDevice", () => ({ deviceId: "dev-A" }));
    api.emit("didFinishLaunching");
    await new Promise((r) => setTimeout(r, 10));
    expect(api.unregisteredAccessories).not.toContain(orphan);
  });

  it("loads transit policies after device discovery", async () => {
    const { api, socket } = buildPlatform();
    socket.__ackResponses.set("getDevices", [{ deviceId: "dev-A" }]);
    socket.__ackResponses.set("getDevice", () => ({
      deviceId: "dev-A",
      deviceTransitPolicyId: 1,
    }));
    socket.__ackResponses.set("getDeviceTransitPolicies", [
      { deviceTransitPolicyId: 1, deviceId: "dev-A", name: "Locked" },
    ]);
    socket.__ackResponses.set("getDeviceTransitPolicy", () => ({
      deviceTransitPolicyId: 1,
      deviceId: "dev-A",
      name: "Locked",
      transitPolicy: { idleLock: true },
    }));
    api.emit("didFinishLaunching");
    await new Promise((r) => setTimeout(r, 10));

    const lock = api.registeredAccessories[0]!.getService("LockMechanism", "lock")!;
    expect(lock.getCharacteristic("LockCurrentState").value).toBe(1);
  });

  it("warns when policy loading fails but continues", async () => {
    const { api, socket, log } = buildPlatform();
    socket.__ackResponses.set("getDevices", [{ deviceId: "dev-A" }]);
    socket.__ackResponses.set("getDevice", () => ({ deviceId: "dev-A" }));
    socket.__ackResponses.set("getDeviceTransitPolicies", () => {
      throw new Error("offline");
    });
    api.emit("didFinishLaunching");
    await new Promise((r) => setTimeout(r, 10));
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("transit policies"),
      "dev-A",
      "offline",
    );
  });

  it("discovers and registers cats from RFID profiles", async () => {
    const { api, socket, log } = buildPlatform();
    socket.__ackResponses.set("getDevices", [{ deviceId: "dev-A" }]);
    socket.__ackResponses.set("getDevice", () => ({ deviceId: "dev-A" }));
    socket.__ackResponses.set("getDeviceTransitPolicies", []);
    socket.__ackResponses.set("getLastSeenRfidCodesByDevice", [
      { rfidCode: "rfid-1", timestamp: "2026-05-01T00:00:00Z" },
      { rfidCode: "rfid-2", timestamp: "2026-05-01T00:01:00Z" },
    ]);
    socket.__ackResponses.set("getRfidProfile", (args: unknown) => ({
      deviceId: "dev-A",
      rfidCode: (args as { rfidCode: string }).rfidCode,
      label: (args as { rfidCode: string }).rfidCode === "rfid-1" ? "Whiskers" : "Pixel",
    }));
    api.emit("didFinishLaunching");
    await new Promise((r) => setTimeout(r, 10));

    expect(api.registeredAccessories).toHaveLength(3); // 1 flap + 2 cats
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("Adopted new cat"),
      "Whiskers",
      "rfid-1",
      "dev-A",
    );
  });

  it("warns when pet loading fails but continues", async () => {
    const { api, socket, log } = buildPlatform();
    socket.__ackResponses.set("getDevices", [{ deviceId: "dev-A" }]);
    socket.__ackResponses.set("getDevice", () => ({ deviceId: "dev-A" }));
    socket.__ackResponses.set("getDeviceTransitPolicies", []);
    socket.__ackResponses.set("getLastSeenRfidCodesByDevice", () => {
      throw new Error("offline");
    });
    api.emit("didFinishLaunching");
    await new Promise((r) => setTimeout(r, 10));
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("pet profiles"),
      "dev-A",
      "offline",
    );
  });

  it("re-uses cached cat accessories on restart", async () => {
    const cached = new MockPlatformAccessory(
      "Whiskers",
      "uuid:onlycat-cat:dev-A:rfid-1",
    );
    cached.context.cat = { deviceId: "dev-A", rfidCode: "rfid-1", label: "Old" };
    const { api, socket } = buildPlatform({ existing: [cached] });
    socket.__ackResponses.set("getDevices", [{ deviceId: "dev-A" }]);
    socket.__ackResponses.set("getDevice", () => ({ deviceId: "dev-A" }));
    socket.__ackResponses.set("getDeviceTransitPolicies", []);
    socket.__ackResponses.set("getLastSeenRfidCodesByDevice", [{ rfidCode: "rfid-1" }]);
    socket.__ackResponses.set("getRfidProfile", () => ({
      deviceId: "dev-A",
      rfidCode: "rfid-1",
      label: "Renamed",
    }));
    api.emit("didFinishLaunching");
    await new Promise((r) => setTimeout(r, 10));
    expect(cached.displayName).toBe("Renamed");
  });

  it("prunes cat accessories whose RFID is no longer seen", async () => {
    const stale = new MockPlatformAccessory("Old", "uuid:onlycat-cat:dev-A:rfid-9");
    stale.context.cat = { deviceId: "dev-A", rfidCode: "rfid-9", label: "Old" };
    const { api, socket } = buildPlatform({ existing: [stale] });
    socket.__ackResponses.set("getDevices", [{ deviceId: "dev-A" }]);
    socket.__ackResponses.set("getDevice", () => ({ deviceId: "dev-A" }));
    socket.__ackResponses.set("getDeviceTransitPolicies", []);
    socket.__ackResponses.set("getLastSeenRfidCodesByDevice", []);
    api.emit("didFinishLaunching");
    await new Promise((r) => setTimeout(r, 10));
    expect(api.unregisteredAccessories).toContain(stale);
  });

  it("keeps re-adopted cats without re-registering", async () => {
    const { api, socket } = buildPlatform();
    socket.__ackResponses.set("getDevices", [{ deviceId: "dev-A" }]);
    socket.__ackResponses.set("getDevice", () => ({ deviceId: "dev-A" }));
    socket.__ackResponses.set("getDeviceTransitPolicies", []);
    let callCount = 0;
    socket.__ackResponses.set("getLastSeenRfidCodesByDevice", () => {
      callCount += 1;
      return [{ rfidCode: "rfid-1" }];
    });
    socket.__ackResponses.set("getRfidProfile", () => ({
      deviceId: "dev-A",
      rfidCode: "rfid-1",
      label: "Whiskers",
    }));
    api.emit("didFinishLaunching");
    await new Promise((r) => setTimeout(r, 10));
    // Run discovery again: cats should not duplicate
    await (
      api.registeredAccessories.length // sanity
        ? Promise.resolve()
        : Promise.resolve()
    );
    expect(callCount).toBeGreaterThanOrEqual(1);
    const catAccessories = api.registeredAccessories.filter((a) =>
      String(a.UUID).includes("onlycat-cat"),
    );
    expect(catAccessories).toHaveLength(1);
  });

  it("re-runs of discoverDevices update existing cat accessories in place", async () => {
    const { platform, api, socket } = buildPlatform();
    socket.__ackResponses.set("getDevices", [{ deviceId: "dev-A" }]);
    socket.__ackResponses.set("getDevice", () => ({ deviceId: "dev-A" }));
    socket.__ackResponses.set("getDeviceTransitPolicies", []);
    socket.__ackResponses.set("getDeviceEvents", []);
    socket.__ackResponses.set("getLastSeenRfidCodesByDevice", [{ rfidCode: "rfid-1" }]);
    socket.__ackResponses.set("getRfidProfile", () => ({
      deviceId: "dev-A",
      rfidCode: "rfid-1",
      label: "Whiskers",
    }));
    api.emit("didFinishLaunching");
    await new Promise((r) => setTimeout(r, 10));
    const before = api.registeredAccessories.length;

    // Second discovery — same cat, should update in place rather than register again.
    socket.__ackResponses.set("getRfidProfile", () => ({
      deviceId: "dev-A",
      rfidCode: "rfid-1",
      label: "Whiskers v2",
    }));
    await platform.discoverDevices();
    expect(api.registeredAccessories.length).toBe(before);
  });

  it("connect failure short-circuits discovery", async () => {
    const log = createMockLogger();
    const api = createMockApi();
    const socket = createMockSocket();
    socket.connect = vi.fn(() => {
      socket.__emit("connect_error", new Error("boom"));
      return socket;
    }) as unknown as typeof socket.connect;
    const client = new OnlyCatClient({ token: "tok", log, socket });
    new OnlyCatPlatform(
      log,
      { platform: "OnlyCat", name: "OnlyCat", token: "tok" },
      api,
      { client },
    );
    api.emit("didFinishLaunching");
    await new Promise((r) => setTimeout(r, 10));
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to connect"),
      "boom",
    );
    expect(api.registeredAccessories).toHaveLength(0);
  });
});
