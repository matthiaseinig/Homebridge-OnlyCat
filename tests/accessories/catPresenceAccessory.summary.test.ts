import { describe, expect, it } from "vitest";
import { CatPresenceAccessory } from "../../src/accessories/catPresenceAccessory.js";
import { OnlyCatClient } from "../../src/api/client.js";
import type { RfidProfile, SubEvent } from "../../src/api/types.js";
import {
  MockPlatformAccessory,
  asPlatformAccessory,
  createMockApi,
  createMockLogger,
} from "../helpers/homebridge.js";
import { createMockSocket } from "../helpers/mockSocket.js";

function build() {
  const log = createMockLogger();
  const api = createMockApi();
  const socket = createMockSocket();
  const client = new OnlyCatClient({ token: "tok", log, socket });
  const profile: RfidProfile = {
    deviceId: "dev-1",
    rfidCode: "rfid-1",
    label: "Whiskers",
  };
  const accessory = new MockPlatformAccessory("Whiskers", "uuid:cat-1");
  new CatPresenceAccessory({
    api,
    log,
    client,
    accessory: asPlatformAccessory(accessory),
    profile,
  });
  return { accessory, socket };
}

const sub = (overrides: Partial<SubEvent>): SubEvent => ({
  startFrameIndex: 0,
  endFrameIndex: 5,
  rfidCode: "rfid-1",
  direction: "INWARD",
  action: "TRANSIT",
  ...overrides,
});

describe("CatPresenceAccessory summary-based logic", () => {
  it("flips presence on TRANSIT subevent in the summary", () => {
    const { accessory, socket } = build();
    socket.__emit("eventSummaryUpdate", {
      deviceId: "dev-1",
      eventId: 1,
      body: {
        deviceId: "dev-1",
        eventId: 1,
        processedFrameCount: 10,
        subevents: [sub({ direction: "OUTWARD" })],
      },
    });
    const occ = accessory.getService("OccupancySensor", "presence")!;
    expect(occ.getCharacteristic("OccupancyDetected").value).toBe(0);
  });

  it("does NOT flip presence when the cat only PEEKED", () => {
    const { accessory, socket } = build();
    socket.__emit("eventSummaryUpdate", {
      deviceId: "dev-1",
      eventId: 1,
      body: {
        deviceId: "dev-1",
        eventId: 1,
        processedFrameCount: 10,
        subevents: [sub({ direction: "INWARD", action: "PEEK" })],
      },
    });
    const occ = accessory.getService("OccupancySensor", "presence")!;
    expect(occ.getCharacteristic("OccupancyDetected").value).toBeUndefined();
  });

  it("does NOT flip presence when the cat was DENIED", () => {
    const { accessory, socket } = build();
    socket.__emit("eventSummaryUpdate", {
      deviceId: "dev-1",
      eventId: 1,
      body: {
        deviceId: "dev-1",
        eventId: 1,
        processedFrameCount: 10,
        subevents: [sub({ action: "DENY" })],
      },
    });
    const occ = accessory.getService("OccupancySensor", "presence")!;
    expect(occ.getCharacteristic("OccupancyDetected").value).toBeUndefined();
  });

  it("after a summary TRANSIT, raw subevent direction in the SAME event is ignored", () => {
    const { accessory, socket } = build();
    // Summary settles on INWARD TRANSIT
    socket.__emit("eventSummaryUpdate", {
      deviceId: "dev-1",
      eventId: 1,
      body: {
        deviceId: "dev-1",
        eventId: 1,
        processedFrameCount: 10,
        subevents: [sub({ direction: "INWARD" })],
      },
    });
    // Raw eventUpdate arrives later with an OUTWARD direction (would flip presence
    // under the v0.1 logic). With the summary already trusted, we ignore it.
    socket.__emit("eventUpdate", {
      deviceId: "dev-1",
      eventId: 1,
      subevents: [sub({ direction: "OUTWARD" })],
    });
    const occ = accessory.getService("OccupancySensor", "presence")!;
    expect(occ.getCharacteristic("OccupancyDetected").value).toBe(1);
  });

  it("falls back to raw direction when no summary has produced a TRANSIT yet", () => {
    const { accessory, socket } = build();
    socket.__emit("eventUpdate", {
      deviceId: "dev-1",
      eventId: 9,
      subevents: [sub({ direction: "OUTWARD" })],
    });
    const occ = accessory.getService("OccupancySensor", "presence")!;
    expect(occ.getCharacteristic("OccupancyDetected").value).toBe(0);
  });

  it("a NEW event resets the per-event transit memory so raw fallback works again", () => {
    const { accessory, socket } = build();
    // Event 1 settles via summary
    socket.__emit("eventSummaryUpdate", {
      deviceId: "dev-1",
      eventId: 1,
      body: {
        deviceId: "dev-1",
        eventId: 1,
        processedFrameCount: 10,
        subevents: [sub({ direction: "INWARD" })],
      },
    });
    // New event arrives — without a summary yet, raw direction is used
    socket.__emit("eventUpdate", {
      deviceId: "dev-1",
      eventId: 2,
      subevents: [sub({ direction: "OUTWARD" })],
    });
    const occ = accessory.getService("OccupancySensor", "presence")!;
    expect(occ.getCharacteristic("OccupancyDetected").value).toBe(0);
  });

  it("ignores summaries for other devices", () => {
    const { accessory, socket } = build();
    socket.__emit("eventSummaryUpdate", {
      deviceId: "other-device",
      eventId: 1,
      body: {
        deviceId: "other-device",
        eventId: 1,
        processedFrameCount: 10,
        subevents: [sub({})],
      },
    });
    const occ = accessory.getService("OccupancySensor", "presence")!;
    expect(occ.getCharacteristic("OccupancyDetected").value).toBeUndefined();
  });

  it("ignores summaries without a body", () => {
    const { accessory, socket } = build();
    socket.__emit("eventSummaryUpdate", { deviceId: "dev-1", eventId: 1 });
    const occ = accessory.getService("OccupancySensor", "presence")!;
    expect(occ.getCharacteristic("OccupancyDetected").value).toBeUndefined();
  });

  it("ignores summary subevents whose rfid does not match", () => {
    const { accessory, socket } = build();
    socket.__emit("eventSummaryUpdate", {
      deviceId: "dev-1",
      eventId: 1,
      body: {
        deviceId: "dev-1",
        eventId: 1,
        processedFrameCount: 10,
        subevents: [sub({ rfidCode: "rfid-other" })],
      },
    });
    const occ = accessory.getService("OccupancySensor", "presence")!;
    expect(occ.getCharacteristic("OccupancyDetected").value).toBeUndefined();
  });
});
