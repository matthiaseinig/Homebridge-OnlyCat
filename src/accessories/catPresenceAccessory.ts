import type {
  API,
  Logging,
  PlatformAccessory,
  Service,
  WithUUID,
} from "homebridge";
import type { OnlyCatClient } from "../api/client.js";
import type {
  EventPushPayload,
  EventSummaryUpdatePayload,
  RfidProfile,
  SubEvent,
} from "../api/types.js";

const SUBTYPE_PRESENCE = "presence";
const OCCUPANCY_DETECTED = 1;
const OCCUPANCY_NOT_DETECTED = 0;

export interface CatPresenceDeps {
  api: API;
  log: Logging;
  client: OnlyCatClient;
  accessory: PlatformAccessory;
  profile: RfidProfile;
}

export class CatPresenceAccessory {
  private readonly api: API;
  private readonly log: Logging;
  private readonly client: OnlyCatClient;
  private readonly accessory: PlatformAccessory;

  private profile: RfidProfile;
  private presenceService!: Service;
  // Track whether the current event has produced a TRANSIT subevent for this cat.
  // If yes, we trust the summary and ignore raw direction. If no transit was
  // observed by the time the event ends, raw subevents (peeks) are ignored too —
  // the cat didn't actually go anywhere.
  private summaryTransitForCurrentEvent: number | null = null;

  constructor(deps: CatPresenceDeps) {
    this.api = deps.api;
    this.log = deps.log;
    this.client = deps.client;
    this.accessory = deps.accessory;
    this.profile = deps.profile;

    this.configureInformation();
    this.presenceService = this.ensureService(
      this.api.hap.Service.OccupancySensor,
      this.profile.label ?? this.profile.rfidCode,
      SUBTYPE_PRESENCE,
    );

    this.client.on("deviceEventUpdate", this.onEventUpdate);
    this.client.on("eventUpdate", this.onEventUpdate);
    this.client.on("eventSummaryUpdate", this.onSummaryUpdate);
  }

  get rfidCode(): string {
    return this.profile.rfidCode;
  }

  get deviceId(): string {
    return this.profile.deviceId;
  }

  applyProfileUpdate(profile: RfidProfile): void {
    this.profile = { ...this.profile, ...profile };
    this.configureInformation();
    this.presenceService.setCharacteristic(
      this.api.hap.Characteristic.Name,
      this.profile.label ?? this.profile.rfidCode,
    );
  }

  setInitialPresence(home: boolean): void {
    this.applyPresence(home);
  }

  private configureInformation(): void {
    const Service = this.api.hap.Service;
    const Characteristic = this.api.hap.Characteristic;
    const info =
      this.accessory.getService(Service.AccessoryInformation) ??
      this.accessory.addService(Service.AccessoryInformation);
    info
      .setCharacteristic(Characteristic.Manufacturer, "OnlyCat")
      .setCharacteristic(Characteristic.Model, "OnlyCat Pet")
      .setCharacteristic(Characteristic.SerialNumber, this.profile.rfidCode)
      .setCharacteristic(
        Characteristic.Name,
        this.profile.label ?? this.profile.rfidCode,
      );
  }

  private ensureService(
    ctor: WithUUID<typeof Service>,
    name: string,
    subtype: string,
  ): Service {
    const services = (this.accessory as PlatformAccessory & {
      services: Service[];
    }).services;
    const existing = services.find(
      (s) => s.UUID === ctor.UUID && s.subtype === subtype,
    );
    const service = existing ?? this.accessory.addService(ctor, name, subtype);
    (service as Service & { displayName: string }).displayName = name;
    service.setCharacteristic(this.api.hap.Characteristic.Name, name);
    return service;
  }

  private onEventUpdate = (payload: EventPushPayload): void => {
    if (payload.deviceId !== this.deviceId) return;

    // New event: reset our per-event transit memory.
    if (this.summaryTransitForCurrentEvent !== payload.eventId) {
      this.summaryTransitForCurrentEvent = null;
    }

    // Raw subevents are a fallback when no summary is yet available. Once the
    // canonical summary has produced a TRANSIT for this event we ignore raw
    // direction entirely — peeks would otherwise flip presence incorrectly.
    if (this.summaryTransitForCurrentEvent === payload.eventId) return;

    const subevents = payload.subevents ?? [];
    const lastWithCat = [...subevents]
      .reverse()
      .find((s): s is SubEvent => s.rfidCode === this.rfidCode);
    if (!lastWithCat) return;
    this.applyPresence(lastWithCat.direction === "INWARD");
  };

  private onSummaryUpdate = (payload: EventSummaryUpdatePayload): void => {
    if (payload.deviceId !== this.deviceId) return;
    if (!payload.body) return;
    const transitForCat = [...payload.body.subevents]
      .reverse()
      .find(
        (s) => s.rfidCode === this.rfidCode && s.action === "TRANSIT",
      );
    if (!transitForCat) return;
    this.summaryTransitForCurrentEvent = payload.eventId;
    this.applyPresence(transitForCat.direction === "INWARD");
  };

  private applyPresence(home: boolean): void {
    this.presenceService.updateCharacteristic(
      this.api.hap.Characteristic.OccupancyDetected,
      home ? OCCUPANCY_DETECTED : OCCUPANCY_NOT_DETECTED,
    );
    this.log.debug(
      "Cat %s (%s) is now %s",
      this.profile.label ?? this.profile.rfidCode,
      this.profile.rfidCode,
      home ? "home" : "away",
    );
  }

  dispose(): void {
    this.client.off("deviceEventUpdate", this.onEventUpdate);
    this.client.off("eventUpdate", this.onEventUpdate);
    this.client.off("eventSummaryUpdate", this.onSummaryUpdate);
  }
}
