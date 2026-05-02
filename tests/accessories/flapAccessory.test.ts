import { describe, expect, it } from "vitest";
import { FlapAccessory } from "../../src/accessories/flapAccessory.js";
import { OnlyCatClient } from "../../src/api/client.js";
import {
  EventClassification,
  type DeviceRecord,
} from "../../src/api/types.js";
import {
  MockPlatformAccessory,
  asPlatformAccessory,
  createMockApi,
  createMockLogger,
} from "../helpers/homebridge.js";
import { createMockSocket } from "../helpers/mockSocket.js";

function build(overrides: Partial<DeviceRecord> = {}) {
  const log = createMockLogger();
  const api = createMockApi();
  const socket = createMockSocket();
  const client = new OnlyCatClient({ token: "tok", log, socket });
  const device: DeviceRecord = {
    deviceId: "dev-1",
    description: "Front door",
    modelName: "OnlyCat Pro",
    firmwareVersion: "1.2.3",
    ...overrides,
  };
  const accessory = new MockPlatformAccessory("Front door", "uuid:dev-1");
  const flap = new FlapAccessory({
    api,
    log,
    client,
    device,
    accessory: asPlatformAccessory(accessory),
  });
  return { flap, accessory, client, socket, api, log };
}

describe("FlapAccessory", () => {
  it("populates AccessoryInformation from the device record", () => {
    const { accessory } = build();
    const info = accessory.getService("AccessoryInformation")!;
    expect(info.getCharacteristic("Manufacturer").value).toBe("OnlyCat");
    expect(info.getCharacteristic("Model").value).toBe("OnlyCat Pro");
    expect(info.getCharacteristic("SerialNumber").value).toBe("dev-1");
    expect(info.getCharacteristic("FirmwareRevision").value).toBe("1.2.3");
    expect(info.getCharacteristic("Name").value).toBe("Front door");
  });

  it("falls back to safe defaults when device fields are missing", () => {
    const { accessory } = build({
      description: undefined,
      modelName: undefined,
      firmwareVersion: undefined,
    });
    const info = accessory.getService("AccessoryInformation")!;
    expect(info.getCharacteristic("Model").value).toBe("OnlyCat Smart Cat Flap");
    expect(info.getCharacteristic("FirmwareRevision").value).toBe("0.0.0");
    expect(info.getCharacteristic("Name").value).toBe("OnlyCat Flap");
  });

  it("ignores events for other devices", () => {
    const { accessory, socket } = build();
    socket.__emit("deviceEventUpdate", { deviceId: "other", eventId: 1 });
    const motion = accessory.getService("MotionSensor", "activity")!;
    expect(motion.getCharacteristic("MotionDetected").value).toBeUndefined();
  });

  it("flips MotionDetected on event start, off on event end", () => {
    const { accessory, socket } = build();
    socket.__emit("deviceEventUpdate", { deviceId: "dev-1", eventId: 5 });
    const motion = accessory.getService("MotionSensor", "activity")!;
    expect(motion.getCharacteristic("MotionDetected").value).toBe(true);

    socket.__emit("eventUpdate", { deviceId: "dev-1", eventId: 5, frameCount: 30 });
    expect(motion.getCharacteristic("MotionDetected").value).toBe(false);
  });

  it("raises Contraband occupancy on classification, clears on event end", () => {
    const { accessory, socket } = build();
    socket.__emit("deviceEventUpdate", {
      deviceId: "dev-1",
      eventId: 5,
      eventClassification: EventClassification.Contraband,
    });
    const contraband = accessory.getService("OccupancySensor", "contraband")!;
    expect(contraband.getCharacteristic("OccupancyDetected").value).toBe(1);

    socket.__emit("eventUpdate", { deviceId: "dev-1", eventId: 5, frameCount: 12 });
    expect(contraband.getCharacteristic("OccupancyDetected").value).toBe(0);
  });

  it("raises Human occupancy on classification HUMAN_ACTIVITY", () => {
    const { accessory, socket } = build();
    socket.__emit("deviceEventUpdate", {
      deviceId: "dev-1",
      eventId: 6,
      eventClassification: EventClassification.HumanActivity,
    });
    const human = accessory.getService("OccupancySensor", "human")!;
    expect(human.getCharacteristic("OccupancyDetected").value).toBe(1);
  });

  it("upgrades classification mid-event when the next push reveals it", () => {
    const { accessory, socket } = build();
    socket.__emit("deviceEventUpdate", { deviceId: "dev-1", eventId: 7 });
    const contraband = accessory.getService("OccupancySensor", "contraband")!;
    expect(contraband.getCharacteristic("OccupancyDetected").value).toBe(0);

    socket.__emit("eventUpdate", {
      deviceId: "dev-1",
      eventId: 7,
      eventClassification: EventClassification.Contraband,
    });
    expect(contraband.getCharacteristic("OccupancyDetected").value).toBe(1);
  });

  it("re-uses cached services on a restored accessory (no duplicates)", () => {
    const log = createMockLogger();
    const api = createMockApi();
    const socket = createMockSocket();
    const client = new OnlyCatClient({ token: "tok", log, socket });
    const device: DeviceRecord = { deviceId: "d-2" };
    const accessory = new MockPlatformAccessory("Cached", "uuid:d-2");
    new FlapAccessory({ api, log, client, device, accessory: asPlatformAccessory(accessory) });
    new FlapAccessory({ api, log, client, device, accessory: asPlatformAccessory(accessory) });
    expect(accessory.services.filter((s) => s.type === "MotionSensor")).toHaveLength(1);
    expect(accessory.services.filter((s) => s.type === "OccupancySensor")).toHaveLength(5);
  });

  it("applyDeviceUpdate refreshes AccessoryInformation", () => {
    const { flap, accessory } = build();
    flap.applyDeviceUpdate({
      deviceId: "dev-1",
      description: "Back door",
      firmwareVersion: "2.0.0",
    });
    const info = accessory.getService("AccessoryInformation")!;
    expect(info.getCharacteristic("Name").value).toBe("Back door");
    expect(info.getCharacteristic("FirmwareRevision").value).toBe("2.0.0");
  });

  it("dispose unsubscribes listeners", () => {
    const { flap, socket, accessory } = build();
    flap.dispose();
    socket.__emit("deviceEventUpdate", { deviceId: "dev-1", eventId: 99 });
    const motion = accessory.getService("MotionSensor", "activity")!;
    expect(motion.getCharacteristic("MotionDetected").value).toBeUndefined();
  });
});
