import { describe, expect, it } from "vitest";
import {
  decodeEventSummary,
  decodeEventSummaryUpdate,
} from "../../src/api/decoders.js";

describe("decodeEventSummary", () => {
  it("rejects non-objects and missing required fields", () => {
    expect(decodeEventSummary(null)).toBeUndefined();
    expect(decodeEventSummary({ eventId: 1 })).toBeUndefined();
    expect(decodeEventSummary({ deviceId: "d" })).toBeUndefined();
  });

  it("decodes a minimal summary", () => {
    const s = decodeEventSummary({
      deviceId: "d",
      eventId: 1,
    });
    expect(s).toEqual({
      deviceId: "d",
      eventId: 1,
      processedFrameCount: 0,
      subevents: [],
    });
  });

  it("filters out malformed subevents", () => {
    const s = decodeEventSummary({
      deviceId: "d",
      eventId: 1,
      processedFrameCount: 5,
      subevents: [
        {
          direction: "INWARD",
          action: "TRANSIT",
          startFrameIndex: 0,
          endFrameIndex: 1,
          rfidCode: "r",
        },
        { direction: "BAD" },
      ],
    });
    expect(s?.subevents).toHaveLength(1);
    expect(s?.processedFrameCount).toBe(5);
  });

  it("returns empty subevents when subevents is missing", () => {
    const s = decodeEventSummary({
      deviceId: "d",
      eventId: 1,
      processedFrameCount: 0,
    });
    expect(s?.subevents).toEqual([]);
  });
});

describe("decodeEventSummaryUpdate", () => {
  it("rejects non-objects and missing keys", () => {
    expect(decodeEventSummaryUpdate(null)).toBeUndefined();
    expect(decodeEventSummaryUpdate({})).toBeUndefined();
    expect(decodeEventSummaryUpdate({ deviceId: "d" })).toBeUndefined();
  });

  it("decodes the discord-observed envelope shape", () => {
    const u = decodeEventSummaryUpdate({
      deviceId: "OC-XXXX",
      eventId: 9625,
      type: "update",
      timestamp: "2026-04-18T13:58:57.460Z",
      body: {
        deviceId: "OC-XXXX",
        eventId: 9625,
        processedFrameCount: 20,
        subevents: [
          {
            startFrameIndex: 9,
            endFrameIndex: 19,
            rfidCode: "rfid-1",
            direction: "OUTWARD",
            action: "PEEK",
          },
        ],
      },
    });
    expect(u?.body?.subevents).toHaveLength(1);
    expect(u?.body?.subevents[0]!.action).toBe("PEEK");
    expect(u?.type).toBe("update");
  });

  it("preserves an empty body when body is missing", () => {
    const u = decodeEventSummaryUpdate({ deviceId: "d", eventId: 1 });
    expect(u?.body).toBeUndefined();
  });
});
