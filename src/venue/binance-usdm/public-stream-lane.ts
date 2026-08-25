import { randomUUID } from "node:crypto";
import {
  BinanceUsdmOrderBook,
  parseBinanceDepthDelta,
  parseBinanceDepthSnapshot,
  type BinanceOrderBookView,
} from "./order-book.js";
import type {
  BinanceRawDepthFrameInput,
  BinanceRawDepthSnapshotInput,
  BinanceRawProviderSequence,
  BinanceStreamEvidenceSink,
} from "./stream-evidence.js";
import {
  SERVICE_RESTART_CLOSE,
  binanceMarketStreamUrl,
  binanceReconnectDelay,
  closeBinanceSocket,
  decodeBinanceMessageData,
  unwrapBinanceStreamPayload,
  type BinanceStreamLaneState,
  type BinanceStreamScheduler,
  type BinanceUsdmStreamRestClient,
  type BinanceWebSocketFactory,
  type BinanceWebSocketLike,
} from "./stream-common.js";

export interface BinancePublicStreamLaneOptions {
  symbol: string;
  streamsBaseUrl: string;
  depthLimit: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  socketFactory: BinanceWebSocketFactory;
  scheduler: BinanceStreamScheduler;
  evidence: BinanceStreamEvidenceSink;
  wallClock?: () => number;
  monotonicClock?: () => bigint;
  connectionIdFactory?: () => string;
}

export interface BinancePublicStreamLaneStatus {
  state: BinanceStreamLaneState;
  epoch: number;
  reconnect_attempt: number;
  order_book: BinanceOrderBookView;
}

export class BinancePublicStreamLane {
  private readonly orderBook = new BinanceUsdmOrderBook();
  private desiredRunning = false;
  private state: BinanceStreamLaneState = "stopped";
  private epoch = 0;
  private reconnectAttempt = 0;
  private socket: BinanceWebSocketLike | null = null;
  private restartTimer: unknown = null;

  constructor(
    private readonly rest: BinanceUsdmStreamRestClient,
    private readonly options: BinancePublicStreamLaneOptions,
  ) {}

  start(): void {
    if (this.desiredRunning) {
      throw new Error("Binance public stream lane is already running");
    }
    this.desiredRunning = true;
    this.connect();
  }

  stop(): void {
    this.desiredRunning = false;
    this.epoch += 1;
    this.clearRestartTimer();
    closeBinanceSocket(this.socket, 1000, "operator stop");
    this.socket = null;
    this.state = "stopped";
    this.orderBook.reset();
    this.record("transition", { state: "stopped", epoch: this.epoch });
  }

  status(): BinancePublicStreamLaneStatus {
    return {
      state: this.state,
      epoch: this.epoch,
      reconnect_attempt: this.reconnectAttempt,
      order_book: this.orderBook.view(),
    };
  }

  private connect(): void {
    if (!this.desiredRunning) {
      return;
    }
    this.clearRestartTimer();
    const epoch = ++this.epoch;
    const connectionId =
      this.options.connectionIdFactory?.() ?? randomUUID();
    this.state = "connecting";
    this.orderBook.reset();
    const streamName = `${this.options.symbol.toLowerCase()}@depth@100ms`;
    const socket = this.options.socketFactory.create(
      binanceMarketStreamUrl(
        this.options.streamsBaseUrl,
        "public",
        [streamName],
      ),
    );
    this.socket = socket;
    this.record("transition", {
      state: "connecting",
      epoch,
      stream: streamName,
      connection_id: connectionId,
    });
    socket.addEventListener("open", () => {
      void this.onOpen(epoch, connectionId);
    });
    socket.addEventListener("message", (event) => {
      void this.onMessage(epoch, connectionId, event.data);
    });
    socket.addEventListener("error", (event) => {
      if (epoch !== this.epoch) {
        return;
      }
      this.record("error", {
        type: "websocket_error",
        message: event.message ?? null,
        epoch,
      });
      this.scheduleRestart("websocket_error");
    });
    socket.addEventListener("close", (event) => {
      if (epoch !== this.epoch || !this.desiredRunning) {
        return;
      }
      this.record("transition", {
        state: "closed",
        code: event.code ?? null,
        reason: event.reason ?? null,
        was_clean: event.wasClean ?? null,
        epoch,
      });
      this.scheduleRestart("websocket_closed");
    });
  }

  private async onOpen(epoch: number, connectionId: string): Promise<void> {
    if (epoch !== this.epoch || !this.desiredRunning) {
      return;
    }
    this.state = "synchronizing";
    this.record("transition", {
      state: "synchronizing",
      epoch,
      connection_id: connectionId,
    });
    try {
      const parameters = {
        symbol: this.options.symbol,
        limit: this.options.depthLimit,
      };
      let snapshotValue: unknown;
      if (this.rest.publicGetRaw) {
        const raw = await this.rest.publicGetRaw(
          "/fapi/v1/depth",
          parameters,
        );
        if (epoch !== this.epoch || !this.desiredRunning) {
          return;
        }
        this.recordRawSnapshot(raw);
        snapshotValue = parseRawSnapshotResponse(raw.raw_response);
      } else {
        snapshotValue = await this.rest.publicGet(
          "/fapi/v1/depth",
          parameters,
        );
      }
      if (epoch !== this.epoch || !this.desiredRunning) {
        return;
      }
      const snapshot = parseBinanceDepthSnapshot(snapshotValue);
      this.record("snapshot", snapshot);
      const view = this.orderBook.loadSnapshot(snapshot);
      if (view.status === "gapped") {
        this.scheduleRestart(view.gap_reason ?? "snapshot_delta_gap");
        return;
      }
      this.reconnectAttempt = 0;
      this.state = "running";
      this.record("transition", {
        state: "running",
        epoch,
        connection_id: connectionId,
        update_id: view.update_id,
      });
    } catch (error) {
      if (epoch !== this.epoch) {
        return;
      }
      this.recordError("snapshot_sync_failed", error);
      this.scheduleRestart("snapshot_sync_failed");
    }
  }

  private async onMessage(
    epoch: number,
    connectionId: string,
    data: unknown,
  ): Promise<void> {
    if (epoch !== this.epoch || !this.desiredRunning) {
      return;
    }
    const localReceiveTimestampMs =
      this.options.wallClock?.() ?? Date.now();
    const monotonicReceiveNs = (
      this.options.monotonicClock?.() ??
        BigInt(Math.max(1, Math.trunc(performance.now() * 1_000_000)))
    ).toString();
    try {
      const rawFrame = await decodeBinanceMessageData(data);
      let payload: unknown;
      try {
        payload = unwrapBinanceStreamPayload(rawFrame);
      } catch (error) {
        this.recordRawMessage(
          connectionId,
          localReceiveTimestampMs,
          monotonicReceiveNs,
          rawFrame,
          null,
        );
        throw error;
      }
      this.recordRawMessage(
        connectionId,
        localReceiveTimestampMs,
        monotonicReceiveNs,
        rawFrame,
        payload,
      );
      const delta = parseBinanceDepthDelta(payload);
      assertDepthStreamIdentity(payload, delta.s, this.options.symbol);
      const result = this.orderBook.ingest(delta);
      if (result === "gapped") {
        this.scheduleRestart(
          this.orderBook.view().gap_reason ?? "depth_gap",
        );
      }
    } catch (error) {
      if (epoch !== this.epoch) {
        return;
      }
      this.recordError("invalid_depth_message", error);
      this.scheduleRestart("invalid_depth_message");
    }
  }

  private scheduleRestart(reason: string): void {
    if (!this.desiredRunning || this.state === "backoff") {
      return;
    }
    const restartEpoch = ++this.epoch;
    closeBinanceSocket(
      this.socket,
      SERVICE_RESTART_CLOSE,
      "public resynchronization",
    );
    this.socket = null;
    this.orderBook.reset();
    this.state = "backoff";
    const delayMs = binanceReconnectDelay(
      this.reconnectAttempt++,
      this.options.reconnectBaseMs,
      this.options.reconnectMaxMs,
    );
    this.record("transition", {
      state: "backoff",
      reason,
      delay_ms: delayMs,
      epoch: restartEpoch,
    });
    this.clearRestartTimer();
    this.restartTimer = this.options.scheduler.setTimeout(() => {
      this.restartTimer = null;
      if (this.desiredRunning && this.epoch === restartEpoch) {
        this.connect();
      }
    }, delayMs);
  }

  private clearRestartTimer(): void {
    if (this.restartTimer !== null) {
      this.options.scheduler.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private record(
    kind: "message" | "snapshot" | "transition" | "error",
    payload: unknown,
  ): void {
    this.options.evidence.record("public-depth", kind, payload);
  }

  private recordError(type: string, error: unknown): void {
    this.record("error", {
      type,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  private recordRawMessage(
    connectionId: string,
    localReceiveTimestampMs: number,
    monotonicReceiveNs: string,
    rawFrame: string,
    payload: unknown,
  ): void {
    const providerSequence = describeDepthProviderSequence(payload);
    const provenance: BinanceRawDepthFrameInput = {
      venue: "BINANCE_USDM",
      instrument: this.options.symbol,
      channel: "public-depth",
      connection_id: connectionId,
      local_receive_timestamp_ms: localReceiveTimestampMs,
      monotonic_receive_ns: monotonicReceiveNs,
      exchange_timestamp_ms: positiveInteger(providerSequence.event_time_ms),
      provider_sequence: providerSequence,
      normalization_version: "binance-usdm-depth-inspection.v1",
      raw_frame: rawFrame,
    };
    this.options.evidence.record(
      "public-depth",
      "message",
      payload,
      provenance,
    );
  }

  private recordRawSnapshot(
    raw: {
      method: "GET";
      origin: string;
      path: string;
      query: string;
      http_status: number;
      local_receive_timestamp_ms: number;
      monotonic_receive_ns: string;
      raw_response: string;
    },
  ): void {
    const provenance: BinanceRawDepthSnapshotInput = {
      venue: "BINANCE_USDM",
      instrument: this.options.symbol,
      channel: "public-depth",
      transport: "REST",
      method: raw.method,
      origin: raw.origin,
      path: "/fapi/v1/depth",
      query: raw.query,
      http_status: raw.http_status,
      local_receive_timestamp_ms: raw.local_receive_timestamp_ms,
      monotonic_receive_ns: raw.monotonic_receive_ns,
      normalization_version:
        "binance-usdm-depth-snapshot-inspection.v1",
      raw_response: raw.raw_response,
    };
    if (raw.path !== provenance.path) {
      throw new Error("raw Binance depth snapshot path is not attributable");
    }
    this.options.evidence.record(
      "public-depth",
      "raw_snapshot",
      null,
      provenance,
    );
  }
}

function parseRawSnapshotResponse(rawResponse: string): unknown {
  try {
    return JSON.parse(rawResponse) as unknown;
  } catch {
    throw new Error("Binance depth snapshot response was not valid JSON");
  }
}

function describeDepthProviderSequence(
  payload: unknown,
): BinanceRawProviderSequence {
  const record =
    payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
  return {
    event_type: typeof record.e === "string" ? record.e : null,
    event_time_ms: safeInteger(record.E),
    aggregate_trade_id: null,
    first_trade_id: null,
    last_trade_id: null,
    trade_time_ms: null,
    first_update_id: safeInteger(record.U),
    final_update_id: safeInteger(record.u),
    previous_final_update_id: safeInteger(record.pu),
    transaction_time_ms: safeInteger(record.T),
  };
}

function safeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : null;
}

function positiveInteger(value: number | null): number | null {
  return value !== null && value > 0 ? value : null;
}

function assertDepthStreamIdentity(
  payload: unknown,
  observedSymbol: string | undefined,
  expectedSymbol: string,
): void {
  const record =
    payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
  if (record.e !== "depthUpdate") {
    throw new Error("Binance public depth event type must be depthUpdate");
  }
  if (observedSymbol !== expectedSymbol) {
    throw new Error(
      `Binance public depth symbol ${observedSymbol ?? "missing"} does not match ${expectedSymbol}`,
    );
  }
}
