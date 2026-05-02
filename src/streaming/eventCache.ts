import type { OnlyCatEvent, EventPushPayload } from "../api/types.js";

export interface CachedEvent {
  deviceId: string;
  eventId: number;
  accessToken?: string;
  posterFrameIndex?: number;
  frameCount?: number | null;
  isComplete: boolean;
  finishedAt?: number;
}

/**
 * Tracks the most recently observed event per device. Used for snapshot fallback
 * and live-stream source selection.
 */
export class EventCache {
  private readonly latest = new Map<string, CachedEvent>();

  apply(payload: EventPushPayload | OnlyCatEvent): CachedEvent {
    const existing = this.latest.get(payload.deviceId);
    const isComplete =
      payload.frameCount !== undefined && payload.frameCount !== null;
    const next: CachedEvent = {
      deviceId: payload.deviceId,
      eventId: payload.eventId,
      accessToken: payload.accessToken ?? existing?.accessToken,
      posterFrameIndex: payload.posterFrameIndex ?? existing?.posterFrameIndex,
      frameCount: payload.frameCount ?? existing?.frameCount ?? null,
      isComplete: isComplete || (existing?.isComplete ?? false),
      finishedAt: isComplete ? Date.now() : existing?.finishedAt,
    };
    this.latest.set(payload.deviceId, next);
    return next;
  }

  get(deviceId: string): CachedEvent | undefined {
    return this.latest.get(deviceId);
  }

  clear(deviceId: string): void {
    this.latest.delete(deviceId);
  }
}
