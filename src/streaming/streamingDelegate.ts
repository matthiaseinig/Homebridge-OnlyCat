import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

// Pre-rendered loop-divider clip shipped with the package. Resolved relative
// to the compiled module in `dist/streaming/`. The slate is 1 s of solid
// black at 1280×720 / 30 fps; scale2ref at runtime resizes it to match the
// source clip's native dimensions, so 4:3 OnlyCat clips stay 4:3.
const SLATE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "assets",
  "loop-slate.mp4",
);

export interface StreamingDelegateDeps {
  api: API;
  log: Logging;
  deviceId: string;
  eventCache: EventCache;
  ffmpegPath?: string;
  spawner?: Spawner;
  snapshotFetcher?: SnapshotFetcher;
  /**
   * Prepend a 1-second black slate to the cached event clip when streaming
   * the live view, so each `-stream_loop -1` cycle has a visible boundary.
   * Defaults to true.
   */
  loopSlate?: boolean;
  // Allow tests to override port allocation deterministically.
  portAllocator?: () => Promise<number>;
}

interface PrepareInfo {
  targetAddress: string;
  videoPort: number;
  videoSrtpKey: Buffer;
  videoSrtpSalt: Buffer;
  // Our generated SSRC, returned to iOS in prepareStream and re-used as the
  // ffmpeg `-ssrc` arg. Matches the homebridge-camera-ffmpeg pattern.
  videoSsrc: number;
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
  private readonly loopSlate: boolean;
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
    this.loopSlate = deps.loopSlate !== false;
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
      // Generate our SSRC ONCE and re-use it both in the prepare response and
      // in the ffmpeg `-ssrc` arg. iOS echoes our value back in the START
      // request as `video.ssrc`, but the safer pattern (and what
      // homebridge-camera-ffmpeg does) is to drive ffmpeg from the value we
      // own — no risk of an unsigned-overflow surprise from the framework.
      const videoSsrc =
        this.api.hap.CameraController.generateSynchronisationSource();
      this.sessions.set(request.sessionID, {
        prepare: {
          targetAddress: request.targetAddress,
          videoPort: request.video.port,
          videoSrtpKey: request.video.srtp_key,
          videoSrtpSalt: request.video.srtp_salt,
          videoSsrc,
          audioPort: request.audio.port,
        },
      });
      // We declare an empty audio codec list in supportedStreamingOptions, so
      // iOS skips the audio session entirely. We still return an `audio`
      // block here because hap-nodejs's PrepareStreamResponse schema requires
      // it; ffmpeg never opens that socket.
      safeCallback(undefined, {
        video: {
          port: videoReturnPort,
          ssrc: videoSsrc,
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
    const targetWidth = video.width ?? 1280;
    const targetHeight = video.height ?? 720;
    const targetFps = video.fps ?? 30;
    const targetBitrate = video.max_bit_rate ?? 299; // kbps, iOS default

    // Pipeline copied verbatim from homebridge-camera-ffmpeg's known-good
    // HKSV streaming flow (3.1.4). Differences from our 0.2.16–0.2.24
    // attempts that camera-ffmpeg deliberately does NOT do:
    //   - No -profile:v / -level:v pinning. libx264 + -preset ultrafast
    //     emits H.264 high; iOS HKSV accepts it.
    //   - No -maxrate / -bufsize. A single -b:v cap is enough.
    //   - No synthesised audio — `-an -sn -dn` and supportedStreamingOptions
    //     declares an empty audio codec list. iOS skips the audio session.
    //   - Aspect-preserving `force_original_aspect_ratio=decrease` plus an
    //     even-divisor scale (libx264 needs even dimensions for yuv420p).
    //   - Use the SSRC we generated in prepareStream — never the value
    //     echoed back in StartStreamRequest.video.ssrc (which has hit
    //     unsigned-overflow values in production logs).
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-re",
      "-stream_loop",
      "-1",
      "-i",
      tempFile,
      "-an",
      "-sn",
      "-dn",
      "-codec:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-color_range",
      "mpeg",
      "-r",
      String(targetFps),
      "-preset",
      "ultrafast",
      "-tune",
      "zerolatency",
      "-filter:v",
      `scale='min(${targetWidth},iw)':'min(${targetHeight},ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`,
      "-b:v",
      `${targetBitrate}k`,
      "-payload_type",
      String(video.pt),
      "-ssrc",
      String(prepare.videoSsrc),
      "-f",
      "rtp",
      "-srtp_out_suite",
      "AES_CM_128_HMAC_SHA1_80",
      "-srtp_out_params",
      srtpOutParams,
      // iOS HKSV multiplexes RTP and RTCP on the same port.
      `srtp://${prepare.targetAddress}:${prepare.videoPort}?rtcpport=${prepare.videoPort}&pkt_size=1316`,
    ];

    this.log.info(
      "Live stream for %s: %dx%d @ %d fps, %d kbps → %s:%d",
      this.deviceId,
      targetWidth,
      targetHeight,
      targetFps,
      targetBitrate,
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
    const safeId = this.deviceId.replace(/[^A-Za-z0-9_-]/g, "_");
    if (!this.loopSlate) {
      // Skip augmentation entirely — stream the raw clip on seamless loop.
      const rawPath = join(
        tmpdir(),
        `onlycat-${safeId}-${event.eventId}.mp4`,
      );
      await writeFile(rawPath, buf);
      return rawPath;
    }

    const rawPath = join(
      tmpdir(),
      `onlycat-${safeId}-${event.eventId}-raw.mp4`,
    );
    const augmentedPath = join(
      tmpdir(),
      `onlycat-${safeId}-${event.eventId}.mp4`,
    );
    await writeFile(rawPath, buf);

    // Prepend the shipped slate so each `-stream_loop -1` iteration has a
    // visible boundary in iOS Home — otherwise the cached event clip
    // replays seamlessly and looks like continuous live video.
    try {
      await this.buildAugmentedClip(rawPath, augmentedPath);
      await unlink(rawPath).catch(() => {
        /* best-effort cleanup */
      });
      return augmentedPath;
    } catch (err) {
      this.log.warn(
        "Could not build loop slate for %s: %s — streaming raw clip without divider",
        this.deviceId,
        (err as Error).message,
      );
      return rawPath;
    }
  }

  /**
   * Re-encode `input` as `output` with a 1-second black slate prepended.
   *
   * The slate makes loop boundaries visible: each `-stream_loop -1` cycle
   * starts with a brief blackout so iOS Home users can tell they're seeing
   * the same event repeating rather than a live continuous feed.
   *
   * The slate is shipped pre-rendered as `assets/loop-slate.mp4` (1280×720)
   * and resized at runtime via `scale2ref` to match the source clip's
   * native dimensions, so a 4:3 800×600 OnlyCat clip ends up with an
   * 800×600 slate — no letterboxing shrinks the actual cat-flap content.
   */
  private async buildAugmentedClip(
    input: string,
    output: string,
  ): Promise<void> {
    const args = [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      SLATE_PATH,
      "-i",
      input,
      "-filter_complex",
      // scale2ref resizes the slate (input 0) to match the source clip
      // (input 1)'s pixel dimensions. We then force SAR=1:1 on both legs
      // so concat doesn't bail on a sample-aspect mismatch (OnlyCat clips
      // are encoded as 800×600 SAR 4:3, the slate as SAR 1:1) and pin
      // pix_fmt to yuv420p for the same reason.
      "[0:v][1:v]scale2ref[slate0][ev0];" +
        "[slate0]setsar=1,format=yuv420p[slate];" +
        "[ev0]setsar=1,format=yuv420p[ev];" +
        "[slate][ev]concat=n=2:v=1[v]",
      "-map",
      "[v]",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      output,
    ];

    const spawner = this.spawner ?? (spawn as unknown as Spawner);
    await new Promise<void>((resolve, reject) => {
      const child = spawner(this.ffmpegPath, args, {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) {
          resolve();
        } else {
          const tail = stderr.trim().split(/\r?\n/).slice(-3).join(" | ");
          reject(new Error(`augmentation ffmpeg exit ${code}: ${tail}`));
        }
      });
    });
  }

  private buildSourceUrl(event: { deviceId: string; eventId: number; accessToken?: string }): string {
    const token = encodeURIComponent(event.accessToken ?? "");
    return `${VIDEO_SOURCE_BASE}/${encodeURIComponent(event.deviceId)}/${event.eventId}?t=${token}`;
  }
}

