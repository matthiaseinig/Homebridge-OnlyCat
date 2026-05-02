import { describe, expect, it } from "vitest";
import { FlapAccessory } from "../../src/accessories/flapAccessory.js";
import { OnlyCatClient } from "../../src/api/client.js";
import type { DeviceRecord } from "../../src/api/types.js";
import {
  MockPlatformAccessory,
  asPlatformAccessory,
  createMockApi,
  createMockLogger,
} from "../helpers/homebridge.js";
import { createMockSocket } from "../helpers/mockSocket.js";

describe("FlapAccessory camera attachment", () => {
  it("creates a CameraController with streaming + recording delegates and the motion sensor by default", () => {
    const log = createMockLogger();
    const api = createMockApi();
    const socket = createMockSocket();
    const client = new OnlyCatClient({ token: "tok", log, socket });
    const device: DeviceRecord = { deviceId: "d-cam" };
    const accessory = new MockPlatformAccessory("d-cam", "uuid:d-cam");
    new FlapAccessory({
      api,
      log,
      client,
      device,
      accessory: asPlatformAccessory(accessory),
      ffmpegPath: "/usr/local/bin/ffmpeg",
    });

    expect(api.cameraInstances).toHaveLength(1);
    const opts = api.cameraInstances[0]!.options as {
      cameraStreamCount: number;
      delegate: unknown;
      recording: { delegate: unknown; options: unknown };
      sensors: { motion: unknown };
      streamingOptions: unknown;
    };
    expect(opts.cameraStreamCount).toBe(2);
    expect(opts.delegate).toBeDefined();
    expect(opts.recording.delegate).toBeDefined();
    expect(opts.sensors.motion).toBe(
      accessory.getService("MotionSensor", "activity"),
    );
    expect(opts.streamingOptions).toBeDefined();
  });

  it("does nothing when CameraController is not available on api.hap", () => {
    const log = createMockLogger();
    const api = createMockApi();
    delete (api.hap as { CameraController?: unknown }).CameraController;
    const socket = createMockSocket();
    const client = new OnlyCatClient({ token: "tok", log, socket });
    new FlapAccessory({
      api,
      log,
      client,
      device: { deviceId: "d-1" },
      accessory: asPlatformAccessory(new MockPlatformAccessory("d-1", "uuid:d-1")),
    });
    expect(api.cameraInstances).toHaveLength(0);
  });

  it("skips camera attachment when disableCamera=true", () => {
    const log = createMockLogger();
    const api = createMockApi();
    const socket = createMockSocket();
    const client = new OnlyCatClient({ token: "tok", log, socket });
    new FlapAccessory({
      api,
      log,
      client,
      device: { deviceId: "d-2" },
      accessory: asPlatformAccessory(new MockPlatformAccessory("d-2", "uuid:d-2")),
      disableCamera: true,
    });
    expect(api.cameraInstances).toHaveLength(0);
  });
});
