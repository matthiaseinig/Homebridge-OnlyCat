import type { CachedEvent } from "./eventCache.js";

const THUMBNAIL_BASE = "https://gateway.onlycat.com/events";

// 1×1 transparent JPEG used as a fallback when no event is cached yet.
const PLACEHOLDER_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////2wBDAf//////////////////////////////////////////////////" +
  "//////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQAB" +
  "AQAAAAAAAAAAAAAAAAAAAAr/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAA" +
  "AAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AB//Z";

const PLACEHOLDER_JPEG = Buffer.from(PLACEHOLDER_JPEG_BASE64, "base64");

export function placeholderSnapshot(): Buffer {
  return PLACEHOLDER_JPEG;
}

export function thumbnailUrl(event: CachedEvent): string | null {
  if (event.posterFrameIndex === undefined) return null;
  return `${THUMBNAIL_BASE}/${event.deviceId}/${event.eventId}/${event.posterFrameIndex}`;
}

export interface SnapshotFetcher {
  fetch(url: string, signal: AbortSignal): Promise<Buffer>;
}

export class HttpSnapshotFetcher implements SnapshotFetcher {
  async fetch(url: string, signal: AbortSignal): Promise<Buffer> {
    const response = await fetch(url, { signal });
    if (!response.ok) {
      throw new Error(`Snapshot HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
}
