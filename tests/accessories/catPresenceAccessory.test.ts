import { describe, expect, it } from "vitest";
import { CatPresenceAccessory } from "../../src/accessories/catPresenceAccessory.js";
import { OnlyCatClient } from "../../src/api/client.js";
import type { RfidProfile } from "../../src/api/types.js";
import {
  MockPlatformAccessory,
  asPlatformAccessory,
  createMockApi,
  createMockLogger,
} from "../helpers/homebridge.js";
import { createMockSocket } from "../helpers/mockSocket.js";

function build(profile: Partial<RfidProfile> = {}) {
  const log = createMockLogger();
  const api = createMockApi();
  const socket = createMockSocket();
  const client = new OnlyCatClient({ token: "tok", log, socket });
  const fullProfile: RfidProfile = {
    deviceId: "dev-1",
    rfidCode: "rfid-1",
    label: "Whiskers",
    ...profile,
  };
  const accessory = new MockPlatformAccessory(
    fullProfile.label ?? fullProfile.rfidCode,
    `uuid:onlycat-cat:${fullProfile.deviceId}:${fullProfile.rfidCode}`,
  );
  const cat = new CatPresenceAccessory({
    api,
    log,
    client,
    accessory: asPlatformAccessory(accessory),
    profile: fullProfile,
  });
  return { cat, accessory, socket, log };
}

describe("CatPresenceAccessory", () => {
  it("populates AccessoryInformation with the pet label", () => {
    const { accessory } = build();
    const info = accessory.getService("AccessoryInformation")!;
    expect(info.getCharacteristic("Manufacturer").value).toBe("OnlyCat");
    expect(info.getCharacteristic("Model").value).toBe("OnlyCat Pet");
    expect(info.getCharacteristic("SerialNumber").value).toBe("rfid-1");
    expect(info.getCharacteristic("Name").value).toBe("Whiskers");
  });

  it("falls back to 'Cat RFID <code>' when no label is provided", () => {
    const { accessory } = build({ label: undefined });
    const info = accessory.getService("AccessoryInformation")!;
    expect(info.getCharacteristic("Name").value).toBe("Cat RFID rfid-1");
  });

  it("ignores events for other devices", () => {
    const { accessory, socket } = build();
    socket.__emit("deviceEventUpdate", {
      deviceId: "other",
      eventId: 1,
      subevents: [
        {
          direction: "INWARD",
          action: "TRANSIT",
          startFrameIndex: 0,
          endFrameIndex: 10,
          rfidCode: "rfid-1",
        },
      ],
    });
    const occ = accessory.getService("OccupancySensor", "presence")!;
    expect(occ.getCharacteristic("OccupancyDetected").value).toBeUndefined();
  });

  it("ignores events without subevents containing this rfid", () => {
    const { accessory, socket } = build();
    socket.__emit("deviceEventUpdate", {
      deviceId: "dev-1",
      eventId: 5,
      subevents: [
        {
          direction: "INWARD",
          action: "TRANSIT",
          startFrameIndex: 0,
          endFrameIndex: 1,
          rfidCode: "rfid-other",
        },
      ],
    });
    const occ = accessory.getService("OccupancySensor", "presence")!;
    expect(occ.getCharacteristic("OccupancyDetected").value).toBeUndefined();
  });

  it("ignores events with no subevents at all", () => {
    const { accessory, socket } = build();
    socket.__emit("deviceEventUpdate", {
      deviceId: "dev-1",
      eventId: 5,
    });
    const occ = accessory.getService("OccupancySensor", "presence")!;
    expect(occ.getCharacteristic("OccupancyDetected").value).toBeUndefined();
  });

  it("flips presence to home on INWARD subevent", () => {
    const { accessory, socket } = build();
    socket.__emit("eventUpdate", {
      deviceId: "dev-1",
      eventId: 5,
      subevents: [
        {
          direction: "INWARD",
          action: "TRANSIT",
          startFrameIndex: 0,
          endFrameIndex: 1,
          rfidCode: "rfid-1",
        },
      ],
    });
    const occ = accessory.getService("OccupancySensor", "presence")!;
    expect(occ.getCharacteristic("OccupancyDetected").value).toBe(1);
  });

  it("flips presence to away on OUTWARD subevent", () => {
    const { accessory, socket } = build();
    socket.__emit("eventUpdate", {
      deviceId: "dev-1",
      eventId: 5,
      subevents: [
        {
          direction: "OUTWARD",
          action: "TRANSIT",
          startFrameIndex: 0,
          endFrameIndex: 1,
          rfidCode: "rfid-1",
        },
      ],
    });
    const occ = accessory.getService("OccupancySensor", "presence")!;
    expect(occ.getCharacteristic("OccupancyDetected").value).toBe(0);
  });

  it("uses the LAST subevent for this cat in a multi-subevent push", () => {
    const { accessory, socket } = build();
    socket.__emit("eventUpdate", {
      deviceId: "dev-1",
      eventId: 5,
      subevents: [
        {
          direction: "INWARD",
          action: "TRANSIT",
          startFrameIndex: 0,
          endFrameIndex: 1,
          rfidCode: "rfid-1",
        },
        {
          direction: "OUTWARD",
          action: "TRANSIT",
          startFrameIndex: 2,
          endFrameIndex: 3,
          rfidCode: "rfid-1",
        },
      ],
    });
    const occ = accessory.getService("OccupancySensor", "presence")!;
    expect(occ.getCharacteristic("OccupancyDetected").value).toBe(0);
  });

  it("setInitialPresence updates state directly", () => {
    const { cat, accessory } = build();
    cat.setInitialPresence(true);
    const occ = accessory.getService("OccupancySensor", "presence")!;
    expect(occ.getCharacteristic("OccupancyDetected").value).toBe(1);
  });

  it("applyProfileUpdate refreshes label", () => {
    const { cat, accessory } = build();
    cat.applyProfileUpdate({ deviceId: "dev-1", rfidCode: "rfid-1", label: "Mr. Whiskers" });
    const info = accessory.getService("AccessoryInformation")!;
    expect(info.getCharacteristic("Name").value).toBe("Mr. Whiskers");
  });

  it("dispose removes listeners", () => {
    const { cat, socket, accessory } = build();
    cat.dispose();
    socket.__emit("deviceEventUpdate", {
      deviceId: "dev-1",
      eventId: 6,
      subevents: [
        {
          direction: "INWARD",
          action: "TRANSIT",
          startFrameIndex: 0,
          endFrameIndex: 1,
          rfidCode: "rfid-1",
        },
      ],
    });
    const occ = accessory.getService("OccupancySensor", "presence")!;
    expect(occ.getCharacteristic("OccupancyDetected").value).toBeUndefined();
  });

  it("re-uses cached presence service on restored accessory", () => {
    const log = createMockLogger();
    const api = createMockApi();
    const socket = createMockSocket();
    const client = new OnlyCatClient({ token: "tok", log, socket });
    const profile: RfidProfile = {
      deviceId: "dev-1",
      rfidCode: "rfid-2",
      label: "Pixel",
    };
    const accessory = new MockPlatformAccessory("Pixel", "uuid:cached-cat");
    new CatPresenceAccessory({
      api,
      log,
      client,
      accessory: asPlatformAccessory(accessory),
      profile,
    });
    new CatPresenceAccessory({
      api,
      log,
      client,
      accessory: asPlatformAccessory(accessory),
      profile,
    });
    expect(accessory.services.filter((s) => s.type === "OccupancySensor")).toHaveLength(1);
  });
});
