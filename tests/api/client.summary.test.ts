import { describe, expect, it, vi } from "vitest";
import { OnlyCatClient } from "../../src/api/client.js";
import { createMockLogger } from "../helpers/homebridge.js";
import { createMockSocket } from "../helpers/mockSocket.js";

describe("OnlyCatClient eventSummaryUpdate handling", () => {
  it("dispatches valid eventSummaryUpdate to listeners", () => {
    const log = createMockLogger();
    const socket = createMockSocket();
    const client = new OnlyCatClient({ token: "tok", log, socket });
    const handler = vi.fn();
    client.on("eventSummaryUpdate", handler);
    socket.__emit("eventSummaryUpdate", {
      deviceId: "d",
      eventId: 1,
      body: { deviceId: "d", eventId: 1, processedFrameCount: 0, subevents: [] },
    });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: "d", eventId: 1 }),
    );
  });

  it("warns and drops malformed eventSummaryUpdate", () => {
    const log = createMockLogger();
    const socket = createMockSocket();
    const client = new OnlyCatClient({ token: "tok", log, socket });
    const handler = vi.fn();
    client.on("eventSummaryUpdate", handler);
    socket.__emit("eventSummaryUpdate", "not-an-object");
    expect(handler).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it("getEventSummary RPC uses the typed reply", async () => {
    const log = createMockLogger();
    const socket = createMockSocket();
    const client = new OnlyCatClient({ token: "tok", log, socket });
    socket.__ackResponses.set("getEventSummary", {
      deviceId: "d",
      eventId: 1,
      processedFrameCount: 20,
      subevents: [],
    });
    const reply = await client.call("getEventSummary", {
      deviceId: "d",
      eventId: 1,
      subscribe: true,
    });
    expect(reply).toEqual({
      deviceId: "d",
      eventId: 1,
      processedFrameCount: 20,
      subevents: [],
    });
  });
});
