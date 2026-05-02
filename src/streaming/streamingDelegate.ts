import type {
  API,
  CameraController,
  CameraStreamingDelegate,
  Logging,
  PrepareStreamCallback,
  PrepareStreamRequest,
  SnapshotRequest,
  SnapshotRequestCallback,
  StartStreamRequest,
  StreamingRequest,
  StreamRequestCallback,
} from "homebridge";
import { StreamRequestTypes } from "homebridge";
import type { EventCache } from "./eventCache.js";
import { pickUdpPort } from "./port.js";
import { FfmpegProcess, type Spawner } from "./ffmpeg.js";
import {
  HttpSnapshotFetcher,
  placeholderSnapshot,
  thumbnailUrl,
  type SnapshotFetcher,
} from "./snapshot.js";

const VIDEO_SOURCE_BASE = "https://gateway.onlycat.com/sharing/video";

export interface StreamingDelegateDeps {
  api: API;
  log: Logging;
  deviceId: string;
  eventCache: EventCache;
  ffmpegPath?: string;
  spawner?: Spawner;
  snapshotFetcher?: SnapshotFetcher;
  // Allow tests to override port allocation deterministically.
  portAllocator?: () => Promise<number>;
}

interface PrepareInfo {
  targetAddress: string;
  videoPort: number;
  videoSrtpKey: Buffer;
  videoSrtpSalt: Buffer;
  audioPort: number;
}

interface ActiveSession {
  process?: FfmpegProcess;
  prepare?: PrepareInfo;
}

export class OnlyCatStreamingDelegate implements CameraStreamingDelegate {
  controller?: CameraController;

  private readonly api: API;
  private readonly log: Logging;
  private readonly deviceId: string;
  private readonly eventCache: EventCache;
  private readonly ffmpegPath: string;
  private readonly spawner?: Spawner;
  private readonly snapshotFetcher: SnapshotFetcher;
  private readonly portAllocator: () => Promise<number>;
  private readonly sessions = new Map<string, ActiveSession>();

  constructor(deps: StreamingDelegateDeps) {
    this.api = deps.api;
    this.log = deps.log;
    this.deviceId = deps.deviceId;
    this.eventCache = deps.eventCache;
    this.ffmpegPath = deps.ffmpegPath ?? "ffmpeg";
    this.spawner = deps.spawner;
    this.snapshotFetcher = deps.snapshotFetcher ?? new HttpSnapshotFetcher();
    this.portAllocator = deps.portAllocator ?? pickUdpPort;
  }

  attachController(controller: CameraController): void {
    this.controller = controller;
  }

  async handleSnapshotRequest(
    _request: SnapshotRequest,
    callback: SnapshotRequestCallback,
  ): Promise<void> {
    try {
      const event = this.eventCache.get(this.deviceId);
      if (!event) {
        callback(undefined, placeholderSnapshot());
        return;
      }
      const url = thumbnailUrl(event);
      if (!url) {
        callback(undefined, placeholderSnapshot());
        return;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const buffer = await this.snapshotFetcher.fetch(url, controller.signal);
        callback(undefined, buffer);
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      this.log.warn(
        "Snapshot for %s failed: %s — using placeholder",
        this.deviceId,
        (err as Error).message,
      );
      callback(undefined, placeholderSnapshot());
    }
  }

  async prepareStream(
    request: PrepareStreamRequest,
    callback: PrepareStreamCallback,
  ): Promise<void> {
    const safeCallback = (
      err: Error | undefined,
      response?: Parameters<PrepareStreamCallback>[1],
    ): void => {
      try {
        callback(err, response);
      } catch (cbErr) {
        // HAP-NodeJS wraps the callback in `once`. If iOS or HAP rejects our
        // response synchronously, the framework will already have invoked it.
        // Swallow the redundant call so the bridge doesn't crash.
        this.log.debug(
          "prepareStream callback double-invoked: %s",
          (cbErr as Error).message,
        );
      }
    };

    try {
      const videoReturnPort = await this.portAllocator();
      const audioReturnPort = await this.portAllocator();
      this.sessions.set(request.sessionID, {
        prepare: {
          targetAddress: request.targetAddress,
          videoPort: request.video.port,
          videoSrtpKey: request.video.srtp_key,
          videoSrtpSalt: request.video.srtp_salt,
          audioPort: request.audio.port,
        },
      });
      safeCallback(undefined, {
        video: {
          port: videoReturnPort,
          ssrc: this.api.hap.CameraController.generateSynchronisationSource(),
          srtp_key: request.video.srtp_key,
          srtp_salt: request.video.srtp_salt,
        },
        // iOS expects an audio block in the response even when we don't deliver
        // audio packets — it allocates an audio session and waits to be told
        // which port + SRTP context to use. We return valid SRTP material;
        // ffmpeg itself doesn't actually emit audio (still uses -an).
        audio: {
          port: audioReturnPort,
          ssrc: this.api.hap.CameraController.generateSynchronisationSource(),
          srtp_key: request.audio.srtp_key,
          srtp_salt: request.audio.srtp_salt,
        },
      });
    } catch (err) {
      this.log.error("prepareStream failed: %s", (err as Error).message);
      safeCallback(err as Error);
    }
  }

  handleStreamRequest(
    request: StreamingRequest,
    callback: StreamRequestCallback,
  ): void {
    if (request.type === StreamRequestTypes.START) {
      this.startStream(request);
      callback();
      return;
    }
    if (request.type === StreamRequestTypes.STOP) {
      this.stopStream(request.sessionID);
      callback();
      return;
    }
    // RECONFIGURE is unsupported — silently ack so HK doesn't error.
    callback();
  }

  private startStream(request: StartStreamRequest): void {
    const event = this.eventCache.get(this.deviceId);
    if (!event || !event.accessToken) {
      this.log.info(
        "Live stream requested but no event clip is available yet for %s.",
        this.deviceId,
      );
      this.stopStream(request.sessionID);
      return;
    }

    const session = this.sessions.get(request.sessionID);
    if (!session || !session.prepare) return;

    const video = request.video;
    if (!video) return;
    const prepare = session.prepare;

    const sourceUrl = this.buildSourceUrl(event);
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      // Pace the input at native frame-rate so iOS receives a smooth RTP stream.
      "-re",
      // OnlyCat HLS playlists are short, completed clips. ffmpeg's HLS demuxer
      // defaults to -live_start_index -3 (start ~3 segments from the end).
      // Force segment 0 so the cat's full trip plays from the beginning.
      "-live_start_index",
      "0",
      // iOS Home expects a *continuous* live feed. OnlyCat events are 5–10 s
      // clips, so once the clip ends iOS sees the stream end and gives up.
      // Loop the clip indefinitely — the user always sees the latest event
      // playing on repeat. ffmpeg still exits cleanly when iOS stops the
      // session.
      "-stream_loop",
      "-1",
      "-i",
      sourceUrl,
      "-an",
      "-c:v",
      "copy",
      "-f",
      "rtp",
      "-payload_type",
      String(video.pt),
      "-ssrc",
      String(video.ssrc),
      "-srtp_out_suite",
      "AES_CM_128_HMAC_SHA1_80",
      "-srtp_out_params",
      `${prepare.videoSrtpKey.toString("base64")}${prepare.videoSrtpSalt.toString("base64")}`,
      `srtp://${prepare.targetAddress}:${prepare.videoPort}?pkt_size=1316`,
    ];

    session.process = new FfmpegProcess({
      command: this.ffmpegPath,
      args,
      log: this.log,
      spawner: this.spawner,
      onExit: () => this.sessions.delete(request.sessionID),
    });
  }

  private stopStream(sessionID: string): void {
    const session = this.sessions.get(sessionID);
    session?.process?.stop();
    this.sessions.delete(sessionID);
  }

  private buildSourceUrl(event: { deviceId: string; eventId: number; accessToken?: string }): string {
    const token = encodeURIComponent(event.accessToken ?? "");
    return `${VIDEO_SOURCE_BASE}/${encodeURIComponent(event.deviceId)}/${event.eventId}?t=${token}`;
  }
}

