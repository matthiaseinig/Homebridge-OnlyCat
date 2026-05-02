import {
  EventClassification,
  EventTriggerSource,
  type DeviceUpdatePayload,
  type EventPushPayload,
  type EventSummary,
  type EventSummaryUpdatePayload,
  type OnlyCatEvent,
  type SubEvent,
  type SubEventAction,
  type SubEventDirection,
} from "./types.js";

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function asNumber(x: unknown): number | undefined {
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}

function asString(x: unknown): string | undefined {
  return typeof x === "string" ? x : undefined;
}

function asEnum<E extends number>(x: unknown, validValues: E[]): E | undefined {
  const n = asNumber(x);
  if (n === undefined) return undefined;
  return validValues.includes(n as E) ? (n as E) : undefined;
}

function asDirection(x: unknown): SubEventDirection | undefined {
  return x === "INWARD" || x === "OUTWARD" ? x : undefined;
}

function asAction(x: unknown): SubEventAction | undefined {
  return x === "PEEK" || x === "TRANSIT" || x === "DENY" || x === "BREACH" ? x : undefined;
}

export function decodeSubEvent(x: unknown): SubEvent | undefined {
  if (!isObject(x)) return undefined;
  const direction = asDirection(x.direction);
  const action = asAction(x.action);
  const startFrameIndex = asNumber(x.startFrameIndex);
  const endFrameIndex = asNumber(x.endFrameIndex);
  if (
    direction === undefined ||
    action === undefined ||
    startFrameIndex === undefined ||
    endFrameIndex === undefined
  ) {
    return undefined;
  }
  return {
    direction,
    action,
    startFrameIndex,
    endFrameIndex,
    rfidCode: asString(x.rfidCode) ?? null,
  };
}

const triggerValues = [
  EventTriggerSource.Unknown,
  EventTriggerSource.Manual,
  EventTriggerSource.Remote,
  EventTriggerSource.IndoorMotion,
  EventTriggerSource.OutdoorMotion,
];

const classificationValues = [
  EventClassification.Unknown,
  EventClassification.Clear,
  EventClassification.Suspicious,
  EventClassification.Contraband,
  EventClassification.HumanActivity,
  EventClassification.RemoteUnlock,
];

export function decodeEvent(x: unknown): OnlyCatEvent | undefined {
  if (!isObject(x)) return undefined;
  const deviceId = asString(x.deviceId);
  const eventId = asNumber(x.eventId);
  if (!deviceId || eventId === undefined) return undefined;

  const subevents = Array.isArray(x.subevents)
    ? x.subevents.map(decodeSubEvent).filter((s): s is SubEvent => s !== undefined)
    : undefined;

  const rfidCodes = Array.isArray(x.rfidCodes)
    ? x.rfidCodes.filter((s): s is string => typeof s === "string")
    : undefined;

  return {
    deviceId,
    eventId,
    globalId: asNumber(x.globalId),
    timestamp: asString(x.timestamp),
    frameCount: x.frameCount === null ? null : asNumber(x.frameCount),
    eventTriggerSource: asEnum(x.eventTriggerSource, triggerValues),
    eventClassification: asEnum(x.eventClassification, classificationValues),
    posterFrameIndex: asNumber(x.posterFrameIndex),
    accessToken: asString(x.accessToken),
    rfidCodes,
    subevents,
  };
}

export function decodeEventPush(x: unknown): EventPushPayload | undefined {
  const event = decodeEvent(x);
  if (!event) return undefined;
  return event as EventPushPayload;
}

export function decodeDeviceUpdate(x: unknown): DeviceUpdatePayload | undefined {
  if (!isObject(x)) return undefined;
  const deviceId = asString(x.deviceId);
  if (!deviceId) return undefined;
  const body = isObject(x.body) ? (x.body as DeviceUpdatePayload["body"]) : undefined;
  return {
    deviceId,
    type: asString(x.type),
    body,
  };
}

export function decodeEventSummary(x: unknown): EventSummary | undefined {
  if (!isObject(x)) return undefined;
  const deviceId = asString(x.deviceId);
  const eventId = asNumber(x.eventId);
  if (!deviceId || eventId === undefined) return undefined;
  const subevents = Array.isArray(x.subevents)
    ? x.subevents.map(decodeSubEvent).filter((s): s is SubEvent => s !== undefined)
    : [];
  return {
    deviceId,
    eventId,
    processedFrameCount: asNumber(x.processedFrameCount) ?? 0,
    subevents,
  };
}

export function decodeEventSummaryUpdate(
  x: unknown,
): EventSummaryUpdatePayload | undefined {
  if (!isObject(x)) return undefined;
  const deviceId = asString(x.deviceId);
  const eventId = asNumber(x.eventId);
  if (!deviceId || eventId === undefined) return undefined;
  const body = decodeEventSummary(x.body);
  return {
    deviceId,
    eventId,
    type: asString(x.type),
    timestamp: asString(x.timestamp),
    body,
  };
}
