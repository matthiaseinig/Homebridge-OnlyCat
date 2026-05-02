import { describe, expect, it } from "vitest";
import { EventCache } from "../../src/streaming/eventCache.js";

describe("EventCache", () => {
  it("returns undefined when no event has been observed", () => {
    const cache = new EventCache();
    expect(cache.get("dev")).toBeUndefined();
  });

  it("stores the latest event per device", () => {
    const cache = new EventCache();
    cache.apply({ deviceId: "d1", eventId: 1, accessToken: "tok-1" });
    cache.apply({ deviceId: "d1", eventId: 2, accessToken: "tok-2" });
    cache.apply({ deviceId: "d2", eventId: 99 });
    expect(cache.get("d1")?.eventId).toBe(2);
    expect(cache.get("d1")?.accessToken).toBe("tok-2");
    expect(cache.get("d2")?.eventId).toBe(99);
  });

  it("preserves older fields when newer push doesn't include them", () => {
    const cache = new EventCache();
    cache.apply({ deviceId: "d", eventId: 1, accessToken: "tok", posterFrameIndex: 5 });
    cache.apply({ deviceId: "d", eventId: 1 }); // no token in update
    expect(cache.get("d")?.accessToken).toBe("tok");
    expect(cache.get("d")?.posterFrameIndex).toBe(5);
  });

  it("marks the event complete when frameCount arrives", () => {
    const cache = new EventCache();
    cache.apply({ deviceId: "d", eventId: 1 });
    expect(cache.get("d")?.isComplete).toBe(false);
    cache.apply({ deviceId: "d", eventId: 1, frameCount: 30 });
    expect(cache.get("d")?.isComplete).toBe(true);
    expect(cache.get("d")?.finishedAt).toBeTypeOf("number");
  });

  it("clear() removes the entry for a device", () => {
    const cache = new EventCache();
    cache.apply({ deviceId: "d", eventId: 1 });
    cache.clear("d");
    expect(cache.get("d")).toBeUndefined();
  });
});
