import { describe, expect, it, vi } from "vitest";
import { OnlyCatClient } from "../src/api/client.js";
import { OnlyCatPlatform } from "../src/platform.js";
import { createMockApi, createMockLogger } from "./helpers/homebridge.js";
import { createMockSocket } from "./helpers/mockSocket.js";

function buildPlatform(opts: { token?: string; clientFails?: boolean } = {}) {
  const log = createMockLogger();
  const api = createMockApi();
  const socket = createMockSocket();
  if (opts.clientFails) {
    socket.connect = vi.fn(() => {
      socket.__emit("connect_error", new Error("auth-rejected"));
      return socket;
    }) as unknown as typeof socket.connect;
  }
  const client = new OnlyCatClient({ token: opts.token ?? "tok", log, socket });
  const platform = new OnlyCatPlatform(
    log,
    { platform: "OnlyCat", name: "OnlyCat", token: opts.token },
    api,
    { client: opts.token ? client : undefined },
  );
  return { platform, log, api, client, socket };
}

describe("OnlyCatPlatform", () => {
  it("logs an error and stays idle when no token is configured", () => {
    const { log } = buildPlatform();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("token"));
  });

  it("connects on didFinishLaunching when a token is provided", async () => {
    const { api, log, socket } = buildPlatform({ token: "FakeTok123" });
    socket.__ackResponses.set("getDevices", []);
    api.emit("didFinishLaunching");
    await new Promise((r) => setTimeout(r, 0));
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("Starting"), expect.any(String));
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("initialised"),
      expect.anything(),
      expect.anything(),
    );
  });

  it("logs an error if connect fails but does not crash", async () => {
    const { api, log } = buildPlatform({ token: "tok", clientFails: true });
    api.emit("didFinishLaunching");
    await new Promise((r) => setTimeout(r, 0));
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to connect"),
      expect.any(String),
    );
  });

  it("disconnects the client on shutdown", async () => {
    const { api, client, log } = buildPlatform({ token: "tok" });
    api.emit("didFinishLaunching");
    await new Promise((r) => setTimeout(r, 0));
    api.emit("shutdown");
    expect(client.isConnected()).toBe(false);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("shutting down"));
  });

  it("caches accessories restored by Homebridge", () => {
    const { platform, log } = buildPlatform({ token: "tok" });
    const fakeAccessory = { displayName: "Restored Flap" } as never;
    platform.configureAccessory(fakeAccessory);
    expect(platform.accessories).toHaveLength(1);
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining("Restoring"),
      "Restored Flap",
    );
  });

  it("shutdown is a no-op without a client", () => {
    const { api, log } = buildPlatform();
    api.emit("shutdown");
    expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining("shutting down"));
  });
});
