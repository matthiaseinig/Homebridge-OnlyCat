import type { Logging } from "homebridge";
import { type Socket, io } from "socket.io-client";
import { redactToken } from "../util/redact.js";
import { decodeDeviceUpdate, decodeEventPush } from "./decoders.js";
import type { InboundEventMap, OutboundRpcMap } from "./types.js";

export const DEFAULT_GATEWAY_URL = "https://gateway.onlycat.com";
export const RPC_TIMEOUT_MS = 30_000;
export const RECONNECT_DELAY_MS = 10_000;

export interface OnlyCatClientOptions {
  token: string;
  log: Logging;
  url?: string;
  socket?: Socket;
  debug?: boolean;
}

type Listener<E extends keyof InboundEventMap> = (
  payload: InboundEventMap[E],
) => void | Promise<void>;

export class OnlyCatClient {
  private readonly socket: Socket;
  private readonly token: string;
  private readonly log: Logging;
  private readonly debugEnabled: boolean;
  private readonly typedListeners = new Map<
    keyof InboundEventMap,
    Set<Listener<keyof InboundEventMap>>
  >();

  constructor(opts: OnlyCatClientOptions) {
    this.token = opts.token;
    this.log = opts.log;
    this.debugEnabled = opts.debug ?? false;

    this.socket =
      opts.socket ??
      io(opts.url ?? DEFAULT_GATEWAY_URL, {
        transports: ["websocket"],
        auth: { token: this.token },
        extraHeaders: {
          platform: "homebridge",
          device: "homebridge-onlycat",
        },
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: RECONNECT_DELAY_MS,
        reconnectionDelayMax: RECONNECT_DELAY_MS,
        autoConnect: false,
      });

    this.socket.on("connect", () => {
      this.log.info("Connected to OnlyCat gateway.");
      this.dispatch("connect", undefined);
    });

    this.socket.on("connect_error", (err: Error) => {
      this.log.warn("OnlyCat gateway connection error: %s", err.message);
    });

    this.socket.on("disconnect", (reason: string) => {
      this.log.info("Disconnected from OnlyCat gateway: %s", reason);
      this.dispatch("disconnect", reason);
    });

    this.socket.on("deviceUpdate", (raw: unknown) => {
      const decoded = decodeDeviceUpdate(raw);
      if (!decoded) {
        this.log.warn("Discarded malformed deviceUpdate payload");
        return;
      }
      this.dispatch("deviceUpdate", decoded);
    });

    this.socket.on("deviceEventUpdate", (raw: unknown) => {
      const decoded = decodeEventPush(raw);
      if (!decoded) {
        this.log.warn("Discarded malformed deviceEventUpdate payload");
        return;
      }
      this.dispatch("deviceEventUpdate", decoded);
    });

    this.socket.on("eventUpdate", (raw: unknown) => {
      const decoded = decodeEventPush(raw);
      if (!decoded) {
        this.log.warn("Discarded malformed eventUpdate payload");
        return;
      }
      this.dispatch("eventUpdate", decoded);
    });

    this.socket.on("userUpdate", (raw: unknown) => {
      this.dispatch("userUpdate", raw);
    });
  }

  async connect(): Promise<void> {
    if (this.socket.connected) return;
    if (this.debugEnabled) {
      this.log.debug("Connecting to OnlyCat (token=%s)", redactToken(this.token));
    }
    await new Promise<void>((resolve, reject) => {
      const onConnect = (): void => {
        cleanup();
        resolve();
      };
      const onError = (err: Error): void => {
        cleanup();
        reject(err);
      };
      const cleanup = (): void => {
        this.socket.off("connect", onConnect);
        this.socket.off("connect_error", onError);
      };
      this.socket.once("connect", onConnect);
      this.socket.once("connect_error", onError);
      this.socket.connect();
    });
  }

  disconnect(): void {
    this.socket.disconnect();
  }

  isConnected(): boolean {
    return this.socket.connected;
  }

  async call<E extends keyof OutboundRpcMap>(
    event: E,
    args: OutboundRpcMap[E]["args"],
  ): Promise<OutboundRpcMap[E]["reply"]> {
    if (this.debugEnabled) {
      this.log.debug("RPC -> %s %j", event, args);
    }
    const reply = (await this.socket
      .timeout(RPC_TIMEOUT_MS)
      .emitWithAck(event, args)) as OutboundRpcMap[E]["reply"];
    if (this.debugEnabled) {
      this.log.debug("RPC <- %s", event);
    }
    return reply;
  }

  on<E extends keyof InboundEventMap>(event: E, listener: Listener<E>): void {
    let set = this.typedListeners.get(event);
    if (!set) {
      set = new Set();
      this.typedListeners.set(event, set);
    }
    set.add(listener as Listener<keyof InboundEventMap>);
  }

  off<E extends keyof InboundEventMap>(event: E, listener: Listener<E>): void {
    this.typedListeners.get(event)?.delete(listener as Listener<keyof InboundEventMap>);
  }

  private dispatch<E extends keyof InboundEventMap>(
    event: E,
    payload: InboundEventMap[E],
  ): void {
    const set = this.typedListeners.get(event);
    if (!set) return;
    for (const listener of set) {
      try {
        const result = (listener as Listener<E>)(payload);
        if (result instanceof Promise) {
          result.catch((err) => {
            this.log.error("Listener for %s threw: %s", event, (err as Error).message);
          });
        }
      } catch (err) {
        this.log.error("Listener for %s threw: %s", event, (err as Error).message);
      }
    }
  }
}
