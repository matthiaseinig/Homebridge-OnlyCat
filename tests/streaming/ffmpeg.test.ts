import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { FfmpegProcess } from "../../src/streaming/ffmpeg.js";
import { createMockLogger } from "../helpers/homebridge.js";

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function buildFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe("FfmpegProcess", () => {
  it("spawns with the provided command and args", () => {
    const log = createMockLogger();
    const child = buildFakeChild();
    const spawner = vi.fn(() => child as never);
    new FfmpegProcess({
      command: "/usr/bin/ffmpeg",
      args: ["-i", "in", "out"],
      log,
      spawner: spawner as never,
    });
    expect(spawner).toHaveBeenCalledWith(
      "/usr/bin/ffmpeg",
      ["-i", "in", "out"],
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );
  });

  it("logs stderr at debug level", () => {
    const log = createMockLogger();
    const child = buildFakeChild();
    new FfmpegProcess({
      command: "ffmpeg",
      args: [],
      log,
      spawner: ((..._a: unknown[]) => child) as never,
    });
    child.stderr.emit("data", Buffer.from("frame=  10 fps=30"));
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining("ffmpeg"), "frame=  10 fps=30");
  });

  it("logs error on spawn failure", () => {
    const log = createMockLogger();
    const child = buildFakeChild();
    new FfmpegProcess({
      command: "ffmpeg",
      args: [],
      log,
      spawner: ((..._a: unknown[]) => child) as never,
    });
    child.emit("error", new Error("ENOENT"));
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("failed"), "ENOENT");
  });

  it("warns on non-zero exit", () => {
    const log = createMockLogger();
    const child = buildFakeChild();
    new FfmpegProcess({
      command: "ffmpeg",
      args: [],
      log,
      spawner: ((..._a: unknown[]) => child) as never,
    });
    child.emit("exit", 137);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("exited"), 137, expect.anything());
  });

  it("dumps the recent stderr tail on non-zero exit", () => {
    const log = createMockLogger();
    const child = buildFakeChild();
    new FfmpegProcess({
      command: "ffmpeg",
      args: [],
      log,
      spawner: ((..._a: unknown[]) => child) as never,
    });
    child.stderr.emit("data", Buffer.from("some warning\n"));
    child.stderr.emit("data", Buffer.from("Error opening input\nOption not found\n"));
    child.emit("exit", 8);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("exited"),
      8,
      expect.anything(),
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("stderr tail"),
      expect.stringContaining("Option not found"),
    );
  });

  it("clamps the stderr ring buffer to the most recent lines", () => {
    const log = createMockLogger();
    const child = buildFakeChild();
    new FfmpegProcess({
      command: "ffmpeg",
      args: [],
      log,
      spawner: ((..._a: unknown[]) => child) as never,
    });
    // Push more than STDERR_TAIL_LINES (12) entries so old ones must drop.
    for (let i = 0; i < 20; i += 1) {
      child.stderr.emit("data", Buffer.from(`line-${i}\n`));
    }
    child.emit("exit", 8);
    const calls = (log.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const tailCall = calls.find(
      (c) => typeof c[1] === "string" && (c[1] as string).includes("line-"),
    );
    expect(tailCall).toBeDefined();
    // First few lines should have been evicted
    expect(tailCall![1] as string).not.toContain("line-0\n");
    expect(tailCall![1] as string).toContain("line-19");
  });

  it("does not warn on zero or null exit code", () => {
    const log = createMockLogger();
    const child = buildFakeChild();
    new FfmpegProcess({
      command: "ffmpeg",
      args: [],
      log,
      spawner: ((..._a: unknown[]) => child) as never,
    });
    child.emit("exit", 0);
    child.emit("exit", null);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("calls onExit callback", () => {
    const log = createMockLogger();
    const child = buildFakeChild();
    const onExit = vi.fn();
    new FfmpegProcess({
      command: "ffmpeg",
      args: [],
      log,
      spawner: ((..._a: unknown[]) => child) as never,
      onExit,
    });
    child.emit("exit", 0);
    expect(onExit).toHaveBeenCalledWith(0);
  });

  it("stop() sends SIGINT and isRunning() reflects state", () => {
    const log = createMockLogger();
    const child = buildFakeChild();
    const proc = new FfmpegProcess({
      command: "ffmpeg",
      args: [],
      log,
      spawner: ((..._a: unknown[]) => child) as never,
    });
    expect(proc.isRunning()).toBe(true);
    proc.stop();
    expect(child.kill).toHaveBeenCalledWith("SIGINT");

    child.emit("exit", 0);
    expect(proc.isRunning()).toBe(false);
    proc.stop(); // no-op
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});
