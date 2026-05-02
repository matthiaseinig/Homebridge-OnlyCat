import { describe, expect, it, vi } from "vitest";
import { OnlyCatClient } from "../src/api/client.js";
import { OnlyCatPlatform } from "../src/platform.js";
import { createMockApi, createMockLogger } from "./helpers/homebridge.js";
import { createMockSocket } from "./helpers/mockSocket.js";

function buildPlatform() {
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
  return { platform, log, api, socket, client };
}

const recentEvent = {
  deviceId: "dev-A",
  eventId: 42,
  timestamp: new Date().toISOString(),
  accessToken: "tok-X",
  posterFrameIndex: 5,
  frameCount: 30,
};

describe("OnlyCatPlatform event subscriptions", () => {
  it("subscribes to events for each discovered flap", async () => {
    const { api, socket } = buildPlatform();
    socket.__ackResponses.set("getDevices", [{ deviceId: "dev-A" }]);
    socket.__ackResponses.set("getDevice", () => ({ deviceId: "dev-A" }));
    socket.__ackResponses.set("getDeviceTransitPolicies", []);
    socket.__ackResponses.set("getLastSeenRfidCodesByDevice", []);
    const events: unknown[][] = [];
    socket.__ackResponses.set("getDeviceEvents", (args) => {
      events.push([args]);
      return [recentEvent];
    });
    api.emit("didFinishLaunching");
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toHaveLength(1);
    expect(events[0]![0]).toEqual({ deviceId: "dev-A", subscribe: true });
  });

  it("primes the event cache from the most recent concluded event", async () => {
    const { api, socket, log } = buildPlatform();
    socket.__ackResponses.set("getDevices", [{ deviceId: "dev-A" }]);
    socket.__ackResponses.set("getDevice", () => ({ deviceId: "dev-A" }));
    socket.__ackResponses.set("getDeviceTransitPolicies", []);
    socket.__ackResponses.set("getLastSeenRfidCodesByDevice", []);
    socket.__ackResponses.set("getDeviceEvents", () => [
      // Older event, should NOT be picked
      {
        deviceId: "dev-A",
        eventId: 1,
        timestamp: "2026-01-01T00:00:00Z",
        accessToken: "old-tok",
        posterFrameIndex: 0,
        frameCount: 30,
      },
      recentEvent,
    ]);
    api.emit("didFinishLaunching");
    await new Promise((r) => setTimeout(r, 10));
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining("Primed"),
      "dev-A",
      42,
    );
  });

  it("warns when getDeviceEvents fails but does not crash discovery", async () => {
    const { api, socket, log } = buildPlatform();
    socket.__ackResponses.set("getDevices", [{ deviceId: "dev-A" }]);
    socket.__ackResponses.set("getDevice", () => ({ deviceId: "dev-A" }));
    socket.__ackResponses.set("getDeviceTransitPolicies", []);
    socket.__ackResponses.set("getLastSeenRfidCodesByDevice", []);
    socket.__ackResponses.set("getDeviceEvents", () => {
      throw new Error("offline");
    });
    api.emit("didFinishLaunching");
    await new Promise((r) => setTimeout(r, 10));
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not subscribe"),
      "dev-A",
      "offline",
    );
  });

  it("re-subscribes on connect (e.g. after reconnect)", async () => {
    const { api, socket } = buildPlatform();
    socket.__ackResponses.set("getDevices", [{ deviceId: "dev-A" }]);
    socket.__ackResponses.set("getDevice", () => ({ deviceId: "dev-A" }));
    socket.__ackResponses.set("getDeviceTransitPolicies", []);
    socket.__ackResponses.set("getLastSeenRfidCodesByDevice", []);
    let eventsCalls = 0;
    socket.__ackResponses.set("getDeviceEvents", () => {
      eventsCalls += 1;
      return [recentEvent];
    });
    api.emit("didFinishLaunching");
    await new Promise((r) => setTimeout(r, 10));
    expect(eventsCalls).toBe(1);

    // Simulate reconnect: emit another connect event from the socket
    socket.__emit("connect");
    await new Promise((r) => setTimeout(r, 10));
    expect(eventsCalls).toBeGreaterThanOrEqual(2);
  });

  it("refreshSubscriptions warns when a per-device call fails", async () => {
    const { platform, api, socket, log } = buildPlatform();
    socket.__ackResponses.set("getDevices", [{ deviceId: "dev-A" }]);
    socket.__ackResponses.set("getDevice", () => ({ deviceId: "dev-A" }));
    socket.__ackResponses.set("getDeviceTransitPolicies", []);
    socket.__ackResponses.set("getLastSeenRfidCodesByDevice", []);
    socket.__ackResponses.set("getDeviceEvents", []);
    api.emit("didFinishLaunching");
    await new Promise((r) => setTimeout(r, 10));

    // After discovery, swap getDevice to throw on next call
    socket.__ackResponses.set("getDevice", () => {
      throw new Error("net-down");
    });
    await platform.refreshSubscriptions();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to refresh"),
      "dev-A",
      "net-down",
    );
  });

  it("refreshSubscriptions returns silently when client is null", async () => {
    const log = createMockLogger();
    const api = createMockApi();
    const platform = new OnlyCatPlatform(
      log,
      { platform: "OnlyCat", name: "OnlyCat" },
      api,
    );
    await platform.refreshSubscriptions();
    expect(log.warn).not.toHaveBeenCalled();
  });
});
