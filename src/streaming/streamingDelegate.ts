import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFfmpegPath } from "./ffmpegPath.js";
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
import type { CachedEvent, EventCache } from "./eventCache.js";
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
  tempFile?: string;
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
    this.ffmpegPath = deps.ffmpegPath ?? resolveFfmpegPath();
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
      // Streaming options now declare an empty audio codec list, so iOS
      // doesn't expect an audio block. Sending one regardless made iOS wait
      // for audio packets we never produce, leaving the video tile spinning.
      safeCallback(undefined, {
        video: {
          port: videoReturnPort,
          ssrc: this.api.hap.CameraController.generateSynchronisationSource(),
          srtp_key: request.video.srtp_key,
          srtp_salt: request.video.srtp_salt,
        },
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
      void this.startStream(request);
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

  private async startStream(request: StartStreamRequest): Promise<void> {
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

    // OnlyCat's gateway serves the event clip as a static MP4 over HTTPS but
    // doesn't honour Range requests, so ffmpeg's `-stream_loop -1` cannot
    // seek back to byte 0 — every loop iteration fails with
    // "Stream ends prematurely". We work around it by downloading the clip
    // to a local temp file once and pointing ffmpeg at the local file, which
    // supports seek-back natively. The file is deleted when the session ends.
    let tempFile: string;
    try {
      tempFile = await this.downloadEventClip(event);
      session.tempFile = tempFile;
    } catch (err) {
      this.log.warn(
        "Could not stage event clip for live view of %s: %s",
        this.deviceId,
        (err as Error).message,
      );
      this.stopStream(request.sessionID);
      return;
    }

    // -srtp_out_params expects a SINGLE base64 string of (key || salt) bytes,
    // not the concatenation of two separate base64 encodings. iOS sends two
    // raw buffers; we concatenate them before base64-encoding.
    const srtpOutParams = Buffer.concat([
      prepare.videoSrtpKey,
      prepare.videoSrtpSalt,
    ]).toString("base64");
    // iOS sends its desired resolution / fps / max_bit_rate / profile / level
    // in the StartStreamRequest. We must transcode to those values exactly —
    // anything else and iOS silently drops the session with no rendered
    // frames. The profile/level mismatch is invisible in our logs because
    // ffmpeg encodes happily either way; only iOS's decoder rejects it.
    const targetWidth = video.width ?? 1280;
    const targetHeight = video.height ?? 720;
    const targetFps = video.fps ?? 30;
    const targetBitrate = video.max_bit_rate ?? 299; // kbps, iOS default

    // hap-nodejs H264Profile/Level enum → libx264 string equivalents.
    const profileFromIos =
      ({ 0: "baseline", 1: "main", 2: "high" } as Record<number, string>)[
        video.profile as number
      ] ?? "baseline";
    const levelFromIos =
      ({ 0: "3.1", 1: "3.2", 2: "4.0" } as Record<number, string>)[
        video.level as number
      ] ?? "3.1";

    const args = [
      "-hide_banner",
      // Verbose enough for the bridge log to show ffmpeg's negotiated SDP and
      // per-second frame stats — we need that detail to diagnose iOS-side
      // rejections, where ffmpeg otherwise dies silently with code 255.
      "-loglevel",
      "info",
      "-re",
      "-stream_loop",
      "-1",
      "-i",
      tempFile,
      "-an",
      // Encoder pipeline mirrors homebridge-camera-ffmpeg's known-good
      // HKSV setup. -tune zerolatency implies bf=0, repeat-headers=1, and
      // a tight GOP — no need for -bsf, -g, or -bf overrides on top of it.
      "-c:v",
      "libx264",
      "-profile:v",
      profileFromIos,
      "-level:v",
      levelFromIos,
      "-preset",
      "ultrafast",
      "-tune",
      "zerolatency",
      "-pix_fmt",
      "yuv420p",
      "-color_range",
      "mpeg",
      // Plain stretch to iOS's requested dimensions — no aspect-ratio
      // padding. iOS HKSV decoders sometimes choke on padded streams.
      "-vf",
      `scale=${targetWidth}:${targetHeight}`,
      "-r",
      String(targetFps),
      // CBR at iOS's requested ceiling. Buffer = 2× target is the
      // homebridge-camera-ffmpeg convention.
      "-b:v",
      `${targetBitrate}k`,
      "-maxrate",
      `${targetBitrate}k`,
      "-bufsize",
      `${targetBitrate * 2}k`,
      "-f",
      "rtp",
      "-payload_type",
      String(video.pt),
      // ffmpeg parses -ssrc as signed int32 (max 2147483647) but RTP SSRC is
      // an unsigned 32-bit value, so iOS happily sends values up to ~4.29e9.
      // When iOS picks an SSRC > 2^31, ffmpeg refuses to write the RTP header
      // ("out of range") and the stream never starts. Force-cast to signed
      // int32 — same 32 bits on the wire; iOS reinterprets as unsigned.
      "-ssrc",
      String(video.ssrc | 0),
      "-srtp_out_suite",
      "AES_CM_128_HMAC_SHA1_80",
      "-srtp_out_params",
      srtpOutParams,
      // iOS HKSV multiplexes RTP and RTCP on the same port.
      `srtp://${prepare.targetAddress}:${prepare.videoPort}?rtcpport=${prepare.videoPort}&pkt_size=1316`,
    ];

    this.log.info(
      "Live stream for %s: %dx%d @ %d fps, %d kbps, H.264 %s level %s → %s:%d",
      this.deviceId,
      targetWidth,
      targetHeight,
      targetFps,
      targetBitrate,
      profileFromIos,
      levelFromIos,
      prepare.targetAddress,
      prepare.videoPort,
    );

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
    if (session?.tempFile) {
      const path = session.tempFile;
      // Best-effort cleanup. If a stream restarts before the unlink lands,
      // the file is overwritten on next download — no harm done.
      unlink(path).catch(() => {
        /* ignored: file may already be gone, or never created. */
      });
    }
    this.sessions.delete(sessionID);
  }

  private async downloadEventClip(event: CachedEvent): Promise<string> {
    const url = this.buildSourceUrl(event);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`gateway returned HTTP ${response.status}`);
    }
    const buf = Buffer.from(await response.arrayBuffer());
    const path = join(
      tmpdir(),
      `onlycat-${this.deviceId.replace(/[^A-Za-z0-9_-]/g, "_")}-${event.eventId}.mp4`,
    );
    await writeFile(path, buf);
    return path;
  }

  private buildSourceUrl(event: { deviceId: string; eventId: number; accessToken?: string }): string {
    const token = encodeURIComponent(event.accessToken ?? "");
    return `${VIDEO_SOURCE_BASE}/${encodeURIComponent(event.deviceId)}/${event.eventId}?t=${token}`;
  }
}

