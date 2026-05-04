import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { EventCache } from "../../src/streaming/eventCache.js";
import { OnlyCatRecordingDelegate } from "../../src/streaming/recordingDelegate.js";
import { createMockLogger } from "../helpers/homebridge.js";

interface FakeProc extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  killed: boolean;
}

function fakeChild(): FakeProc {
  const c = new EventEmitter() as FakeProc;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.killed = false;
  c.kill = vi.fn(() => {
    c.killed = true;
    return true;
  });
  return c;
}

async function consume<T>(gen: AsyncGenerator<T>, max = 100): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < max; i += 1) {
    const r = await gen.next();
    if (r.done) break;
    out.push(r.value);
  }
  return out;
}

describe("OnlyCatRecordingDelegate", () => {
  it("returns nothing when recording is inactive", async () => {
    const log = createMockLogger();
    const delegate = new OnlyCatRecordingDelegate({
      log,
      deviceId: "d",
      eventCache: new EventCache(),
    });
    const items = await consume(delegate.handleRecordingStreamRequest(1));
    expect(items).toHaveLength(0);
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining("inactive"));
  });

  it("returns nothing when no event is cached", async () => {
    const log = createMockLogger();
    const delegate = new OnlyCatRecordingDelegate({
      log,
      deviceId: "d",
      eventCache: new EventCache(),
    });
    delegate.updateRecordingActive(true);
    const items = await consume(delegate.handleRecordingStreamRequest(1));
    expect(items).toHaveLength(0);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("HKSV"), "d");
  });

  it("yields fragments from ffmpeg stdout, terminating with isLast", async () => {
    const cache = new EventCache();
    cache.apply({ deviceId: "d", eventId: 1, accessToken: "tok" });
    const child = fakeChild();
    const delegate = new OnlyCatRecordingDelegate({
      log: createMockLogger(),
      deviceId: "d",
      eventCache: cache,
      spawner: () => child as never,
    });
    delegate.updateRecordingActive(true);

    const gen = delegate.handleRecordingStreamRequest(1);
    const collected: Array<{ data: Buffer; isLast: boolean }> = [];
    const consumer = (async () => {
      for await (const pkt of gen) {
        collected.push(pkt);
        if (pkt.isLast) break;
      }
    })();

    await new Promise((r) => setImmediate(r));
    child.stdout.emit("data", Buffer.from([1, 2, 3]));
    child.stdout.emit("data", Buffer.from([4, 5]));
    child.stdout.emit("end");
    await consumer;

    expect(collected).toEqual([
      { data: Buffer.from([1, 2, 3]), isLast: false },
      { data: Buffer.from([4, 5]), isLast: false },
      { data: Buffer.alloc(0), isLast: true },
    ]);
  });

  it("splits oversize chunks at chunkSize without losing bytes", async () => {
    const cache = new EventCache();
    cache.apply({ deviceId: "d", eventId: 1, accessToken: "tok" });
    const child = fakeChild();
    const delegate = new OnlyCatRecordingDelegate({
      log: createMockLogger(),
      deviceId: "d",
      eventCache: cache,
      spawner: () => child as never,
      chunkSize: 4,
    });
    delegate.updateRecordingActive(true);

    const gen = delegate.handleRecordingStreamRequest(1);
    const collected: Array<{ data: Buffer; isLast: boolean }> = [];
    const consumer = (async () => {
      for await (const pkt of gen) {
        collected.push(pkt);
        if (pkt.isLast) break;
      }
    })();

    await new Promise((r) => setImmediate(r));
    child.stdout.emit("data", Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    child.stdout.emit("end");
    await consumer;

    // 9 bytes split into 4 + 4 + 1, then the empty terminator.
    // Truncation here would break MP4 fragment integrity and iOS
    // HKSV would reject the recording, so every byte must survive.
    expect(collected[0]!.data).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(collected[1]!.data).toEqual(Buffer.from([5, 6, 7, 8]));
    expect(collected[2]!.data).toEqual(Buffer.from([9]));
    expect(collected.at(-1)!.isLast).toBe(true);
  });

  it("closeRecordingStream halts the generator and kills ffmpeg", async () => {
    const cache = new EventCache();
    cache.apply({ deviceId: "d", eventId: 1, accessToken: "tok" });
    const child = fakeChild();
    const delegate = new OnlyCatRecordingDelegate({
      log: createMockLogger(),
      deviceId: "d",
      eventCache: cache,
      spawner: () => child as never,
    });
    delegate.updateRecordingActive(true);

    const gen = delegate.handleRecordingStreamRequest(7);
    const consumer = (async () => {
      for await (const _pkt of gen) {
        // discard
      }
    })();

    await new Promise((r) => setImmediate(r));
    delegate.closeRecordingStream(7, undefined);
    child.stdout.emit("end");
    await consumer;
    expect(child.kill).toHaveBeenCalled();
  });

  it("closeRecordingStream is safe for unknown stream id", () => {
    const delegate = new OnlyCatRecordingDelegate({
      log: createMockLogger(),
      deviceId: "d",
      eventCache: new EventCache(),
    });
    expect(() => delegate.closeRecordingStream(42, undefined)).not.toThrow();
  });

  it("acknowledgeStream just logs", () => {
    const log = createMockLogger();
    const delegate = new OnlyCatRecordingDelegate({
      log,
      deviceId: "d",
      eventCache: new EventCache(),
    });
    delegate.acknowledgeStream(99);
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining("acknowledged"), 99, "d");
  });

  it("updateRecordingConfiguration logs with set=yes when given a config", () => {
    const log = createMockLogger();
    const delegate = new OnlyCatRecordingDelegate({
      log,
      deviceId: "d",
      eventCache: new EventCache(),
    });
    delegate.updateRecordingConfiguration({} as never);
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining("config"), "d", "yes");
    delegate.updateRecordingConfiguration(undefined);
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining("config"), "d", "no");
  });

  it("ffmpeg args include the HLS source URL with token", async () => {
    const cache = new EventCache();
    cache.apply({ deviceId: "d-1", eventId: 5, accessToken: "tok-X" });
    const child = fakeChild();
    const spawner = vi.fn(() => child as never);
    const delegate = new OnlyCatRecordingDelegate({
      log: createMockLogger(),
      deviceId: "d-1",
      eventCache: cache,
      spawner: spawner as never,
    });
    delegate.updateRecordingActive(true);
    const gen = delegate.handleRecordingStreamRequest(1);
    void (async () => {
      for await (const _pkt of gen) {
        break;
      }
    })();
    await new Promise((r) => setImmediate(r));
    child.stdout.emit("end");

    const [, args] = spawner.mock.calls[0]!;
    expect(args).toContain("https://gateway.onlycat.com/sharing/video/d-1/5?t=tok-X");
    expect(args).toContain("frag_keyframe+empty_moov+default_base_moof");
    expect(args).not.toContain("-live_start_index");
    // Silent-audio synthesis so HKSV fragments match the declared AAC support.
    expect(args).toContain("anullsrc=channel_layout=mono:sample_rate=24000");
    expect(args).toContain("-shortest");
    expect(args).toContain("aac");
  });

  it("logs an error if ffmpeg emits one", async () => {
    const cache = new EventCache();
    cache.apply({ deviceId: "d", eventId: 1, accessToken: "tok" });
    const child = fakeChild();
    const log = createMockLogger();
    const delegate = new OnlyCatRecordingDelegate({
      log,
      deviceId: "d",
      eventCache: cache,
      spawner: () => child as never,
    });
    delegate.updateRecordingActive(true);
    const gen = delegate.handleRecordingStreamRequest(1);
    const consumer = (async () => {
      for await (const _pkt of gen) {
        break;
      }
    })();
    await new Promise((r) => setImmediate(r));
    child.emit("error", new Error("boom"));
    child.stdout.emit("end");
    await consumer;
    // No throw — error is handled internally
    expect(child.kill).toHaveBeenCalled();
  });
});
