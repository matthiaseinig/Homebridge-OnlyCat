import { describe, expect, it } from "vitest";
import {
  decodeDeviceUpdate,
  decodeEvent,
  decodeEventPush,
  decodeSubEvent,
} from "../../src/api/decoders.js";
import { EventClassification, EventTriggerSource } from "../../src/api/types.js";

describe("decodeSubEvent", () => {
  it("returns undefined for non-objects", () => {
    expect(decodeSubEvent(null)).toBeUndefined();
    expect(decodeSubEvent("foo")).toBeUndefined();
    expect(decodeSubEvent([])).toBeUndefined();
  });

  it("returns undefined when required fields are missing or wrong type", () => {
    expect(decodeSubEvent({ direction: "FOO" })).toBeUndefined();
    expect(decodeSubEvent({ direction: "INWARD", action: "BAD" })).toBeUndefined();
    expect(
      decodeSubEvent({
        direction: "INWARD",
        action: "TRANSIT",
        startFrameIndex: "x",
        endFrameIndex: 0,
      }),
    ).toBeUndefined();
    expect(
      decodeSubEvent({
        direction: "INWARD",
        action: "TRANSIT",
        startFrameIndex: 0,
      }),
    ).toBeUndefined();
  });

  it("decodes a valid subevent", () => {
    const sub = decodeSubEvent({
      direction: "OUTWARD",
      action: "TRANSIT",
      startFrameIndex: 12,
      endFrameIndex: 25,
      rfidCode: "abc",
    });
    expect(sub).toEqual({
      direction: "OUTWARD",
      action: "TRANSIT",
      startFrameIndex: 12,
      endFrameIndex: 25,
      rfidCode: "abc",
    });
  });

  it("defaults rfidCode to null when not a string", () => {
    expect(
      decodeSubEvent({
        direction: "INWARD",
        action: "PEEK",
        startFrameIndex: 0,
        endFrameIndex: 1,
      })?.rfidCode,
    ).toBeNull();
  });
});

describe("decodeEvent", () => {
  it("rejects non-objects", () => {
    expect(decodeEvent(null)).toBeUndefined();
    expect(decodeEvent(42)).toBeUndefined();
  });

  it("requires deviceId and eventId", () => {
    expect(decodeEvent({ eventId: 1 })).toBeUndefined();
    expect(decodeEvent({ deviceId: "abc" })).toBeUndefined();
  });

  it("decodes a complete event", () => {
    const ev = decodeEvent({
      deviceId: "dev-1",
      eventId: 42,
      globalId: 100,
      timestamp: "2026-05-01T00:00:00Z",
      frameCount: 30,
      eventTriggerSource: EventTriggerSource.IndoorMotion,
      eventClassification: EventClassification.Contraband,
      posterFrameIndex: 5,
      accessToken: "tok",
      rfidCodes: ["rfid-1", "rfid-2", 7],
      subevents: [
        {
          direction: "INWARD",
          action: "TRANSIT",
          startFrameIndex: 0,
          endFrameIndex: 10,
          rfidCode: "rfid-1",
        },
        { direction: "BAD" },
      ],
    });
    expect(ev?.deviceId).toBe("dev-1");
    expect(ev?.eventClassification).toBe(EventClassification.Contraband);
    expect(ev?.rfidCodes).toEqual(["rfid-1", "rfid-2"]);
    expect(ev?.subevents).toHaveLength(1);
    expect(ev?.frameCount).toBe(30);
  });

  it("preserves explicit null frameCount", () => {
    const ev = decodeEvent({ deviceId: "d", eventId: 1, frameCount: null });
    expect(ev?.frameCount).toBeNull();
  });

  it("ignores unknown enum values", () => {
    const ev = decodeEvent({
      deviceId: "d",
      eventId: 1,
      eventTriggerSource: 999,
      eventClassification: 999,
    });
    expect(ev?.eventTriggerSource).toBeUndefined();
    expect(ev?.eventClassification).toBeUndefined();
  });

  it("decodeEventPush returns a typed event push", () => {
    const ev = decodeEventPush({ deviceId: "d", eventId: 1 });
    expect(ev?.deviceId).toBe("d");
  });

  it("decodeEventPush rejects malformed", () => {
    expect(decodeEventPush(null)).toBeUndefined();
  });
});

describe("decodeDeviceUpdate", () => {
  it("rejects non-objects and missing deviceId", () => {
    expect(decodeDeviceUpdate(null)).toBeUndefined();
    expect(decodeDeviceUpdate({})).toBeUndefined();
  });

  it("decodes minimal payload", () => {
    expect(decodeDeviceUpdate({ deviceId: "d" })).toEqual({
      deviceId: "d",
      type: undefined,
      body: undefined,
    });
  });

  it("preserves type and body", () => {
    const upd = decodeDeviceUpdate({
      deviceId: "d",
      type: "policyChanged",
      body: { deviceTransitPolicyId: 1 },
    });
    expect(upd?.type).toBe("policyChanged");
    expect(upd?.body).toEqual({ deviceTransitPolicyId: 1 });
  });

  it("ignores non-object body", () => {
    expect(decodeDeviceUpdate({ deviceId: "d", body: "bad" })?.body).toBeUndefined();
  });
});
