import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from "homebridge";
import {
  CatPresenceAccessory,
  petDisplayName,
} from "./accessories/catPresenceAccessory.js";
import { FlapAccessory } from "./accessories/flapAccessory.js";
import { OnlyCatClient } from "./api/client.js";
import type { DeviceRecord, RfidProfile } from "./api/types.js";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.js";
import { redactToken } from "./util/redact.js";

export interface OnlyCatPlatformConfig extends PlatformConfig {
  token?: string;
  debug?: boolean;
  gatewayUrl?: string;
  /** Override path to the ffmpeg binary. Defaults to "ffmpeg" on PATH. */
  ffmpegPath?: string;
  /** Suppress the Camera service. Live view + HKSV will be unavailable. */
  disableCamera?: boolean;
  /** Name of the OnlyCat policy to activate when HomeKit unlocks the flap. */
  unlockPolicyName?: string;
  /** Name of the OnlyCat policy to activate when HomeKit locks the flap. */
  lockPolicyName?: string;
  /**
   * Prepend a 1-second black slate to the cached event clip when streaming
   * the live view, so each `-stream_loop -1` cycle has a visible boundary.
   * Defaults to true. Set to false for a seamless loop.
   */
  loopSlate?: boolean;
  /**
   * On startup, replay events from the last N days through HKSV. 0 disables.
   * HomeKit will timestamp replayed clips at the moment of playback, not the
   * original event time — Apple's HKSV API does not expose a backdate primitive.
   */
  replayHistoryOnStartup?: number;
}

const REPLAY_DAY_MS = 24 * 60 * 60 * 1000;
const REPLAY_GAP_MS = 5_000;
const REPLAY_BETWEEN_EVENTS_MS = 10_000;

export interface OnlyCatPlatformDeps {
  client?: OnlyCatClient;
}

interface CatKey {
  deviceId: string;
  rfidCode: string;
}

function catKeyOf(c: CatKey): string {
  return `${c.deviceId}:${c.rfidCode}`;
}

export class OnlyCatPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: PlatformAccessory[] = [];

  private readonly client: OnlyCatClient | null = null;
  private readonly flaps = new Map<string, FlapAccessory>();
  private readonly cats = new Map<string, CatPresenceAccessory>();

  constructor(
    public readonly log: Logging,
    public readonly config: OnlyCatPlatformConfig,
    public readonly api: API,
    deps: OnlyCatPlatformDeps = {},
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    if (!config.token) {
      log.error(
        "No 'token' configured. Add your OnlyCat token to the Homebridge config — the plugin will stay idle until you do.",
      );
      return;
    }

    this.client =
      deps.client ??
      new OnlyCatClient({
        token: config.token,
        url: config.gatewayUrl,
        log,
        debug: !!config.debug,
      });

    this.client.on("deviceUpdate", (payload) => {
      const flap = this.flaps.get(payload.deviceId);
      if (flap && payload.body) {
        flap.applyDeviceUpdate({ ...payload.body, deviceId: payload.deviceId });
      }
    });

    // Re-subscribe to event pushes whenever we (re-)connect. Without this,
    // the gateway never delivers deviceEventUpdate / eventUpdate after a
    // reconnect.
    this.client.on("connect", () => {
      void this.refreshSubscriptions();
    });

    api.on("didFinishLaunching", () => {
      void this.start();
    });

    api.on("shutdown", () => {
      this.stop();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug("Restoring cached accessory: %s", accessory.displayName);
    this.accessories.push(accessory);
  }

  private async start(): Promise<void> {
    if (!this.client) return;
    this.log.info(
      "Starting OnlyCat platform (token=%s)",
      redactToken(this.config.token),
    );
    try {
      await this.client.connect();
    } catch (err) {
      this.log.error(
        "Failed to connect to OnlyCat gateway: %s. The plugin will keep retrying in the background.",
        (err as Error).message,
      );
      return;
    }

    try {
      await this.discoverDevices();
    } catch (err) {
      this.log.error("Device discovery failed: %s", (err as Error).message);
    }

    this.log.info(
      "OnlyCat platform initialised with %d flap(s) and %d cat(s).",
      this.flaps.size,
      this.cats.size,
    );

    const replayDays = this.config.replayHistoryOnStartup ?? 0;
    if (replayDays > 0) {
      void this.replayHistory(replayDays);
    }
  }

  async replayHistory(
    days: number,
    options: { gapMs?: number; betweenEventsMs?: number } = {},
  ): Promise<void> {
    if (!this.client) return;
    const gapMs = options.gapMs ?? REPLAY_GAP_MS;
    const betweenEventsMs = options.betweenEventsMs ?? REPLAY_BETWEEN_EVENTS_MS;
    const cutoff = Date.now() - days * REPLAY_DAY_MS;
    this.log.info(
      "Replaying flap events from the last %d day(s). HomeKit will timestamp replayed recordings at the time of replay, not the original event time.",
      days,
    );
    for (const [deviceId, flap] of this.flaps) {
      let summaries;
      try {
        summaries = await this.client.call("getDeviceEvents", { deviceId });
      } catch (err) {
        this.log.warn(
          "Replay aborted for %s: %s",
          deviceId,
          (err as Error).message,
        );
        continue;
      }
      const recent = summaries
        .filter((e) => e.timestamp && new Date(e.timestamp).getTime() >= cutoff)
        .sort(
          (a, b) =>
            new Date(a.timestamp ?? 0).getTime() -
            new Date(b.timestamp ?? 0).getTime(),
        );
      this.log.info("Replaying %d event(s) on flap %s", recent.length, deviceId);
      for (const summary of recent) {
        try {
          const full = await this.client.call("getEvent", {
            deviceId,
            eventId: summary.eventId,
          });
          await flap.replayHistoricalEvent(full, gapMs);
        } catch (err) {
          this.log.warn(
            "Replay of event %d (%s) failed: %s",
            summary.eventId,
            deviceId,
            (err as Error).message,
          );
        }
        if (betweenEventsMs > 0) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, betweenEventsMs).unref();
          });
        }
      }
    }
    this.log.info("Replay complete.");
  }

  async discoverDevices(): Promise<void> {
    if (!this.client) return;
    const summaries = await this.client.call("getDevices", { subscribe: true });
    const seenDevices = new Set<string>();
    const seenCats = new Set<string>();

    for (const summary of summaries) {
      seenDevices.add(summary.deviceId);
      const record = await this.client.call("getDevice", {
        deviceId: summary.deviceId,
        subscribe: true,
      });
      const flap = this.adoptFlap(record);
      await this.loadPoliciesFor(record.deviceId, flap);
      await this.subscribeToEventsFor(record.deviceId, flap);
      await this.loadPetsFor(record.deviceId, seenCats);
    }

    this.pruneStaleAccessories(seenDevices, seenCats);
  }

  /**
   * Subscribes to event pushes for a device and primes the event cache from
   * the most recent concluded event so snapshots and live-view fallbacks work
   * before the next event arrives.
   */
  async subscribeToEventsFor(deviceId: string, flap: FlapAccessory): Promise<void> {
    if (!this.client) return;
    try {
      const events = await this.client.call("getDeviceEvents", {
        deviceId,
        subscribe: true,
      });
      // Most recent first.
      const sorted = [...events].sort((a, b) => {
        const at = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const bt = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return bt - at;
      });
      const latest = sorted.find((e) => e.accessToken && e.posterFrameIndex !== undefined);
      if (latest) {
        flap.primeLastEvent(latest);
        this.log.debug(
          "Primed event cache for %s with event %d",
          deviceId,
          latest.eventId,
        );
      }
    } catch (err) {
      this.log.warn(
        "Could not subscribe to events for %s: %s",
        deviceId,
        (err as Error).message,
      );
    }
  }

  /** Re-runs event subscription for every adopted flap. Used on reconnect. */
  async refreshSubscriptions(): Promise<void> {
    if (!this.client) return;
    for (const [deviceId, flap] of this.flaps) {
      try {
        await this.client.call("getDevice", { deviceId, subscribe: true });
        await this.subscribeToEventsFor(deviceId, flap);
      } catch (err) {
        this.log.warn(
          "Failed to refresh subscriptions for %s: %s",
          deviceId,
          (err as Error).message,
        );
      }
    }
  }

  private async loadPoliciesFor(
    deviceId: string,
    flap: FlapAccessory,
  ): Promise<void> {
    if (!this.client) return;
    try {
      const summaries = await this.client.call("getDeviceTransitPolicies", { deviceId });
      const loaded: string[] = [];
      for (const summary of summaries) {
        const policy = await this.client.call("getDeviceTransitPolicy", {
          deviceTransitPolicyId: summary.deviceTransitPolicyId,
        });
        flap.applyPolicy(policy);
        loaded.push(`"${policy.name}" (id=${policy.deviceTransitPolicyId}, idleLock=${policy.transitPolicy?.idleLock ?? "?"})`);
      }
      this.log.info(
        "Loaded %d transit polic%s for %s: %s",
        loaded.length,
        loaded.length === 1 ? "y" : "ies",
        deviceId,
        loaded.join(", ") || "(none)",
      );
    } catch (err) {
      this.log.warn(
        "Failed to load transit policies for %s: %s",
        deviceId,
        (err as Error).message,
      );
    }
  }

  private async loadPetsFor(deviceId: string, seenCats: Set<string>): Promise<void> {
    if (!this.client) return;
    try {
      const lastSeen = await this.client.call("getLastSeenRfidCodesByDevice", {
        deviceId,
      });
      for (const entry of lastSeen) {
        const profile = await this.client.call("getRfidProfile", {
          deviceId,
          rfidCode: entry.rfidCode,
        });
        const merged: RfidProfile = { ...profile, deviceId, rfidCode: entry.rfidCode };
        seenCats.add(catKeyOf({ deviceId, rfidCode: entry.rfidCode }));
        this.adoptCat(merged);
      }
    } catch (err) {
      this.log.warn(
        "Failed to load pet profiles for %s: %s",
        deviceId,
        (err as Error).message,
      );
    }
  }

  private adoptFlap(record: DeviceRecord): FlapAccessory {
    const uuid = this.api.hap.uuid.generate(`onlycat-flap:${record.deviceId}`);
    const cached = this.accessories.find((a) => a.UUID === uuid);

    let accessory: PlatformAccessory;
    let isNew = false;

    if (cached) {
      accessory = cached;
      accessory.displayName = record.description ?? accessory.displayName;
    } else {
      const Ctor = this.api.platformAccessory;
      accessory = new Ctor(record.description ?? "OnlyCat Flap", uuid);
      isNew = true;
    }

    // Mark the accessory as a Camera category so iOS Home groups all the linked
    // services (motion, occupancy, lock, switches) under one camera tile.
    const cameraCategory = (this.api.hap as unknown as {
      Categories?: { CAMERA?: number };
    }).Categories?.CAMERA;
    if (cameraCategory !== undefined && !this.config.disableCamera) {
      (accessory as PlatformAccessory & { category?: number }).category = cameraCategory;
    }

    accessory.context.device = record;

    const flap = new FlapAccessory({
      api: this.api,
      log: this.log,
      client: this.client!,
      device: record,
      accessory,
      ffmpegPath: this.config.ffmpegPath,
      disableCamera: this.config.disableCamera,
      unlockPolicyName: this.config.unlockPolicyName,
      lockPolicyName: this.config.lockPolicyName,
      loopSlate: this.config.loopSlate,
    });
    this.flaps.set(record.deviceId, flap);

    if (isNew) {
      this.log.info("Adopted new flap: %s (%s)", accessory.displayName, record.deviceId);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    }
    return flap;
  }

  private adoptCat(profile: RfidProfile): CatPresenceAccessory {
    const uuid = this.api.hap.uuid.generate(
      `onlycat-cat:${profile.deviceId}:${profile.rfidCode}`,
    );
    const cached = this.accessories.find((a) => a.UUID === uuid);

    let accessory: PlatformAccessory;
    let isNew = false;
    const displayName = petDisplayName(profile);

    if (cached) {
      accessory = cached;
      accessory.displayName = displayName;
    } else {
      const Ctor = this.api.platformAccessory;
      accessory = new Ctor(displayName, uuid);
      isNew = true;
    }

    accessory.context.cat = profile;

    const existing = this.cats.get(catKeyOf(profile));
    if (existing) {
      existing.applyProfileUpdate(profile);
      return existing;
    }

    const cat = new CatPresenceAccessory({
      api: this.api,
      log: this.log,
      client: this.client!,
      accessory,
      profile,
    });
    this.cats.set(catKeyOf(profile), cat);

    if (isNew) {
      this.log.info(
        "Adopted new cat: %s (rfid=%s, flap=%s)",
        displayName,
        profile.rfidCode,
        profile.deviceId,
      );
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    }
    return cat;
  }

  private pruneStaleAccessories(
    seenDeviceIds: Set<string>,
    seenCatKeys: Set<string>,
  ): void {
    const stale: PlatformAccessory[] = [];
    for (const a of this.accessories) {
      const device = a.context.device as DeviceRecord | undefined;
      const cat = a.context.cat as RfidProfile | undefined;
      if (device && !seenDeviceIds.has(device.deviceId)) stale.push(a);
      if (cat && !seenCatKeys.has(catKeyOf(cat))) stale.push(a);
    }
    if (stale.length === 0) return;
    this.log.info("Removing %d stale accessory/accessories.", stale.length);
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    for (const a of stale) {
      const idx = this.accessories.indexOf(a);
      if (idx >= 0) this.accessories.splice(idx, 1);
    }
  }

  private stop(): void {
    this.log.info("OnlyCat platform shutting down.");
    for (const flap of this.flaps.values()) flap.dispose();
    for (const cat of this.cats.values()) cat.dispose();
    this.flaps.clear();
    this.cats.clear();
    this.client?.disconnect();
  }
}
