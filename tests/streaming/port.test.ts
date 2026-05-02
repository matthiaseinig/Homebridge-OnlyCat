import { describe, expect, it } from "vitest";
import { pickUdpPort } from "../../src/streaming/port.js";

describe("pickUdpPort", () => {
  it("returns a free UDP port number", async () => {
    const port = await pickUdpPort();
    expect(port).toBeTypeOf("number");
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });

  it("returns different ports across calls", async () => {
    const a = await pickUdpPort();
    const b = await pickUdpPort();
    expect(a === b).toBe(false);
  });
});
