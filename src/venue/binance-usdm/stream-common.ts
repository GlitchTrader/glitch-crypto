import type {
  BinanceUsdmAccountSnapshot,
  BinanceUsdmPublicRawResponse,
} from "./shadow-client.js";

export type BinanceStreamLaneState =
  | "stopped"
  | "connecting"
  | "synchronizing"
  | "running"
  | "backoff";

export interface BinanceUsdmStreamRestClient {
  publicGet(
    path: string,
    parameters?: Readonly<
      Record<string, string | number | bigint | boolean | null | undefined>
    >,
  ): Promise<unknown>;
  publicGetRaw?(
    path: string,
    parameters?: Readonly<
      Record<string, string | number | bigint | boolean | null | undefined>
    >,
  ): Promise<BinanceUsdmPublicRawResponse>;
  accountSnapshot(): Promise<BinanceUsdmAccountSnapshot>;
}

export interface BinanceWebSocketEventMap {
  open: Record<string, never>;
  message: { data: unknown };
  error: { message?: string };
  close: { code?: number; reason?: string; wasClean?: boolean };
}

export interface BinanceWebSocketLike {
  readonly readyState: number;
  addEventListener<K extends keyof BinanceWebSocketEventMap>(
    type: K,
    listener: (event: BinanceWebSocketEventMap[K]) => void,
  ): void;
  close(code?: number, reason?: string): void;
}

export interface BinanceWebSocketFactory {
  create(url: string): BinanceWebSocketLike;
}

export interface BinanceStreamScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export const NORMAL_CLOSE = 1000;
export const SERVICE_RESTART_CLOSE = 1012;
const READY_STATE_OPEN = 1;

export class NativeBinanceWebSocketFactory implements BinanceWebSocketFactory {
  create(url: string): BinanceWebSocketLike {
    return new NativeBinanceWebSocket(url);
  }
}

class NativeBinanceWebSocket implements BinanceWebSocketLike {
  private readonly socket: WebSocket;

  constructor(url: string) {
    this.socket = new WebSocket(url);
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  addEventListener<K extends keyof BinanceWebSocketEventMap>(
    type: K,
    listener: (event: BinanceWebSocketEventMap[K]) => void,
  ): void {
    if (type === "message") {
      this.socket.addEventListener("message", (event) => {
        (listener as (value: BinanceWebSocketEventMap["message"]) => void)({
          data: event.data,
        });
      });
      return;
    }
    if (type === "close") {
      this.socket.addEventListener("close", (event) => {
        (listener as (value: BinanceWebSocketEventMap["close"]) => void)({
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        });
      });
      return;
    }
    if (type === "error") {
      this.socket.addEventListener("error", () => {
        (listener as (value: BinanceWebSocketEventMap["error"]) => void)({});
      });
      return;
    }
    this.socket.addEventListener("open", () => {
      (listener as (value: BinanceWebSocketEventMap["open"]) => void)({});
    });
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }
}

export function defaultBinanceStreamScheduler(): BinanceStreamScheduler {
  return {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
    setInterval: (callback, delayMs) => setInterval(callback, delayMs),
    clearInterval: (handle) =>
      clearInterval(handle as ReturnType<typeof setInterval>),
  };
}

export function closeBinanceSocket(
  socket: BinanceWebSocketLike | null,
  code: number,
  reason: string,
): void {
  if (socket === null) {
    return;
  }
  try {
    if (socket.readyState === READY_STATE_OPEN || socket.readyState === 0) {
      socket.close(code, reason);
    }
  } catch {
    // Reconciliation owns truth; close failure never authorizes mutation.
  }
}

export function binanceReconnectDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
): number {
  return Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 20));
}

export function boundedBinanceInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

export function normalizeBinanceSymbol(value: string): string {
  const symbol = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{5,24}$/.test(symbol)) {
    throw new Error(
      "Binance symbol must contain 5-24 uppercase alphanumeric characters",
    );
  }
  return symbol;
}

export function normalizeBinanceStreamsBaseUrl(value: string): string {
  const parsed = new URL(value);
  const loopback =
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "::1" ||
    parsed.hostname === "localhost";
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new Error(
      "Binance streams URL must be a bare origin without credentials, path, query, or fragment",
    );
  }
  if (parsed.protocol !== "wss:" && !(loopback && parsed.protocol === "ws:")) {
    throw new Error(
      "Binance streams URL must use WSS unless it is loopback test infrastructure",
    );
  }
  return parsed.origin;
}

export type BinanceMarketStreamRoute = "public" | "market";

const BINANCE_STREAM_NAME = /^[a-z0-9!][A-Za-z0-9!_.@-]{1,127}$/;
const BINANCE_PRIVATE_EVENTS = [
  "ORDER_TRADE_UPDATE",
  "ACCOUNT_UPDATE",
  "listenKeyExpired",
] as const;

export function binanceMarketStreamUrl(
  streamsBaseUrl: string,
  route: BinanceMarketStreamRoute,
  streams: readonly string[],
): string {
  if (streams.length === 0 || streams.length > 1_024) {
    throw new Error("Binance stream URL requires 1-1024 streams");
  }
  for (const stream of streams) {
    if (!BINANCE_STREAM_NAME.test(stream)) {
      throw new Error(`invalid Binance stream name: ${stream}`);
    }
  }
  return `${streamsBaseUrl}/${route}/ws/${streams.join("/")}`;
}

export function binancePrivateStreamUrl(
  streamsBaseUrl: string,
  listenKey: string,
): string {
  if (!listenKey.trim()) {
    throw new Error("Binance listen key is required");
  }
  const events = BINANCE_PRIVATE_EVENTS.map(encodeURIComponent).join("/");
  return `${streamsBaseUrl}/private/ws?listenKey=${encodeURIComponent(listenKey)}&events=${events}`;
}

export async function decodeBinanceMessageData(value: unknown): Promise<string> {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new TextDecoder().decode(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new TextDecoder().decode(value);
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return value.text();
  }
  throw new Error("unsupported WebSocket message data type");
}

export function unwrapBinanceStreamPayload(value: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("WebSocket message was not valid JSON");
  }
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed)
  ) {
    const object = parsed as Record<string, unknown>;
    if ("stream" in object && "data" in object) {
      return object.data;
    }
  }
  return parsed;
}
