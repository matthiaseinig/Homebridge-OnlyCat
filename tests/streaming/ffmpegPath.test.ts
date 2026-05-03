import { describe, expect, it } from "vitest";
import { resolveFfmpegPath } from "../../src/streaming/ffmpegPath.js";

describe("resolveFfmpegPath", () => {
  it("returns either the bundled binary path or 'ffmpeg' string", () => {
    const result = resolveFfmpegPath();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("the bundled path (when present) points at an actual file path", () => {
    const result = resolveFfmpegPath();
    if (result === "ffmpeg") return; // optional dep not installed in this env
    expect(result.startsWith("/")).toBe(true);
    expect(result.includes("ffmpeg-for-homebridge")).toBe(true);
  });
});
