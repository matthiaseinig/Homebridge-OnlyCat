import { vi } from "vitest";
import type { API, Logging, PlatformAccessory } from "homebridge";

export function createMockLogger(): Logging {
  const log = vi.fn() as unknown as Logging;
  log.info = vi.fn();
  log.warn = vi.fn();
  log.error = vi.fn();
  log.debug = vi.fn();
  log.log = vi.fn();
  log.success = vi.fn();
  log.prefix = "test";
  return log;
}

interface CharacteristicSpy {
  value: unknown;
  onSetHandler?: (value: unknown) => void | Promise<void>;
  onGetHandler?: () => unknown;
  updateValue: (v: unknown) => void;
  setProps?: (props: Record<string, unknown>) => CharacteristicSpy;
  onSet: (cb: (value: unknown) => void | Promise<void>) => CharacteristicSpy;
  onGet: (cb: () => unknown) => CharacteristicSpy;
}

interface ServiceSpy {
  name: string;
  type: string;
  subtype?: string;
  setCharacteristic: (id: string, value: unknown) => ServiceSpy;
  getCharacteristic: (id: string) => CharacteristicSpy;
  updateCharacteristic: (id: string, value: unknown) => ServiceSpy;
  characteristics: Map<string, CharacteristicSpy>;
}

class MockService implements ServiceSpy {
  characteristics = new Map<string, CharacteristicSpy>();
  UUID: string;
  constructor(public type: string, public name: string, public subtype?: string) {
    this.UUID = type;
  }

  setCharacteristic(id: string, value: unknown): ServiceSpy {
    const c = this.getCharacteristic(id);
    c.value = value;
    return this;
  }

  getCharacteristic(id: string): CharacteristicSpy {
    let c = this.characteristics.get(id);
    if (!c) {
      const spy: CharacteristicSpy = {
        value: undefined,
        updateValue(v: unknown): void {
          spy.value = v;
        },
        setProps(_props): CharacteristicSpy {
          return spy;
        },
        onSet(cb): CharacteristicSpy {
          spy.onSetHandler = cb;
          return spy;
        },
        onGet(cb): CharacteristicSpy {
          spy.onGetHandler = cb;
          return spy;
        },
      };
      c = spy;
      this.characteristics.set(id, c);
    }
    return c;
  }

  updateCharacteristic(id: string, value: unknown): ServiceSpy {
    this.getCharacteristic(id).updateValue(value);
    return this;
  }
}

export class MockPlatformAccessory {
  context: Record<string, unknown> = {};
  services: MockService[] = [];
  category?: number;

  constructor(public displayName: string, public UUID: string) {}

  getService(typeOrName: unknown, subtype?: string): MockService | undefined {
    const target =
      typeof typeOrName === "string"
        ? typeOrName
        : (typeOrName as { UUID?: string; name?: string }).UUID ??
          (typeOrName as { name?: string }).name ??
          "Unknown";
    return this.services.find(
      (s) =>
        (s.UUID === target || s.type === target || s.name === target) &&
        s.subtype === subtype,
    );
  }

  addService(type: unknown, name?: string, subtype?: string): MockService {
    const typeName =
      typeof type === "string"
        ? type
        : (type as { name?: string; UUID?: string }).name ??
          (type as { UUID?: string }).UUID ??
          "Unknown";
    const svc = new MockService(typeName, name ?? typeName, subtype);
    this.services.push(svc);
    return svc;
  }

  removeService(svc: MockService): void {
    this.services = this.services.filter((s) => s !== svc);
  }

  on(_event: string, _cb: () => void): this {
    return this;
  }

  configureController(_controller: unknown): void {
    // mock — store nothing
  }
}

const characteristicNames = [
  "Manufacturer",
  "Model",
  "Name",
  "SerialNumber",
  "FirmwareRevision",
  "MotionDetected",
  "OccupancyDetected",
  "OccupancyDetectedValues",
  "On",
  "LockCurrentState",
  "LockTargetState",
  "StatusFault",
  "StatusActive",
  "ConfiguredName",
];

const serviceNames = [
  "AccessoryInformation",
  "MotionSensor",
  "OccupancySensor",
  "LockMechanism",
  "Switch",
];

function buildHapStubs() {
  const Service: Record<string, { UUID: string; name: string }> = {};
  for (const n of serviceNames) Service[n] = { UUID: n, name: n };
  const Characteristic: Record<string, string> = {};
  for (const n of characteristicNames) Characteristic[n] = n;
  return { Service, Characteristic };
}

export interface MockApi extends API {
  emit(event: string, ...args: unknown[]): void;
  registeredAccessories: MockPlatformAccessory[];
  unregisteredAccessories: MockPlatformAccessory[];
  externalAccessories: MockPlatformAccessory[];
  cameraInstances: Array<{ options: unknown }>;
}

export function createMockApi(): MockApi {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const registered: MockPlatformAccessory[] = [];
  const unregistered: MockPlatformAccessory[] = [];
  const external: MockPlatformAccessory[] = [];

  const { Service, Characteristic } = buildHapStubs();

  const cameraInstances: Array<{ options: unknown }> = [];
  class MockCameraController {
    public motion?: unknown;
    public delegate?: unknown;
    public recordingDelegate?: unknown;
    constructor(public options: unknown) {
      cameraInstances.push({ options });
      const opts = options as {
        delegate?: unknown;
        recording?: { delegate?: unknown };
        sensors?: { motion?: unknown };
      };
      this.delegate = opts.delegate;
      this.recordingDelegate = opts.recording?.delegate;
      this.motion = opts.sensors?.motion;
    }
    static generateSynchronisationSource(): number {
      return 0xdeadbeef;
    }
  }

  const api = {
    hap: {
      Service,
      Characteristic,
      uuid: {
        generate: (id: string) => `uuid:${id}`,
      },
      Categories: { OTHER: 1, CAMERA: 17 },
      CameraController: MockCameraController,
    },
    on(event: string, cb: (...args: unknown[]) => void): MockApi {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(cb);
      return api as MockApi;
    },
    emit(event: string, ...args: unknown[]): void {
      const cbs = listeners.get(event);
      if (cbs) for (const cb of [...cbs]) cb(...args);
    },
    platformAccessory: MockPlatformAccessory as unknown as API["platformAccessory"],
    registerPlatform: vi.fn(),
    registerPlatformAccessories: vi.fn(
      (_p: string, _q: string, accessories: MockPlatformAccessory[]) => {
        registered.push(...accessories);
      },
    ),
    unregisterPlatformAccessories: vi.fn(
      (_p: string, _q: string, accessories: MockPlatformAccessory[]) => {
        unregistered.push(...accessories);
      },
    ),
    updatePlatformAccessories: vi.fn(),
    publishExternalAccessories: vi.fn((_p: string, accessories: MockPlatformAccessory[]) => {
      external.push(...accessories);
    }),
    version: 2.7,
    serverVersion: "1.8.4",
    user: {} as API["user"],
    versionGreaterOrEqual: () => true,
    registerAccessory: vi.fn(),
    registeredAccessories: registered,
    unregisteredAccessories: unregistered,
    externalAccessories: external,
    cameraInstances,
  } as unknown as MockApi;

  return api;
}

export function asPlatformAccessory(a: MockPlatformAccessory): PlatformAccessory {
  return a as unknown as PlatformAccessory;
}
