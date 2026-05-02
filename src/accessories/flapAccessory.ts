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
  type OnlyCatEvent,
} from "../api/types.js";
import { EventCache } from "../streaming/eventCache.js";
import { OnlyCatRecordingDelegate } from "../streaming/recordingDelegate.js";
import { OnlyCatStreamingDelegate } from "../streaming/streamingDelegate.js";

export const FLAP_MANUFACTURER = "OnlyCat";

const SUBTYPE_ACTIVITY = "activity";
const SUBTYPE_CONTRABAND = "contraband";
const SUBTYPE_HUMAN = "human";
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
  /** Skip CameraController wiring (used in unit tests where HAP camera APIs aren't available). */
  enableCamera?: boolean;
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

  private activityService!: Service;
  private contrabandService!: Service;
  private humanService!: Service;
  private onlineService!: Service;
  private lockService!: Service;
  private streamingDelegate?: OnlyCatStreamingDelegate;
  private recordingDelegate?: OnlyCatRecordingDelegate;

  constructor(deps: FlapAccessoryDeps) {
    this.api = deps.api;
    this.log = deps.log;
    this.client = deps.client;
    this.device = deps.device;
    this.accessory = deps.accessory;

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

    if (deps.enableCamera ?? false) {
      this.attachCamera(deps.ffmpegPath);
    }

    this.client.on("deviceEventUpdate", this.onEventUpdate);
    this.client.on("eventUpdate", this.onEventUpdate);
  }

  private attachCamera(ffmpegPath?: string): void {
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
    this.lockService.updateCharacteristic(Characteristic.StatusFault, fault);
    this.activityService.updateCharacteristic(Characteristic.StatusFault, fault);
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
    const idleLock = policy?.transitPolicy?.idleLock;
    if (idleLock === true) return LOCK_SECURED;
    if (idleLock === false) return LOCK_UNSECURED;
    return LOCK_UNKNOWN;
  }

  private async handleLockTarget(value: CharacteristicValue): Promise<void> {
    const desiredSecured = value === LOCK_SECURED;
    const target = this.findPolicyMatching(desiredSecured);
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
    if (existing) {
      existing.setCharacteristic(this.api.hap.Characteristic.Name, name);
      return existing;
    }
    return this.accessory.addService(ctor, name, subtype);
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
    }

    if (payload.eventClassification !== undefined) {
      this.inProgress.classification = payload.eventClassification;
    }

    this.applyClassification(this.inProgress.classification);

    if (payload.frameCount !== undefined && payload.frameCount !== null) {
      this.setActivity(false);
      this.applyClassification(undefined);
      this.inProgress = null;
    }
  };

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
    this.log.debug("Disposed FlapAccessory for %s", this.deviceId);
  }
}

export const __testing = {
  LOCK_UNSECURED,
  LOCK_SECURED,
  LOCK_JAMMED,
  LOCK_UNKNOWN,
};

function defaultRecordingOptions(): unknown {
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
      codecs: [],
    },
  };
}

function defaultStreamingOptions(): unknown {
  // Minimal H.264-only profile: HK accepts a copy of the OnlyCat clip's H.264.
  return {
    supportedCryptoSuites: [0],
    video: {
      resolutions: [
        [1280, 720, 30],
        [1024, 768, 30],
        [640, 480, 30],
        [320, 240, 15],
      ],
      codec: {
        profiles: [0, 1, 2],
        levels: [0, 1, 2],
      },
    },
    audio: {
      twoWayAudio: false,
      codecs: [],
    },
  };
}
