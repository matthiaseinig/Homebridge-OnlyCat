import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { Logging } from "homebridge";

export type Spawner = (command: string, args: string[], options?: SpawnOptions) => ChildProcess;

export interface FfmpegOptions {
  command: string;
  args: string[];
  log: Logging;
  spawner?: Spawner;
  onExit?: (code: number | null) => void;
}

/**
 * Wraps spawn() with sensible defaults for ffmpeg sub-processes.
 *
 * Security: every arg is passed through argv (no shell:true), so user input
 * cannot inject additional commands. The command and args must be validated
 * by the caller — we never pass attacker-controlled strings.
 */
export class FfmpegProcess {
  private readonly child: ChildProcess;
  private readonly log: Logging;
  private exited = false;

  constructor(opts: FfmpegOptions) {
    this.log = opts.log;
    const spawner = opts.spawner ?? (spawn as unknown as Spawner);
    this.child = spawner(opts.command, opts.args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.child.stderr?.on("data", (chunk: Buffer) => {
      // ffmpeg writes progress to stderr; surface only at debug.
      this.log.debug("ffmpeg: %s", chunk.toString().trim());
    });
    this.child.on("error", (err) => {
      this.log.error("ffmpeg failed to start: %s", err.message);
    });
    this.child.on("exit", (code) => {
      this.exited = true;
      if (code !== 0 && code !== null) {
        this.log.warn("ffmpeg exited with code %d", code);
      }
      opts.onExit?.(code);
    });
  }

  stop(): void {
    if (this.exited) return;
    this.child.kill("SIGINT");
    setTimeout(() => {
      if (!this.exited) this.child.kill("SIGKILL");
    }, 2000).unref();
  }

  isRunning(): boolean {
    return !this.exited;
  }
}
