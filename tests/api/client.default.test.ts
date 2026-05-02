import { describe, expect, it, vi } from "vitest";
import { createMockLogger } from "../helpers/homebridge.js";
import { createMockSocket } from "../helpers/mockSocket.js";

const ioFactory = vi.fn();

vi.mock("socket.io-client", () => ({
  io: (...args: unknown[]) => ioFactory(...args),
}));

describe("OnlyCatClient default construction", () => {
  it("creates a real socket via io() when no socket is injected", async () => {
    const fakeSocket = createMockSocket();
    ioFactory.mockReturnValue(fakeSocket);

    const { OnlyCatClient, DEFAULT_GATEWAY_URL } = await import("../../src/api/client.js");
    const log = createMockLogger();
    const client = new OnlyCatClient({ token: "FakeTok123", log, debug: true });

    expect(ioFactory).toHaveBeenCalledWith(
      DEFAULT_GATEWAY_URL,
      expect.objectContaining({
        transports: ["websocket"],
        auth: { token: "FakeTok123" },
        extraHeaders: expect.objectContaining({ platform: "homebridge" }),
        autoConnect: false,
        reconnection: true,
      }),
    );

    await client.connect();
    expect(client.isConnected()).toBe(true);
  });

  it("respects a custom gateway URL", async () => {
    const fakeSocket = createMockSocket();
    ioFactory.mockReset();
    ioFactory.mockReturnValue(fakeSocket);

    const { OnlyCatClient } = await import("../../src/api/client.js");
    const log = createMockLogger();
    new OnlyCatClient({ token: "tok", log, url: "https://custom.example" });
    expect(ioFactory).toHaveBeenCalledWith(
      "https://custom.example",
      expect.any(Object),
    );
  });
});
