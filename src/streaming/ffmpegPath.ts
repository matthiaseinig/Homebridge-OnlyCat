import { createRequire } from "node:module";

/**
 * Resolves the ffmpeg binary path the plugin should use.
 *
 *   1. If `config.ffmpegPath` was set, the caller already passed it through
 *      to the streaming/recording delegates. This module is only consulted
 *      for the default.
 *   2. Otherwise we ask the optional `ffmpeg-for-homebridge` dependency for
 *      a bundled binary path. The Homebridge team's package ships a
 *      pre-built ffmpeg with libx264 + libfdk_aac for every supported
 *      Homebridge target (Linux x64/ARM, macOS, Windows, Docker images).
 *      That binary takes care of users who don't want to install ffmpeg
 *      themselves — and crucially fixes the Homebridge OS image, where
 *      `apt-get install ffmpeg` is blocked for the homebridge service
 *      account.
 *   3. If the optional package is not installed (e.g. on Node versions it
 *      doesn't support, or in environments where the install hook was
 *      skipped), we fall back to the system `ffmpeg` resolved via PATH.
 */
export function resolveFfmpegPath(): string {
  try {
    const require_ = createRequire(import.meta.url);
    const bundled = require_("ffmpeg-for-homebridge") as string | undefined;
    if (bundled) return bundled;
  } catch {
    // optional dep absent or failed to load — silently fall back.
  }
  return "ffmpeg";
}
