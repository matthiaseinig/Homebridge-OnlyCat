import { describe, expect, it } from "vitest";
import { FlapAccessory } from "../../src/accessories/flapAccessory.js";
import { OnlyCatClient } from "../../src/api/client.js";
import type { DeviceRecord } from "../../src/api/types.js";
import {
  MockPlatformAccessory,
  asPlatformAccessory,
  createMockApi,
  createMockLogger,
} from "../helpers/homebridge.js";
import { createMockSocket } from "../helpers/mockSocket.js";

function build(record: Partial<DeviceRecord> = {}) {
  const log = createMockLogger();
  const api = createMockApi();
  const socket = createMockSocket();
  const client = new OnlyCatClient({ token: "tok", log, socket });
  const device: DeviceRecord = { deviceId: "dev-1", ...record };
  const accessory = new MockPlatformAccessory("dev-1", "uuid:dev-1");
  const flap = new FlapAccessory({
    api,
    log,
    client,
    device,
    accessory: asPlatformAccessory(accessory),
  });
  return { flap, accessory, log };
}

describe("FlapAccessory connectivity", () => {
  it("reports online when no connectivity info is available (assumes online)", () => {
    const { accessory } = build();
    const online = accessory.getService("OccupancySensor", "online")!;
    expect(online.getCharacteristic("OccupancyDetected").value).toBe(1);
  });

  it("reports online when connectivity.connected=true", () => {
    const { accessory } = build({
      connectivity: { connected: true },
    });
    const online = accessory.getService("OccupancySensor", "online")!;
    expect(online.getCharacteristic("OccupancyDetected").value).toBe(1);
  });

  it("reports offline + StatusFault when connectivity.connected=false", () => {
    const { accessory } = build({
      connectivity: { connected: false, disconnectReason: "POWER_LOSS" },
    });
    const online = accessory.getService("OccupancySensor", "online")!;
    expect(online.getCharacteristic("OccupancyDetected").value).toBe(0);

    const motion = accessory.getService("MotionSensor", "activity")!;
    expect(motion.getCharacteristic("StatusFault").value).toBe(1);
    const onlineFault = accessory.getService("OccupancySensor", "online")!;
    expect(onlineFault.getCharacteristic("StatusFault").value).toBe(1);
  });

  it("flips Online when applyDeviceUpdate carries new connectivity", () => {
    const { flap, accessory, log } = build({
      connectivity: { connected: true },
    });
    flap.applyDeviceUpdate({
      deviceId: "dev-1",
      connectivity: { connected: false, disconnectReason: "WIFI_LOST" },
    });
    const online = accessory.getService("OccupancySensor", "online")!;
    expect(online.getCharacteristic("OccupancyDetected").value).toBe(0);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("offline"),
      "dev-1",
      expect.stringContaining("WIFI_LOST"),
    );

    flap.applyDeviceUpdate({
      deviceId: "dev-1",
      connectivity: { connected: true },
    });
    expect(online.getCharacteristic("OccupancyDetected").value).toBe(1);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("online"), "dev-1");
  });

  it("does not log a status change when only non-connectivity fields change", () => {
    const { flap, log } = build({ connectivity: { connected: true } });
    log.info.mockClear?.();
    flap.applyDeviceUpdate({ deviceId: "dev-1", description: "Renamed" });
    // Nothing about online/offline should be logged
    const calls = (log.info.mock?.calls ?? []) as unknown as string[][];
    for (const args of calls) {
      const message = args[0] ?? "";
      expect(message).not.toMatch(/online|offline/);
    }
  });

  it("logs offline without parenthetical when disconnectReason is missing", () => {
    const { flap, log } = build({ connectivity: { connected: true } });
    flap.applyDeviceUpdate({
      deviceId: "dev-1",
      connectivity: { connected: false },
    });
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("offline"),
      "dev-1",
      "",
    );
  });
});

describe("FlapAccessory replayHistoricalEvent", () => {
  it("simulates motion-on, then motion-off after the configured gap", async () => {
    const { flap, accessory } = build();
    const motion = accessory.getService("MotionSensor", "activity")!;

    const promise = flap.replayHistoricalEvent(
      {
        deviceId: "dev-1",
        eventId: 99,
        accessToken: "tok",
        frameCount: 30,
      },
      10,
    );

    // Right after the start it should already be on
    await new Promise((r) => setTimeout(r, 0));
    expect(motion.getCharacteristic("MotionDetected").value).toBe(true);

    await promise;
    expect(motion.getCharacteristic("MotionDetected").value).toBe(false);
  });

  it("supplies a default frameCount when the original is missing", async () => {
    const { flap, accessory } = build();
    const motion = accessory.getService("MotionSensor", "activity")!;
    await flap.replayHistoricalEvent(
      { deviceId: "dev-1", eventId: 100 },
      5,
    );
    expect(motion.getCharacteristic("MotionDetected").value).toBe(false);
  });
});
