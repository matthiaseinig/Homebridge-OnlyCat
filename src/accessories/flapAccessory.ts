import type {
  API,
  CharacteristicValue,
  Logging,
  PlatformAccessory,
  Service,
  WithUUID,
} from "homebridge";
import type { OnlyCatClient } from "../api/client.js";
import {
  EventClassification,
  type DeviceConnectivity,
  type DeviceRecord,
  type DeviceTransitPolicy,
  type EventPushPayload,
  type EventSummaryUpdatePayload,
  type OnlyCatEvent,
  type SubEvent,
} from "../api/types.js";
import { EventCache } from "../streaming/eventCache.js";
import { OnlyCatRecordingDelegate } from "../streaming/recordingDelegate.js";
import { OnlyCatStreamingDelegate } from "../streaming/streamingDelegate.js";

export const FLAP_MANUFACTURER = "OnlyCat";

const SUBTYPE_ACTIVITY = "activity";
const SUBTYPE_CONTRABAND = "contraband";
const SUBTYPE_HUMAN = "human";
const SUBTYPE_BREACH = "breach";
const SUBTYPE_BLOCKED = "blocked";
const SUBTYPE_ONLINE = "online";
const SUBTYPE_LOCK = "lock";
const SUBTYPE_UNLOCK_BUTTON = "remote-unlock";
const SUBTYPE_REBOOT_BUTTON = "reboot";

const STATUS_FAULT_NO_FAULT = 0;
const STATUS_FAULT_GENERAL_FAULT = 1;

// HAP LockMechanism values
const LOCK_UNSECURED = 0;
const LOCK_SECURED = 1;
const LOCK_JAMMED = 2;
const LOCK_UNKNOWN = 3;

export interface FlapAccessoryDeps {
  api: API;
  log: Logging;
  client: OnlyCatClient;
  device: DeviceRecord;
  accessory: PlatformAccessory;
  ffmpegPath?: string;
  /** When true, skip CameraController wiring. Default false (camera on). */
  disableCamera?: boolean;
  /** Name of the OnlyCat policy to activate when HomeKit unlocks the flap. */
  unlockPolicyName?: string;
  /** Name of the OnlyCat policy to activate when HomeKit locks the flap. */
  lockPolicyName?: string;
  /** Prepend a 1-second black slate to live-view loops. Default true. */
  loopSlate?: boolean;
}

interface InProgressEvent {
  eventId: number;
  classification?: EventClassification;
}

export class FlapAccessory {
  private readonly api: API;
  private readonly log: Logging;
  private readonly client: OnlyCatClient;
  private readonly accessory: PlatformAccessory;

  private device: DeviceRecord;
  private inProgress: InProgressEvent | null = null;

  private readonly policies = new Map<number, DeviceTransitPolicy>();
  private readonly eventCache = new EventCache();
  private readonly unlockPolicyName?: string;
  private readonly lockPolicyName?: string;

  private activityService!: Service;
  private contrabandService!: Service;
  private humanService!: Service;
  private breachService!: Service;
  private blockedService!: Service;
  private onlineService!: Service;
  private lockService!: Service;
  private streamingDelegate?: OnlyCatStreamingDelegate;
  private recordingDelegate?: OnlyCatRecordingDelegate;
  private summarySubscribedFor: number | null = null;

  constructor(deps: FlapAccessoryDeps) {
    this.api = deps.api;
    this.log = deps.log;
    this.client = deps.client;
    this.device = deps.device;
    this.accessory = deps.accessory;
    this.unlockPolicyName = deps.unlockPolicyName?.trim() || undefined;
    this.lockPolicyName = deps.lockPolicyName?.trim() || undefined;

    this.configureInformation();

    const Service = this.api.hap.Service;
    this.activityService = this.ensureService(
      Service.MotionSensor,
      "Activity",
      SUBTYPE_ACTIVITY,
    );
    this.contrabandService = this.ensureService(
      Service.OccupancySensor,
      "Contraband",
      SUBTYPE_CONTRABAND,
    );
    this.humanService = this.ensureService(
      Service.OccupancySensor,
      "Human at flap",
      SUBTYPE_HUMAN,
    );
    this.breachService = this.ensureService(
      Service.OccupancySensor,
      "Breach",
      SUBTYPE_BREACH,
    );
    this.blockedService = this.ensureService(
      Service.OccupancySensor,
      "Blocked",
      SUBTYPE_BLOCKED,
    );
    this.onlineService = this.ensureService(
      Service.OccupancySensor,
      "Online",
      SUBTYPE_ONLINE,
    );

    this.lockService = this.ensureService(
      Service.LockMechanism,
      "Cat Flap",
      SUBTYPE_LOCK,
    );
    this.wireLockHandlers();
    this.applyConnectivity(this.device.connectivity);
    this.wireMomentarySwitch(
      Service.Switch,
      "Remote unlock",
      SUBTYPE_UNLOCK_BUTTON,
      "unlock",
    );
    this.wireMomentarySwitch(
      Service.Switch,
      "Reboot",
      SUBTYPE_REBOOT_BUTTON,
      "reboot",
    );

    if (deps.disableCamera !== true) {
      this.attachCamera(deps.ffmpegPath, deps.loopSlate);
    }

    this.client.on("deviceEventUpdate", this.onEventUpdate);
    this.client.on("eventUpdate", this.onEventUpdate);
    this.client.on("eventSummaryUpdate", this.onSummaryUpdate);
  }

  private attachCamera(ffmpegPath?: string, loopSlate?: boolean): void {
    const hap = this.api.hap as unknown as {
      CameraController?: new (options: unknown) => unknown;
    };
    if (!hap.CameraController) return;
    this.streamingDelegate = new OnlyCatStreamingDelegate({
      api: this.api,
      log: this.log,
      deviceId: this.device.deviceId,
      eventCache: this.eventCache,
      ffmpegPath,
      // Default ON. Users who prefer seamless loops set loopSlate: false.
      loopSlate: loopSlate !== false,
    });
    this.recordingDelegate = new OnlyCatRecordingDelegate({
      log: this.log,
      deviceId: this.device.deviceId,
      eventCache: this.eventCache,
      ffmpegPath,
    });
    const controller = new hap.CameraController({
      cameraStreamCount: 2,
      delegate: this.streamingDelegate,
      streamingOptions: defaultStreamingOptions(),
      recording: {
        delegate: this.recordingDelegate,
        options: defaultRecordingOptions(),
      },
      sensors: {
        motion: this.activityService,
      },
    });
    this.streamingDelegate.attachController(controller as never);
    (this.accessory as PlatformAccessory & {
      configureController(c: unknown): void;
    }).configureController(controller);
  }

  get deviceId(): string {
    return this.device.deviceId;
  }

  applyDeviceUpdate(record: Partial<DeviceRecord>): void {
    this.device = { ...this.device, ...record };
    this.configureInformation();
    this.refreshLockState();
    if (record.connectivity !== undefined) {
      this.applyConnectivity(record.connectivity);
    }
  }

  applyConnectivity(connectivity: DeviceConnectivity | undefined): void {
    const Characteristic = this.api.hap.Characteristic;
    const online = connectivity?.connected !== false;
    this.onlineService.updateCharacteristic(
      Characteristic.OccupancyDetected,
      online ? 1 : 0,
    );
    const fault = online ? STATUS_FAULT_NO_FAULT : STATUS_FAULT_GENERAL_FAULT;
    // StatusFault is optional on MotionSensor and OccupancySensor but not on
    // LockMechanism, so we only set it where HAP accepts it.
    this.activityService.updateCharacteristic(Characteristic.StatusFault, fault);
    this.onlineService.updateCharacteristic(Characteristic.StatusFault, fault);
    if (connectivity && connectivity.connected === false) {
      this.log.info(
        "Flap %s went offline%s",
        this.device.deviceId,
        connectivity.disconnectReason ? ` (${connectivity.disconnectReason})` : "",
      );
    } else if (connectivity?.connected) {
      this.log.info("Flap %s is online", this.device.deviceId);
    }
  }

  /**
   * Push a previously-concluded event through the same handler chain as a live one,
   * so that HKSV records its clip and the sensors fire. Used for opt-in
   * `replayHistoryOnStartup`. Note: HomeKit will timestamp the resulting recording
   * at the moment of replay, not the event's original timestamp — that's an
   * unavoidable HKSV API limitation.
   */
  async replayHistoricalEvent(event: OnlyCatEvent, gapMs = 5000): Promise<void> {
    const baseline: EventPushPayload = {
      ...event,
      deviceId: this.device.deviceId,
      eventId: event.eventId,
      frameCount: null,
    };
    const conclusion: EventPushPayload = {
      ...event,
      deviceId: this.device.deviceId,
      eventId: event.eventId,
      frameCount: event.frameCount ?? 30,
    };
    this.onEventUpdate(baseline);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, gapMs).unref();
    });
    this.onEventUpdate(conclusion);
  }

  applyPolicy(policy: DeviceTransitPolicy): void {
    this.policies.set(policy.deviceTransitPolicyId, policy);
    this.refreshLockState();
  }

  private configureInformation(): void {
    const Service = this.api.hap.Service;
    const Characteristic = this.api.hap.Characteristic;
    const info =
      this.accessory.getService(Service.AccessoryInformation) ??
      this.accessory.addService(Service.AccessoryInformation);
    info
      .setCharacteristic(Characteristic.Manufacturer, FLAP_MANUFACTURER)
      .setCharacteristic(
        Characteristic.Model,
        this.device.modelName ?? "OnlyCat Smart Cat Flap",
      )
      .setCharacteristic(Characteristic.SerialNumber, this.device.deviceId)
      .setCharacteristic(
        Characteristic.FirmwareRevision,
        this.device.firmwareVersion ?? "0.0.0",
      )
      .setCharacteristic(
        Characteristic.Name,
        this.device.description ?? "OnlyCat Flap",
      );
  }

  private wireMomentarySwitch(
    ctor: WithUUID<typeof Service>,
    name: string,
    subtype: string,
    command: "reboot" | "unlock",
  ): void {
    const Characteristic = this.api.hap.Characteristic;
    const switchService = this.ensureService(ctor, name, subtype);
    switchService
      .getCharacteristic(Characteristic.On)
      .onSet(async (value) => {
        if (value !== true) return;
        try {
          await this.client.call("runDeviceCommand", {
            deviceId: this.device.deviceId,
            command,
          });
          this.log.info("Sent %s command to %s", command, this.device.deviceId);
        } catch (err) {
          this.log.error(
            "Failed to send %s to %s: %s",
            command,
            this.device.deviceId,
            (err as Error).message,
          );
        } finally {
          // momentary — auto-revert
          setTimeout(() => {
            switchService.updateCharacteristic(Characteristic.On, false);
          }, 500).unref();
        }
      });
  }

  private wireLockHandlers(): void {
    const Characteristic = this.api.hap.Characteristic;
    this.lockService
      .getCharacteristic(Characteristic.LockTargetState)
      .onSet((value: CharacteristicValue) => this.handleLockTarget(value));

    this.refreshLockState();
  }

  private refreshLockState(): void {
    const Characteristic = this.api.hap.Characteristic;
    const current = this.computeLockCurrentState();
    this.lockService.updateCharacteristic(
      Characteristic.LockCurrentState,
      current,
    );
    if (current === LOCK_SECURED || current === LOCK_UNSECURED) {
      this.lockService.updateCharacteristic(Characteristic.LockTargetState, current);
    }
  }

  private computeLockCurrentState(): number {
    const policy =
      this.device.deviceTransitPolicyId !== undefined
        ? this.policies.get(this.device.deviceTransitPolicyId)
        : undefined;
    if (!policy) return LOCK_UNKNOWN;

    // When the user has explicitly named lock/unlock policies, those names ARE
    // the source of truth — independent of idleLock. OnlyCat policies often
    // have idleLock=true even when they "let cats through" (the flap is idle-
    // locked and only unlocks per-cat after RFID detection); a user's mental
    // "unlocked" state can map to a policy that idleLock-wise is locked.
    const activeName = policy.name?.toLowerCase();
    if (activeName) {
      if (this.lockPolicyName && activeName === this.lockPolicyName.toLowerCase()) {
        return LOCK_SECURED;
      }
      if (this.unlockPolicyName && activeName === this.unlockPolicyName.toLowerCase()) {
        return LOCK_UNSECURED;
      }
    }

    const idleLock = policy.transitPolicy?.idleLock;
    if (idleLock === true) return LOCK_SECURED;
    if (idleLock === false) return LOCK_UNSECURED;
    return LOCK_UNKNOWN;
  }

  private async handleLockTarget(value: CharacteristicValue): Promise<void> {
    const desiredSecured = value === LOCK_SECURED;
    this.log.info(
      "Lock target requested: %s on %s (configured names: lock=%j, unlock=%j)",
      desiredSecured ? "lock" : "unlock",
      this.device.deviceId,
      this.lockPolicyName ?? null,
      this.unlockPolicyName ?? null,
    );
    const target = this.findPolicyForLockState(desiredSecured);
    if (!target) {
      this.log.warn(
        "No transit policy matches the requested lock state for %s; flap stays in %s.",
        this.device.deviceId,
        desiredSecured ? "unlocked" : "locked",
      );
      this.lockService.updateCharacteristic(
        this.api.hap.Characteristic.LockCurrentState,
        LOCK_JAMMED,
      );
      return;
    }
    try {
      this.log.info(
        "Activating policy %j (id=%d) on %s",
        target.name,
        target.deviceTransitPolicyId,
        this.device.deviceId,
      );
      await this.client.call("activateDeviceTransitPolicy", {
        deviceId: this.device.deviceId,
        deviceTransitPolicyId: target.deviceTransitPolicyId,
      });
      this.device = { ...this.device, deviceTransitPolicyId: target.deviceTransitPolicyId };
      this.refreshLockState();
    } catch (err) {
      this.log.error(
        "Failed to activate policy %d on %s: %s",
        target.deviceTransitPolicyId,
        this.device.deviceId,
        (err as Error).message,
      );
      this.lockService.updateCharacteristic(
        this.api.hap.Characteristic.LockCurrentState,
        LOCK_JAMMED,
      );
    }
  }

  private findPolicyForLockState(
    secured: boolean,
  ): DeviceTransitPolicy | undefined {
    const configuredName = secured ? this.lockPolicyName : this.unlockPolicyName;
    if (configuredName) {
      const target = configuredName.toLowerCase();
      for (const policy of this.policies.values()) {
        if (policy.name?.toLowerCase() === target) return policy;
      }
      this.log.warn(
        "Configured %s policy %j not found on flap %s — falling back to the first matching idleLock policy.",
        secured ? "lock" : "unlock",
        configuredName,
        this.device.deviceId,
      );
    }
    return this.findPolicyMatching(secured);
  }

  private findPolicyMatching(secured: boolean): DeviceTransitPolicy | undefined {
    for (const policy of this.policies.values()) {
      if (policy.transitPolicy?.idleLock === secured) return policy;
    }
    return undefined;
  }

  private ensureService(
    ctor: WithUUID<typeof Service>,
    name: string,
    subtype: string,
  ): Service {
    const existing = this.findService(ctor, subtype);
    const service = existing ?? this.accessory.addService(ctor, name, subtype);
    applyServiceName(service, name, this.api.hap.Characteristic);
    return service;
  }

  /** Pre-populate the event cache from a previously-recorded event. */
  primeLastEvent(event: OnlyCatEvent): void {
    this.eventCache.apply({
      ...event,
      deviceId: this.device.deviceId,
      eventId: event.eventId,
    });
  }

  private findService(
    ctor: WithUUID<typeof Service>,
    subtype: string,
  ): Service | undefined {
    const services = (this.accessory as PlatformAccessory & {
      services: Service[];
    }).services;
    return services.find((s) => s.UUID === ctor.UUID && s.subtype === subtype);
  }

  private onEventUpdate = (payload: EventPushPayload): void => {
    if (payload.deviceId !== this.deviceId) return;

    this.eventCache.apply(payload);

    if (this.inProgress === null || this.inProgress.eventId !== payload.eventId) {
      this.inProgress = {
        eventId: payload.eventId,
        classification: payload.eventClassification,
      };
      this.setActivity(true);
      this.resetSummaryFlags();
      void this.subscribeToSummary(payload.eventId);
    }

    if (payload.eventClassification !== undefined) {
      this.inProgress.classification = payload.eventClassification;
    }

    this.applyClassification(this.inProgress.classification);

    if (payload.frameCount !== undefined && payload.frameCount !== null) {
      this.setActivity(false);
      this.applyClassification(undefined);
      this.resetSummaryFlags();
      this.inProgress = null;
      this.summarySubscribedFor = null;
    }
  };

  private async subscribeToSummary(eventId: number): Promise<void> {
    if (this.summarySubscribedFor === eventId) return;
    this.summarySubscribedFor = eventId;
    try {
      const summary = await this.client.call("getEventSummary", {
        deviceId: this.device.deviceId,
        eventId,
        subscribe: true,
      });
      if (summary) {
        this.applySummary(summary.subevents);
      }
    } catch (err) {
      this.log.debug(
        "getEventSummary failed for %s/%d: %s",
        this.device.deviceId,
        eventId,
        (err as Error).message,
      );
    }
  }

  private onSummaryUpdate = (payload: EventSummaryUpdatePayload): void => {
    if (payload.deviceId !== this.deviceId) return;
    if (this.inProgress && payload.eventId !== this.inProgress.eventId) return;
    if (!payload.body) return;
    this.applySummary(payload.body.subevents);
  };

  private applySummary(subevents: SubEvent[]): void {
    const breach = subevents.some((s) => s.action === "BREACH");
    const blocked = subevents.some((s) => s.action === "DENY");
    this.setOccupancy(this.breachService, breach);
    this.setOccupancy(this.blockedService, blocked);
    if (breach) {
      this.log.warn(
        "Breach detected on flap %s — flap was supposedly locked but a cat transited.",
        this.device.deviceId,
      );
    }
  }

  private resetSummaryFlags(): void {
    this.setOccupancy(this.breachService, false);
    this.setOccupancy(this.blockedService, false);
  }

  private applyClassification(c: EventClassification | undefined): void {
    this.setOccupancy(this.contrabandService, c === EventClassification.Contraband);
    this.setOccupancy(this.humanService, c === EventClassification.HumanActivity);
  }

  private setActivity(on: boolean): void {
    this.activityService.updateCharacteristic(
      this.api.hap.Characteristic.MotionDetected,
      on,
    );
  }

  private setOccupancy(service: Service, on: boolean): void {
    const Characteristic = this.api.hap.Characteristic;
    service.updateCharacteristic(
      Characteristic.OccupancyDetected,
      on ? 1 : 0,
    );
  }

  dispose(): void {
    this.client.off("deviceEventUpdate", this.onEventUpdate);
    this.client.off("eventUpdate", this.onEventUpdate);
    this.client.off("eventSummaryUpdate", this.onSummaryUpdate);
    this.log.debug("Disposed FlapAccessory for %s", this.deviceId);
  }
}

export const __testing = {
  LOCK_UNSECURED,
  LOCK_SECURED,
  LOCK_JAMMED,
  LOCK_UNKNOWN,
  applyServiceName,
};

/**
 * Force a descriptive label on a service in three layers:
 *
 *  - `service.displayName` so HAP-NodeJS persists it in the accessory cache.
 *  - `Name` characteristic so HAP exposes it in the accessory description.
 *  - `ConfiguredName` (when supported), with an onSet handler that swallows
 *    the iOS-generated writes from the "Camera Details" pairing dialog
 *    ("Motion Sensor", "Occupancy Sensor 2", "Switch", …). Without this
 *    interception, iOS Home permanently overwrites our label the moment the
 *    user taps "Continue" through that dialog.
 */
export function applyServiceName(
  service: Service,
  name: string,
  Characteristic: { Name: WithUUID<unknown>; ConfiguredName?: WithUUID<unknown> },
): void {
  (service as Service & { displayName: string }).displayName = name;
  service.setCharacteristic(Characteristic.Name as never, name);
  if (Characteristic.ConfiguredName) {
    const c = service.getCharacteristic(Characteristic.ConfiguredName as never);
    c.updateValue(name);
    c.onSet(() => {
      // Intentionally a no-op. iOS's pairing flow tries to write generic
      // labels back to ConfiguredName, and any user attempt to rename via the
      // Home app would also land here — we keep the plugin-controlled name so
      // automations and labels stay coherent across re-pairings.
    });
  }
}

function defaultRecordingOptions(): unknown {
  // HKSV requires at least one audio codec configuration even if the camera
  // produces no audio. Declaring AAC-LC at 24 kHz mono / variable bit-rate
  // satisfies the validator; the actual stream is still silent.
  return {
    prebufferLength: 0,
    eventTriggerOptions: 1, // motion
    mediaContainerConfiguration: {
      type: 0, // MP4
      fragmentLength: 4000,
    },
    video: {
      type: 0, // H264
      parameters: {
        profiles: [0, 1, 2],
        levels: [0, 1, 2],
      },
      resolutions: [
        [1280, 720, 30],
        [1024, 768, 30],
        [640, 480, 30],
      ],
    },
    audio: {
      codecs: [
        {
          type: 0, // AAC_LC
          audioChannels: 1,
          samplerate: 2, // 24 kHz
          bitrateMode: 0, // VARIABLE
        },
      ],
    },
  };
}

function defaultStreamingOptions(): unknown {
  // OnlyCat event clips are 800×600 at 10 fps. We declared 30 fps here
  // originally and let ffmpeg duplicate every source frame three times to
  // reach that rate — iOS HKSV ended up seeing runs of bit-identical RTP
  // packets and silently rejecting the stream. Declaring 10 fps (the
  // source's actual rate) means iOS asks for 10 fps and ffmpeg passes it
  // through without duplication.
  return {
    supportedCryptoSuites: [0],
    video: {
      resolutions: [
        [1280, 720, 10],
        [1024, 768, 10],
        [800, 600, 10],
        [640, 480, 10],
        [320, 240, 10],
      ],
      codec: {
        profiles: [0, 1, 2],
        levels: [0, 1, 2],
      },
    },
    audio: {
      twoWayAudio: false,
      // Empty codec list — iOS allocates audio RTP sockets in prepareStream
      // anyway (HAP-NodeJS schema requires it) but won't expect us to send
      // anything on them. Matches homebridge-camera-ffmpeg when audio is
      // disabled. Synthesising silent audio (the v0.2.24 attempt) did not
      // unblock the video tile, so we go back to the simpler config.
      codecs: [],
    },
  };
}
