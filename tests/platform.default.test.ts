import { describe, expect, it, vi } from "vitest";
import { createMockApi, createMockLogger } from "./helpers/homebridge.js";
import { createMockSocket } from "./helpers/mockSocket.js";

const ioFactory = vi.fn();

vi.mock("socket.io-client", () => ({
  io: (...args: unknown[]) => ioFactory(...args),
}));

describe("OnlyCatPlatform default construction", () => {
  it("constructs a real OnlyCatClient when no deps.client is provided", async () => {
    const fakeSocket = createMockSocket();
    ioFactory.mockReset();
    ioFactory.mockReturnValue(fakeSocket);
    fakeSocket.__ackResponses.set("getDevices", []);

    const { OnlyCatPlatform } = await import("../src/platform.js");
    const log = createMockLogger();
    const api = createMockApi();
    new OnlyCatPlatform(
      log,
      { platform: "OnlyCat", name: "OnlyCat", token: "tok-secret-1234", debug: true },
      api,
    );

    api.emit("didFinishLaunching");
    await new Promise((r) => setTimeout(r, 0));

    expect(ioFactory).toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("initialised"),
      expect.anything(),
      expect.anything(),
    );
  });
});
