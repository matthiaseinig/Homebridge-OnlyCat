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
const STDERR_TAIL_LINES = 12;

export class FfmpegProcess {
  private readonly child: ChildProcess;
  private readonly log: Logging;
  private exited = false;
  // Ring-buffer of recent stderr lines so a non-zero exit can show the cause.
  private readonly stderrTail: string[] = [];

  constructor(opts: FfmpegOptions) {
    this.log = opts.log;
    const spawner = opts.spawner ?? (spawn as unknown as Spawner);
    this.child = spawner(opts.command, opts.args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      this.log.debug("ffmpeg: %s", text);
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
      }
    });
    this.child.on("error", (err) => {
      this.log.error("ffmpeg failed to start: %s", err.message);
    });
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      if (code !== 0 && code !== null) {
        this.log.warn("ffmpeg exited with code %d (signal=%s)", code, signal ?? "none");
        if (this.stderrTail.length > 0) {
          this.log.warn(
            "ffmpeg stderr tail:\n%s",
            this.stderrTail.map((l) => `    ${l}`).join("\n"),
          );
        } else {
          this.log.warn("ffmpeg produced no stderr output");
        }
      } else if (signal) {
        this.log.debug("ffmpeg terminated by signal %s", signal);
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
