import { describe, expect, it, vi } from "vitest";
import { OnlyCatClient } from "../src/api/client.js";
import { OnlyCatPlatform } from "../src/platform.js";
import { createMockApi, createMockLogger } from "./helpers/homebridge.js";
import { createMockSocket } from "./helpers/mockSocket.js";

function buildPlatform(opts: { replayDays?: number } = {}) {
  const log = createMockLogger();
  const api = createMockApi();
  const socket = createMockSocket();
  const client = new OnlyCatClient({ token: "tok", log, socket });
  const platform = new OnlyCatPlatform(
    log,
    {
      platform: "OnlyCat",
      name: "OnlyCat",
      token: "tok",
      replayHistoryOnStartup: opts.replayDays,
    },
    api,
    { client },
  );
  return { platform, log, api, socket, client };
}

describe("OnlyCatPlatform.replayHistory", () => {
  it("does nothing when replayHistoryOnStartup is unset or zero", async () => {
    const { api, socket, log } = buildPlatform({ replayDays: 0 });
    socket.__ackResponses.set("getDevices", []);
    api.emit("didFinishLaunching");
    await new Promise((r) => setTimeout(r, 5));
    expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining("Replaying"));
  });

  it("replays events from the requested window", async () => {
    const { platform, api, socket, log } = buildPlatform({ replayDays: 7 });
    socket.__ackResponses.set("getDevices", [{ deviceId: "dev-A" }]);
    socket.__ackResponses.set("getDevice", () => ({ deviceId: "dev-A" }));
    socket.__ackResponses.set("getDeviceTransitPolicies", []);
    socket.__ackResponses.set("getLastSeenRfidCodesByDevice", []);

    const recentTs = new Date().toISOString();
    socket.__ackResponses.set("getDeviceEvents", () => [
      { deviceId: "dev-A", eventId: 1, timestamp: recentTs },
      { deviceId: "dev-A", eventId: 2, timestamp: recentTs },
    ]);
    socket.__ackResponses.set("getEvent", (args: unknown) => ({
      deviceId: "dev-A",
      eventId: (args as { eventId: number }).eventId,
      accessToken: "tok",
      frameCount: 30,
      timestamp: recentTs,
    }));

    const flapStub = {
      replayHistoricalEvent: vi.fn(async () => undefined),
    };
    // monkey-patch the internal flaps map after discovery starts but before replay runs
    api.emit("didFinishLaunching");
    await new Promise((r) => setTimeout(r, 5));
    // After discovery, replace the real FlapAccessory with a stub for replay verification
    (platform as unknown as { flaps: Map<string, unknown> }).flaps.set(
      "dev-A",
      flapStub,
    );

    await platform.replayHistory(7, { gapMs: 1, betweenEventsMs: 0 });

    expect(flapStub.replayHistoricalEvent).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("Replaying %d event"),
      2,
      "dev-A",
    );
  });

  it("filters out events older than the cutoff", async () => {
    const { platform, api, socket } = buildPlatform({ replayDays: 1 });
    socket.__ackResponses.set("getDevices", [{ deviceId: "dev-A" }]);
    socket.__ackResponses.set("getDevice", () => ({ deviceId: "dev-A" }));
    socket.__ackResponses.set("getDeviceTransitPolicies", []);
    socket.__ackResponses.set("getLastSeenRfidCodesByDevice", []);

    const old = new Date(Date.now() - 7 * 86_400_000).toISOString();
    socket.__ackResponses.set("getDeviceEvents", () => [
      { deviceId: "dev-A", eventId: 1, timestamp: old },
    ]);

    const stub = { replayHistoricalEvent: vi.fn() };
    api.emit("didFinishLaunching");
    await new Promise((r) => setTimeout(r, 5));
    (platform as unknown as { flaps: Map<string, unknown> }).flaps.set("dev-A", stub);
    await platform.replayHistory(1, { gapMs: 1, betweenEventsMs: 0 });
    expect(stub.replayHistoricalEvent).not.toHaveBeenCalled();
  });

  it("warns and skips a flap if getDeviceEvents fails", async () => {
    const { platform, api, socket, log } = buildPlatform({ replayDays: 7 });
    socket.__ackResponses.set("getDevices", [{ deviceId: "dev-A" }]);
    socket.__ackResponses.set("getDevice", () => ({ deviceId: "dev-A" }));
    socket.__ackResponses.set("getDeviceTransitPolicies", []);
    socket.__ackResponses.set("getLastSeenRfidCodesByDevice", []);
    socket.__ackResponses.set("getDeviceEvents", () => {
      throw new Error("offline");
    });
    api.emit("didFinishLaunching");
    await new Promise((r) => setTimeout(r, 5));
    await platform.replayHistory(7, { gapMs: 1, betweenEventsMs: 0 });
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("Replay aborted"),
      "dev-A",
      "offline",
    );
  });

  it("warns and continues when a single getEvent fails", async () => {
    const { platform, api, socket, log } = buildPlatform({ replayDays: 7 });
    socket.__ackResponses.set("getDevices", [{ deviceId: "dev-A" }]);
    socket.__ackResponses.set("getDevice", () => ({ deviceId: "dev-A" }));
    socket.__ackResponses.set("getDeviceTransitPolicies", []);
    socket.__ackResponses.set("getLastSeenRfidCodesByDevice", []);
    const recentTs = new Date().toISOString();
    socket.__ackResponses.set("getDeviceEvents", () => [
      { deviceId: "dev-A", eventId: 7, timestamp: recentTs },
    ]);
    socket.__ackResponses.set("getEvent", () => {
      throw new Error("404");
    });
    const stub = { replayHistoricalEvent: vi.fn() };
    api.emit("didFinishLaunching");
    await new Promise((r) => setTimeout(r, 5));
    (platform as unknown as { flaps: Map<string, unknown> }).flaps.set("dev-A", stub);
    await platform.replayHistory(7, { gapMs: 1, betweenEventsMs: 0 });
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("Replay of event"),
      7,
      "dev-A",
      "404",
    );
  });

  it("returns silently when client is null", async () => {
    const log = createMockLogger();
    const api = createMockApi();
    const platform = new OnlyCatPlatform(
      log,
      { platform: "OnlyCat", name: "OnlyCat" },
      api,
    );
    await platform.replayHistory(7, { gapMs: 1, betweenEventsMs: 0 });
    // should not throw
    expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining("Replaying"));
  });
});
