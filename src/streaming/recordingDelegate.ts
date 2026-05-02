import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  CameraRecordingConfiguration,
  CameraRecordingDelegate,
  HDSProtocolSpecificErrorReason,
  Logging,
  RecordingPacket,
} from "homebridge";
import type { EventCache } from "./eventCache.js";

export type RecordingSpawner = (
  command: string,
  args: string[],
) => ChildProcessWithoutNullStreams;

export interface RecordingDelegateDeps {
  log: Logging;
  deviceId: string;
  eventCache: EventCache;
  ffmpegPath?: string;
  spawner?: RecordingSpawner;
  /** Maximum bytes to buffer in a single yield. */
  chunkSize?: number;
}

const VIDEO_SOURCE_BASE = "https://gateway.onlycat.com/sharing/video";
const DEFAULT_CHUNK_SIZE = 256 * 1024;

interface ActiveRecording {
  process: ChildProcessWithoutNullStreams;
  closed: boolean;
}

export class OnlyCatRecordingDelegate implements CameraRecordingDelegate {
  private readonly log: Logging;
  private readonly deviceId: string;
  private readonly eventCache: EventCache;
  private readonly ffmpegPath: string;
  private readonly spawner: RecordingSpawner;
  private readonly chunkSize: number;
  private readonly active = new Map<number, ActiveRecording>();
  private recordingActive = false;
  private configuration: CameraRecordingConfiguration | undefined;

  constructor(deps: RecordingDelegateDeps) {
    this.log = deps.log;
    this.deviceId = deps.deviceId;
    this.eventCache = deps.eventCache;
    this.ffmpegPath = deps.ffmpegPath ?? "ffmpeg";
    this.spawner =
      deps.spawner ?? ((cmd, args) => spawn(cmd, args) as ChildProcessWithoutNullStreams);
    this.chunkSize = deps.chunkSize ?? DEFAULT_CHUNK_SIZE;
  }

  updateRecordingActive(active: boolean): void {
    this.recordingActive = active;
    this.log.debug("HKSV recording %s for %s", active ? "enabled" : "disabled", this.deviceId);
  }

  updateRecordingConfiguration(configuration?: CameraRecordingConfiguration): void {
    this.configuration = configuration;
    this.log.debug(
      "HKSV recording config updated for %s (set=%s)",
      this.deviceId,
      this.configuration ? "yes" : "no",
    );
  }

  closeRecordingStream(streamId: number, reason?: HDSProtocolSpecificErrorReason): void {
    const recording = this.active.get(streamId);
    if (!recording) return;
    recording.closed = true;
    if (!recording.process.killed) recording.process.kill("SIGINT");
    this.active.delete(streamId);
    this.log.debug(
      "HKSV stream %d closed for %s (reason=%s)",
      streamId,
      this.deviceId,
      reason ?? "normal",
    );
  }

  acknowledgeStream(streamId: number): void {
    this.log.debug("HKSV stream %d acknowledged for %s", streamId, this.deviceId);
  }

  async *handleRecordingStreamRequest(
    streamId: number,
  ): AsyncGenerator<RecordingPacket, void, unknown> {
    if (!this.recordingActive) {
      this.log.debug("HKSV stream requested but recording is inactive");
      return;
    }
    const event = this.eventCache.get(this.deviceId);
    if (!event || !event.accessToken) {
      this.log.info(
        "HKSV recording requested but no event clip available for %s",
        this.deviceId,
      );
      return;
    }

    const child = this.spawner(this.ffmpegPath, this.buildArgs(event));
    const recording: ActiveRecording = { process: child, closed: false };
    this.active.set(streamId, recording);

    try {
      for await (const chunk of this.readChunks(child, recording)) {
        if (recording.closed) break;
        yield { data: chunk, isLast: false };
      }
      yield { data: Buffer.alloc(0), isLast: true };
    } catch (err) {
      this.log.error("HKSV pipeline error: %s", (err as Error).message);
    } finally {
      if (!child.killed) child.kill("SIGINT");
      this.active.delete(streamId);
    }
  }

  private buildArgs(event: { eventId: number; accessToken?: string }): string[] {
    const sourceUrl =
      `${VIDEO_SOURCE_BASE}/${encodeURIComponent(this.deviceId)}/${event.eventId}` +
      `?t=${encodeURIComponent(event.accessToken ?? "")}`;
    return [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      sourceUrl,
      "-c:v",
      "copy",
      "-an",
      "-f",
      "mp4",
      "-movflags",
      "frag_keyframe+empty_moov+default_base_moof",
      "-reset_timestamps",
      "1",
      "pipe:1",
    ];
  }

  private async *readChunks(
    child: ChildProcessWithoutNullStreams,
    recording: ActiveRecording,
  ): AsyncGenerator<Buffer, void, unknown> {
    const queue: Buffer[] = [];
    let waiter: ((chunk: Buffer | null) => void) | null = null;
    let ended = false;

    const push = (chunk: Buffer | null): void => {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(chunk);
      } else if (chunk) {
        queue.push(chunk);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => push(chunk));
    child.stdout.on("end", () => {
      ended = true;
      push(null);
    });
    child.on("error", () => {
      ended = true;
      push(null);
    });

    while (!recording.closed) {
      if (queue.length > 0) {
        const buf = queue.shift()!;
        yield this.cap(buf);
        continue;
      }
      if (ended) return;
      const next = await new Promise<Buffer | null>((resolve) => {
        waiter = resolve;
      });
      if (!next) return;
      yield this.cap(next);
    }
  }

  private cap(buf: Buffer): Buffer {
    if (buf.length <= this.chunkSize) return buf;
    return buf.subarray(0, this.chunkSize);
  }
}
