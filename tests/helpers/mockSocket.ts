import { vi } from "vitest";
import type { Socket } from "socket.io-client";

export interface MockSocket extends Socket {
  __emit(event: string, ...args: unknown[]): void;
  __ackResponses: Map<string, unknown | ((args: unknown) => unknown)>;
}

export function createMockSocket(): MockSocket {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const onceHandlers = new Map<string, Array<(...args: unknown[]) => void>>();

  let connected = false;

  const ackResponses = new Map<string, unknown | ((args: unknown) => unknown)>();

  const socket: Partial<MockSocket> & { __emit: MockSocket["__emit"] } = {
    get connected() {
      return connected;
    },
    on(event: string, cb: (...args: unknown[]) => void) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(cb);
      return socket as Socket;
    },
    once(event: string, cb: (...args: unknown[]) => void) {
      if (!onceHandlers.has(event)) onceHandlers.set(event, []);
      onceHandlers.get(event)!.push(cb);
      return socket as Socket;
    },
    off(event: string, cb?: (...args: unknown[]) => void) {
      if (cb) {
        handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== cb));
        onceHandlers.set(event, (onceHandlers.get(event) ?? []).filter((h) => h !== cb));
      } else {
        handlers.delete(event);
        onceHandlers.delete(event);
      }
      return socket as Socket;
    },
    connect: vi.fn(() => {
      connected = true;
      socket.__emit!("connect");
      return socket as Socket;
    }),
    disconnect: vi.fn(() => {
      connected = false;
      socket.__emit!("disconnect", "io client disconnect");
      return socket as Socket;
    }),
    timeout(_ms: number) {
      return socket as Socket;
    },
    async emitWithAck(event: string, args: unknown): Promise<unknown> {
      const handler = ackResponses.get(event);
      if (typeof handler === "function") {
        return (handler as (a: unknown) => unknown)(args);
      }
      return handler;
    },
    __emit(event: string, ...args: unknown[]) {
      const list = handlers.get(event);
      if (list) for (const cb of [...list]) cb(...args);
      const once = onceHandlers.get(event);
      if (once) {
        onceHandlers.set(event, []);
        for (const cb of once) cb(...args);
      }
    },
    __ackResponses: ackResponses,
  };

  return socket as MockSocket;
}
