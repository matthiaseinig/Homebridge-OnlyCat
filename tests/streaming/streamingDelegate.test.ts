import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { StreamRequestTypes } from "homebridge";
import { EventCache } from "../../src/streaming/eventCache.js";
import { OnlyCatStreamingDelegate } from "../../src/streaming/streamingDelegate.js";
import { createMockLogger } from "../helpers/homebridge.js";

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(): FakeChild {
  const c = new EventEmitter() as FakeChild;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = vi.fn();
  return c;
}

function makeApi() {
  return {
    hap: {
      CameraController: {
        generateSynchronisationSource: vi.fn(() => 12345),
      },
    },
  } as never;
}

const fakeSrtpKey = Buffer.alloc(16, 1);
const fakeSrtpSalt = Buffer.alloc(14, 2);

function prepareRequest(sessionID = "s-1") {
  return {
    sessionID,
    sourceAddress: "192.168.1.10",
    targetAddress: "192.168.1.20",
    addressVersion: "ipv4",
    audio: {
      port: 50000,
      srtpCryptoSuite: 0,
      srtp_key: fakeSrtpKey,
      srtp_salt: fakeSrtpSalt,
    },
    video: {
      port: 60000,
      srtpCryptoSuite: 0,
      srtp_key: fakeSrtpKey,
      srtp_salt: fakeSrtpSalt,
    },
  };
}

function startRequest(sessionID = "s-1") {
  return {
    sessionID,
    type: StreamRequestTypes.START,
    video: {
      codec: 0,
      profile: 0,
      level: 0,
      packetizationMode: 0,
      width: 1280,
      height: 720,
      fps: 30,
      pt: 99,
      ssrc: 12345,
      max_bit_rate: 500,
      rtcp_interval: 0.5,
      mtu: 1316,
    },
    audio: {} as never,
  };
}

describe("OnlyCatStreamingDelegate", () => {
  it("returns a placeholder snapshot when no event is cached", async () => {
    const log = createMockLogger();
    const cache = new EventCache();
    const delegate = new OnlyCatStreamingDelegate({
      api: makeApi(),
      log,
      deviceId: "d",
      eventCache: cache,
      portAllocator: async () => 7000,
    });
    const cb = vi.fn();
    await delegate.handleSnapshotRequest(
      { width: 320, height: 240 } as never,
      cb,
    );
    expect(cb).toHaveBeenCalledWith(undefined, expect.any(Buffer));
    expect((cb.mock.calls[0]![1] as Buffer).length).toBeGreaterThan(0);
  });

  it("returns a placeholder when poster frame index is missing", async () => {
    const log = createMockLogger();
    const cache = new EventCache();
    cache.apply({ deviceId: "d", eventId: 1 });
    const delegate = new OnlyCatStreamingDelegate({
      api: makeApi(),
      log,
      deviceId: "d",
      eventCache: cache,
      portAllocator: async () => 7000,
    });
    const cb = vi.fn();
    await delegate.handleSnapshotRequest({ width: 1, height: 1 } as never, cb);
    expect(cb).toHaveBeenCalledWith(undefined, expect.any(Buffer));
  });

  it("fetches snapshot via the snapshot fetcher when an event with poster exists", async () => {
    const log = createMockLogger();
    const cache = new EventCache();
    cache.apply({ deviceId: "d", eventId: 1, posterFrameIndex: 3 });
    const fetcher = {
      fetch: vi.fn(async () => Buffer.from([1, 2, 3])),
    };
    const delegate = new OnlyCatStreamingDelegate({
      api: makeApi(),
      log,
      deviceId: "d",
      eventCache: cache,
      portAllocator: async () => 7000,
      snapshotFetcher: fetcher,
    });
    const cb = vi.fn();
    await delegate.handleSnapshotRequest({ width: 1, height: 1 } as never, cb);
    expect(fetcher.fetch).toHaveBeenCalledWith(
      "https://gateway.onlycat.com/events/d/1/3",
      expect.any(AbortSignal),
    );
    expect(cb).toHaveBeenCalledWith(undefined, Buffer.from([1, 2, 3]));
  });

  it("falls back to placeholder when snapshot fetch errors", async () => {
    const log = createMockLogger();
    const cache = new EventCache();
    cache.apply({ deviceId: "d", eventId: 1, posterFrameIndex: 3 });
    const fetcher = {
      fetch: vi.fn(async () => {
        throw new Error("offline");
      }),
    };
    const delegate = new OnlyCatStreamingDelegate({
      api: makeApi(),
      log,
      deviceId: "d",
      eventCache: cache,
      portAllocator: async () => 7000,
      snapshotFetcher: fetcher,
    });
    const cb = vi.fn();
    await delegate.handleSnapshotRequest({ width: 1, height: 1 } as never, cb);
    expect(log.warn).toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith(undefined, expect.any(Buffer));
  });

  it("prepareStream allocates ports and returns video + audio SSRC", async () => {
    const delegate = new OnlyCatStreamingDelegate({
      api: makeApi(),
      log: createMockLogger(),
      deviceId: "d",
      eventCache: new EventCache(),
      portAllocator: async () => 12345,
    });
    const cb = vi.fn();
    await delegate.prepareStream(prepareRequest() as never, cb);
    expect(cb).toHaveBeenCalledWith(undefined, expect.objectContaining({
      video: expect.objectContaining({ port: 12345 }),
      audio: expect.objectContaining({ port: 12345 }),
    }));
  });

  it("prepareStream is idempotent if the framework double-calls the callback", async () => {
    const log = createMockLogger();
    const delegate = new OnlyCatStreamingDelegate({
      api: makeApi(),
      log,
      deviceId: "d",
      eventCache: new EventCache(),
      portAllocator: async () => 12345,
    });
    let calls = 0;
    const cb = ((..._args: unknown[]) => {
      calls += 1;
      if (calls === 1) {
        // simulate hap-nodejs's once() guard rejecting subsequent calls
        throw new Error("already called");
      }
    }) as never;
    await delegate.prepareStream(prepareRequest() as never, cb);
    // Should not throw out of prepareStream; redundant call swallowed and logged.
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining("double-invoked"),
      expect.any(String),
    );
  });

  it("port allocator failure surfaces as an error without leaving a session", async () => {
    let count = 0;
    const delegate = new OnlyCatStreamingDelegate({
      api: makeApi(),
      log: createMockLogger(),
      deviceId: "d",
      eventCache: new EventCache(),
      portAllocator: async () => {
        count += 1;
        if (count === 1) return 7000;
        throw new Error("audio-port-fail");
      },
    });
    const cb = vi.fn();
    await delegate.prepareStream(prepareRequest() as never, cb);
    expect(cb).toHaveBeenCalledWith(expect.any(Error), undefined);
  });

  it("prepareStream surfaces errors", async () => {
    const delegate = new OnlyCatStreamingDelegate({
      api: makeApi(),
      log: createMockLogger(),
      deviceId: "d",
      eventCache: new EventCache(),
      portAllocator: async () => {
        throw new Error("ports-exhausted");
      },
    });
    const cb = vi.fn();
    await delegate.prepareStream(prepareRequest() as never, cb);
    expect(cb).toHaveBeenCalledWith(expect.any(Error), undefined);
  });

  it("start with no cached event quietly stops the session", async () => {
    const log = createMockLogger();
    const delegate = new OnlyCatStreamingDelegate({
      api: makeApi(),
      log,
      deviceId: "d",
      eventCache: new EventCache(),
      portAllocator: async () => 7000,
    });
    await delegate.prepareStream(prepareRequest() as never, vi.fn());
    const cb = vi.fn();
    delegate.handleStreamRequest(startRequest() as never, cb);
    expect(cb).toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("Live stream"),
      "d",
    );
  });

  it("start with cached event spawns ffmpeg with sane args", async () => {
    const cache = new EventCache();
    cache.apply({
      deviceId: "d",
      eventId: 11,
      accessToken: "tok-X",
      posterFrameIndex: 0,
    });
    const child = fakeChild();
    const spawner = vi.fn(() => child as never);
    const delegate = new OnlyCatStreamingDelegate({
      api: makeApi(),
      log: createMockLogger(),
      deviceId: "d",
      eventCache: cache,
      portAllocator: async () => 7000,
      spawner: spawner as never,
    });
    await delegate.prepareStream(prepareRequest() as never, vi.fn());
    delegate.handleStreamRequest(startRequest() as never, vi.fn());
    expect(spawner).toHaveBeenCalled();
    const [, args] = spawner.mock.calls[0]!;
    expect(args).toContain("-i");
    expect(args).toContain("https://gateway.onlycat.com/sharing/video/d/11?t=tok-X");
    expect(args).toContain("-an");
    expect(args).toContain("-re");
    // -stream_loop -1 makes the finite event clip behave as a continuous feed.
    const loopIdx = args.indexOf("-stream_loop");
    expect(loopIdx).toBeGreaterThan(-1);
    expect(args[loopIdx + 1]).toBe("-1");
    // -live_start_index was removed in ffmpeg 8.x and was never needed for
    // OnlyCat's VOD HLS playlists — make sure it is NOT in the args.
    expect(args).not.toContain("-live_start_index");
    expect(args.some((a: string) => a.startsWith("srtp://192.168.1.20"))).toBe(true);
  });

  it("stop terminates the running ffmpeg session", async () => {
    const cache = new EventCache();
    cache.apply({ deviceId: "d", eventId: 1, accessToken: "tok" });
    const child = fakeChild();
    const delegate = new OnlyCatStreamingDelegate({
      api: makeApi(),
      log: createMockLogger(),
      deviceId: "d",
      eventCache: cache,
      portAllocator: async () => 7000,
      spawner: ((..._a: unknown[]) => child) as never,
    });
    await delegate.prepareStream(prepareRequest() as never, vi.fn());
    delegate.handleStreamRequest(startRequest() as never, vi.fn());

    const cb = vi.fn();
    delegate.handleStreamRequest(
      { sessionID: "s-1", type: StreamRequestTypes.STOP } as never,
      cb,
    );
    expect(child.kill).toHaveBeenCalledWith("SIGINT");
    expect(cb).toHaveBeenCalled();
  });

  it("reconfigure is silently acknowledged", () => {
    const delegate = new OnlyCatStreamingDelegate({
      api: makeApi(),
      log: createMockLogger(),
      deviceId: "d",
      eventCache: new EventCache(),
      portAllocator: async () => 7000,
    });
    const cb = vi.fn();
    delegate.handleStreamRequest(
      { sessionID: "s-1", type: StreamRequestTypes.RECONFIGURE, video: {} as never } as never,
      cb,
    );
    expect(cb).toHaveBeenCalled();
  });

  it("attachController stores the controller reference", () => {
    const delegate = new OnlyCatStreamingDelegate({
      api: makeApi(),
      log: createMockLogger(),
      deviceId: "d",
      eventCache: new EventCache(),
      portAllocator: async () => 7000,
    });
    const fake = {} as never;
    delegate.attachController(fake);
    expect(delegate.controller).toBe(fake);
  });

  it("startStream does nothing when no prepare info is stored", () => {
    const cache = new EventCache();
    cache.apply({ deviceId: "d", eventId: 1, accessToken: "tok" });
    const delegate = new OnlyCatStreamingDelegate({
      api: makeApi(),
      log: createMockLogger(),
      deviceId: "d",
      eventCache: cache,
      portAllocator: async () => 7000,
    });
    // No prepareStream called; session id won't exist.
    const cb = vi.fn();
    delegate.handleStreamRequest(startRequest("ghost") as never, cb);
    expect(cb).toHaveBeenCalled();
  });
});
