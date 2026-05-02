import { describe, expect, it, vi } from "vitest";
import { FlapAccessory } from "../../src/accessories/flapAccessory.js";
import { OnlyCatClient } from "../../src/api/client.js";
import type { DeviceRecord } from "../../src/api/types.js";
import {
  MockPlatformAccessory,
  asPlatformAccessory,
  createMockApi,
  createMockLogger,
} from "../helpers/homebridge.js";
import { createMockSocket } from "../helpers/mockSocket.js";

function build() {
  const log = createMockLogger();
  const api = createMockApi();
  const socket = createMockSocket();
  const client = new OnlyCatClient({ token: "tok", log, socket });
  const device: DeviceRecord = { deviceId: "dev-1" };
  const accessory = new MockPlatformAccessory("dev-1", "uuid:dev-1");
  new FlapAccessory({
    api,
    log,
    client,
    device,
    accessory: asPlatformAccessory(accessory),
  });
  return { accessory, socket, log };
}

describe("FlapAccessory momentary switches", () => {
  it("Remote unlock switch sends runDeviceCommand command=unlock and auto-reverts", async () => {
    const { accessory, socket, log } = build();
    const sw = accessory.getService("Switch", "remote-unlock")!;
    socket.__ackResponses.set("runDeviceCommand", { ok: true });
    const spy = vi.spyOn(socket, "emitWithAck");
    vi.useFakeTimers();
    try {
      await sw.getCharacteristic("On").onSetHandler!(true);
      expect(spy).toHaveBeenCalledWith("runDeviceCommand", {
        deviceId: "dev-1",
        command: "unlock",
      });
      vi.advanceTimersByTime(600);
      expect(sw.getCharacteristic("On").value).toBe(false);
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("Sent"), "unlock", "dev-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("Reboot switch sends runDeviceCommand command=reboot", async () => {
    const { accessory, socket } = build();
    const sw = accessory.getService("Switch", "reboot")!;
    socket.__ackResponses.set("runDeviceCommand", { ok: true });
    const spy = vi.spyOn(socket, "emitWithAck");
    await sw.getCharacteristic("On").onSetHandler!(true);
    expect(spy).toHaveBeenCalledWith("runDeviceCommand", {
      deviceId: "dev-1",
      command: "reboot",
    });
  });

  it("ignores On=false (no command sent)", async () => {
    const { accessory, socket } = build();
    const sw = accessory.getService("Switch", "remote-unlock")!;
    const spy = vi.spyOn(socket, "emitWithAck");
    await sw.getCharacteristic("On").onSetHandler!(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("logs an error if the RPC throws", async () => {
    const { accessory, socket, log } = build();
    socket.__ackResponses.set("runDeviceCommand", () => {
      throw new Error("offline");
    });
    const sw = accessory.getService("Switch", "reboot")!;
    await sw.getCharacteristic("On").onSetHandler!(true);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to send"),
      "reboot",
      "dev-1",
      "offline",
    );
  });
});
