import { describe, expect, it } from "vitest";
import { FlapAccessory } from "../../src/accessories/flapAccessory.js";
import { OnlyCatClient } from "../../src/api/client.js";
import type { DeviceRecord, EventSummary } from "../../src/api/types.js";
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
  const device: DeviceRecord = { deviceId: "dev-1" };
  const accessory = new MockPlatformAccessory("dev-1", "uuid:dev-1");
  new FlapAccessory({
    api,
    log,
    client,
    device,
    accessory: asPlatformAccessory(accessory),
  });
  return { accessory, socket, log };
}

const summary = (subevents: EventSummary["subevents"]): EventSummary => ({
  deviceId: "dev-1",
  eventId: 5,
  processedFrameCount: 20,
  subevents,
});

describe("FlapAccessory event-summary handling", () => {
  it("subscribes to getEventSummary on a new event", async () => {
    const { socket } = build();
    socket.__ackResponses.set("getEventSummary", null);
    socket.__emit("deviceEventUpdate", { deviceId: "dev-1", eventId: 5 });
    await new Promise((r) => setTimeout(r, 0));
  });

  it("raises Breach occupancy when summary contains a BREACH subevent", () => {
    const { accessory, socket, log } = build();
    socket.__emit("deviceEventUpdate", { deviceId: "dev-1", eventId: 5 });
    socket.__emit("eventSummaryUpdate", {
      deviceId: "dev-1",
      eventId: 5,
      body: summary([
        {
          startFrameIndex: 0,
          endFrameIndex: 5,
          rfidCode: "rfid-1",
          direction: "INWARD",
          action: "BREACH",
        },
      ]),
    });
    const breach = accessory.getService("OccupancySensor", "breach")!;
    expect(breach.getCharacteristic("OccupancyDetected").value).toBe(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("Breach detected"),
      "dev-1",
    );
  });

  it("raises Blocked occupancy when summary contains a DENY subevent", () => {
    const { accessory, socket } = build();
    socket.__emit("deviceEventUpdate", { deviceId: "dev-1", eventId: 5 });
    socket.__emit("eventSummaryUpdate", {
      deviceId: "dev-1",
      eventId: 5,
      body: summary([
        {
          startFrameIndex: 0,
          endFrameIndex: 5,
          rfidCode: null,
          direction: "OUTWARD",
          action: "DENY",
        },
      ]),
    });
    const blocked = accessory.getService("OccupancySensor", "blocked")!;
    expect(blocked.getCharacteristic("OccupancyDetected").value).toBe(1);
  });

  it("clears Breach + Blocked when the event concludes", () => {
    const { accessory, socket } = build();
    socket.__emit("deviceEventUpdate", { deviceId: "dev-1", eventId: 5 });
    socket.__emit("eventSummaryUpdate", {
      deviceId: "dev-1",
      eventId: 5,
      body: summary([
        {
          startFrameIndex: 0,
          endFrameIndex: 5,
          rfidCode: "rfid-1",
          direction: "INWARD",
          action: "BREACH",
        },
      ]),
    });
    socket.__emit("eventUpdate", { deviceId: "dev-1", eventId: 5, frameCount: 30 });
    const breach = accessory.getService("OccupancySensor", "breach")!;
    expect(breach.getCharacteristic("OccupancyDetected").value).toBe(0);
  });

  it("ignores summary updates for other devices", () => {
    const { accessory, socket } = build();
    socket.__emit("eventSummaryUpdate", {
      deviceId: "other-dev",
      eventId: 5,
      body: summary([
        {
          startFrameIndex: 0,
          endFrameIndex: 5,
          rfidCode: "rfid-1",
          direction: "INWARD",
          action: "BREACH",
        },
      ]),
    });
    const breach = accessory.getService("OccupancySensor", "breach")!;
    expect(breach.getCharacteristic("OccupancyDetected").value).toBeUndefined();
  });

  it("ignores summary updates for unrelated event ids", () => {
    const { accessory, socket } = build();
    socket.__emit("deviceEventUpdate", { deviceId: "dev-1", eventId: 5 });
    socket.__emit("eventSummaryUpdate", {
      deviceId: "dev-1",
      eventId: 999,
      body: summary([
        {
          startFrameIndex: 0,
          endFrameIndex: 5,
          rfidCode: "rfid-1",
          direction: "INWARD",
          action: "BREACH",
        },
      ]),
    });
    const breach = accessory.getService("OccupancySensor", "breach")!;
    expect(breach.getCharacteristic("OccupancyDetected").value).toBe(0);
  });

  it("ignores summary updates without a body", () => {
    const { accessory, socket } = build();
    socket.__emit("deviceEventUpdate", { deviceId: "dev-1", eventId: 5 });
    socket.__emit("eventSummaryUpdate", { deviceId: "dev-1", eventId: 5 });
    const breach = accessory.getService("OccupancySensor", "breach")!;
    expect(breach.getCharacteristic("OccupancyDetected").value).toBe(0);
  });

  it("applies a synchronously-returned getEventSummary reply", async () => {
    const { accessory, socket } = build();
    socket.__ackResponses.set("getEventSummary", () =>
      summary([
        {
          startFrameIndex: 0,
          endFrameIndex: 5,
          rfidCode: null,
          direction: "OUTWARD",
          action: "DENY",
        },
      ]),
    );
    socket.__emit("deviceEventUpdate", { deviceId: "dev-1", eventId: 5 });
    await new Promise((r) => setTimeout(r, 0));
    const blocked = accessory.getService("OccupancySensor", "blocked")!;
    expect(blocked.getCharacteristic("OccupancyDetected").value).toBe(1);
  });

  it("logs (debug) and continues when getEventSummary fails", async () => {
    const { socket, log } = build();
    socket.__ackResponses.set("getEventSummary", () => {
      throw new Error("alpha-endpoint-down");
    });
    socket.__emit("deviceEventUpdate", { deviceId: "dev-1", eventId: 5 });
    await new Promise((r) => setTimeout(r, 0));
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining("getEventSummary"),
      "dev-1",
      5,
      "alpha-endpoint-down",
    );
  });
});
