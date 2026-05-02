export enum EventTriggerSource {
  Unknown = -1,
  Manual = 0,
  Remote = 1,
  IndoorMotion = 2,
  OutdoorMotion = 3,
}

export enum EventClassification {
  Unknown = 0,
  Clear = 1,
  Suspicious = 2,
  Contraband = 3,
  HumanActivity = 4,
  RemoteUnlock = 10,
}

export type SubEventDirection = "INWARD" | "OUTWARD";
export type SubEventAction = "PEEK" | "TRANSIT" | "DENY" | "BREACH";

export interface SubEvent {
  startFrameIndex: number;
  endFrameIndex: number;
  rfidCode: string | null;
  direction: SubEventDirection;
  action: SubEventAction;
}

export interface OnlyCatEvent {
  globalId?: number;
  deviceId: string;
  eventId: number;
  timestamp?: string;
  frameCount?: number | null;
  eventTriggerSource?: EventTriggerSource;
  eventClassification?: EventClassification;
  posterFrameIndex?: number;
  accessToken?: string;
  rfidCodes?: string[];
  subevents?: SubEvent[];
}

export interface DeviceConnectivity {
  connected: boolean;
  disconnectReason?: string;
  timestamp?: number;
}

export interface DeviceSummary {
  deviceId: string;
}

export interface DeviceRecord {
  deviceId: string;
  description?: string;
  timeZone?: string;
  connectivity?: DeviceConnectivity;
  deviceTransitPolicyId?: number;
  firmwareVersion?: string;
  hardwareVersion?: string;
  modelName?: string;
}

export interface TransitPolicy {
  idleLock?: boolean;
  rules?: unknown[];
}

export interface DeviceTransitPolicy {
  deviceTransitPolicyId: number;
  deviceId: string;
  name: string;
  transitPolicy?: TransitPolicy;
}

export interface PolicySummary {
  deviceTransitPolicyId: number;
  deviceId: string;
  name: string;
}

export interface RfidLastSeen {
  rfidCode: string;
  timestamp?: string;
}

export interface RfidProfile {
  deviceId: string;
  rfidCode: string;
  label?: string;
}

export interface DeviceUpdatePayload {
  deviceId: string;
  type?: string;
  body?: Partial<DeviceRecord>;
}

export interface EventPushPayload extends Partial<OnlyCatEvent> {
  deviceId: string;
  eventId: number;
}

export interface OutboundRpcMap {
  getDevices: { args: { subscribe?: boolean }; reply: DeviceSummary[] };
  getDevice: { args: { deviceId: string; subscribe?: boolean }; reply: DeviceRecord };
  getDeviceTransitPolicies: { args: { deviceId: string }; reply: PolicySummary[] };
  getDeviceTransitPolicy: {
    args: { deviceTransitPolicyId: number };
    reply: DeviceTransitPolicy;
  };
  activateDeviceTransitPolicy: {
    args: { deviceId: string; deviceTransitPolicyId: number };
    reply: { success?: boolean } | null;
  };
  updateDeviceTransitPolicy: {
    args: DeviceTransitPolicy;
    reply: DeviceTransitPolicy;
  };
  getDeviceEvents: {
    args: { deviceId: string; subscribe?: boolean };
    reply: OnlyCatEvent[];
  };
  getEvent: {
    args: { deviceId: string; eventId: number; subscribe?: boolean };
    reply: OnlyCatEvent;
  };
  getLastSeenRfidCodesByDevice: {
    args: { deviceId: string };
    reply: RfidLastSeen[];
  };
  getRfidProfile: {
    args: { deviceId: string; rfidCode: string };
    reply: RfidProfile;
  };
  runDeviceCommand: {
    args: { deviceId: string; command: "reboot" | "unlock" };
    reply: unknown;
  };
}

export interface InboundEventMap {
  connect: void;
  disconnect: string;
  userUpdate: unknown;
  deviceUpdate: DeviceUpdatePayload;
  deviceEventUpdate: EventPushPayload;
  eventUpdate: EventPushPayload;
}
