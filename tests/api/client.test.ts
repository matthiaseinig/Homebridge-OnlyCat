import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnlyCatClient } from "../../src/api/client.js";
import { createMockLogger } from "../helpers/homebridge.js";
import { createMockSocket, type MockSocket } from "../helpers/mockSocket.js";

describe("OnlyCatClient", () => {
  let socket: MockSocket;
  let log: ReturnType<typeof createMockLogger>;
  let client: OnlyCatClient;

  beforeEach(() => {
    socket = createMockSocket();
    log = createMockLogger();
    client = new OnlyCatClient({ token: "FakeTok123", log, socket, debug: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("connect/disconnect", () => {
    it("resolves on connect", async () => {
      await client.connect();
      expect(client.isConnected()).toBe(true);
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("Connected"));
    });

    it("is a no-op when already connected", async () => {
      await client.connect();
      await client.connect();
      expect(socket.connect).toHaveBeenCalledTimes(1);
    });

    it("rejects on connect_error", async () => {
      const fail = new OnlyCatClient({ token: "tok-12345", log, socket: createMockSocket() });
      const failSocket = (fail as unknown as { socket: MockSocket }).socket;
      failSocket.connect = vi.fn(() => {
        failSocket.__emit("connect_error", new Error("boom"));
        return failSocket;
      }) as unknown as MockSocket["connect"];
      await expect(fail.connect()).rejects.toThrow("boom");
    });

    it("disconnects cleanly", async () => {
      await client.connect();
      client.disconnect();
      expect(client.isConnected()).toBe(false);
      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining("Disconnected"),
        expect.any(String),
      );
    });
  });

  describe("RPCs", () => {
    it("emitWithAck returns the registered response", async () => {
      socket.__ackResponses.set("getDevices", [{ deviceId: "d-1" }]);
      const reply = await client.call("getDevices", { subscribe: true });
      expect(reply).toEqual([{ deviceId: "d-1" }]);
      expect(log.debug).toHaveBeenCalledWith(expect.stringContaining("RPC ->"), "getDevices", expect.anything());
    });

    it("logs RPC arguments at debug level", async () => {
      socket.__ackResponses.set("getDevice", { deviceId: "d-1" });
      await client.call("getDevice", { deviceId: "d-1" });
      expect(log.debug).toHaveBeenCalledWith(
        expect.stringContaining("RPC ->"),
        "getDevice",
        expect.anything(),
      );
    });
  });

  describe("event dispatch", () => {
    it("dispatches deviceEventUpdate after decoding", () => {
      const handler = vi.fn();
      client.on("deviceEventUpdate", handler);
      socket.__emit("deviceEventUpdate", { deviceId: "d", eventId: 1 });
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ deviceId: "d", eventId: 1 }));
    });

    it("warns and drops malformed deviceEventUpdate", () => {
      const handler = vi.fn();
      client.on("deviceEventUpdate", handler);
      socket.__emit("deviceEventUpdate", "not-an-object");
      expect(handler).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("malformed"));
    });

    it("dispatches eventUpdate after decoding", () => {
      const handler = vi.fn();
      client.on("eventUpdate", handler);
      socket.__emit("eventUpdate", { deviceId: "d", eventId: 2 });
      expect(handler).toHaveBeenCalled();
    });

    it("warns and drops malformed eventUpdate", () => {
      const handler = vi.fn();
      client.on("eventUpdate", handler);
      socket.__emit("eventUpdate", null);
      expect(handler).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalled();
    });

    it("dispatches deviceUpdate after decoding", () => {
      const handler = vi.fn();
      client.on("deviceUpdate", handler);
      socket.__emit("deviceUpdate", { deviceId: "d", type: "policy" });
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ deviceId: "d" }));
    });

    it("warns and drops malformed deviceUpdate", () => {
      const handler = vi.fn();
      client.on("deviceUpdate", handler);
      socket.__emit("deviceUpdate", null);
      expect(handler).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalled();
    });

    it("forwards userUpdate raw", () => {
      const handler = vi.fn();
      client.on("userUpdate", handler);
      socket.__emit("userUpdate", { id: "u-1" });
      expect(handler).toHaveBeenCalledWith({ id: "u-1" });
    });

    it("dispatches connect to typed listeners", async () => {
      const handler = vi.fn();
      client.on("connect", handler);
      await client.connect();
      expect(handler).toHaveBeenCalled();
    });

    it("dispatches disconnect to typed listeners with reason", async () => {
      const handler = vi.fn();
      client.on("disconnect", handler);
      await client.connect();
      client.disconnect();
      expect(handler).toHaveBeenCalledWith(expect.any(String));
    });

    it("logs warning on connect_error", () => {
      socket.__emit("connect_error", new Error("nope"));
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("connection error"), "nope");
    });

    it("removes listeners via off()", () => {
      const handler = vi.fn();
      client.on("eventUpdate", handler);
      client.off("eventUpdate", handler);
      socket.__emit("eventUpdate", { deviceId: "d", eventId: 1 });
      expect(handler).not.toHaveBeenCalled();
    });

    it("isolates listener errors", () => {
      const bad = vi.fn(() => {
        throw new Error("listener-boom");
      });
      const good = vi.fn();
      client.on("eventUpdate", bad);
      client.on("eventUpdate", good);
      socket.__emit("eventUpdate", { deviceId: "d", eventId: 9 });
      expect(good).toHaveBeenCalled();
      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining("threw"),
        "eventUpdate",
        "listener-boom",
      );
    });

    it("isolates async listener errors", async () => {
      const bad = vi.fn(() => Promise.reject(new Error("async-boom")));
      client.on("eventUpdate", bad);
      socket.__emit("eventUpdate", { deviceId: "d", eventId: 9 });
      await new Promise((r) => setTimeout(r, 0));
      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining("threw"),
        "eventUpdate",
        "async-boom",
      );
    });
  });
});
