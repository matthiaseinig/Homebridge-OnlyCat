import { describe, expect, it, vi } from "vitest";
import {
  HttpSnapshotFetcher,
  placeholderSnapshot,
  thumbnailUrl,
} from "../../src/streaming/snapshot.js";

describe("snapshot helpers", () => {
  it("placeholderSnapshot returns a non-empty JPEG buffer", () => {
    const buf = placeholderSnapshot();
    expect(buf.length).toBeGreaterThan(0);
    // JPEGs start with FF D8
    expect(buf[0]).toBe(0xff);
    expect(buf[1]).toBe(0xd8);
  });

  it("thumbnailUrl returns null when poster frame index is missing", () => {
    expect(
      thumbnailUrl({ deviceId: "d", eventId: 1, isComplete: false, frameCount: null }),
    ).toBeNull();
  });

  it("thumbnailUrl builds the gateway URL", () => {
    expect(
      thumbnailUrl({
        deviceId: "d-1",
        eventId: 42,
        posterFrameIndex: 7,
        isComplete: true,
        frameCount: 30,
      }),
    ).toBe("https://gateway.onlycat.com/events/d-1/42/7");
  });

  it("HttpSnapshotFetcher fetches and returns the body", async () => {
    const buffer = Buffer.from([1, 2, 3, 4]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      ({ ok: true, status: 200, arrayBuffer: async () => buffer }) as unknown as Response,
    ) as unknown as typeof fetch;
    try {
      const f = new HttpSnapshotFetcher();
      const ac = new AbortController();
      const out = await f.fetch("https://example.com/x.jpg", ac.signal);
      expect(out.length).toBe(4);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("HttpSnapshotFetcher throws on non-2xx", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      ({ ok: false, status: 503 }) as unknown as Response,
    ) as unknown as typeof fetch;
    try {
      const f = new HttpSnapshotFetcher();
      await expect(f.fetch("https://example.com", new AbortController().signal)).rejects.toThrow(
        /503/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
