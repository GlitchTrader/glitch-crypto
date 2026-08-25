import { randomUUID } from "node:crypto";
import { inspectBinanceMarketEvent } from "./market-events.js";
import type {
  BinanceRawMarketFrameInput,
  BinanceRawMarketProviderSequence,
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
  type BinanceWebSocketFactory,
  type BinanceWebSocketLike,
} from "./stream-common.js";

export interface BinanceMarketStreamRecorderOptions {
  symbol: string;
  streamsBaseUrl: string;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  socketFactory: BinanceWebSocketFactory;
  scheduler: BinanceStreamScheduler;
  evidence: BinanceStreamEvidenceSink;
  wallClock?: () => number;
  monotonicClock?: () => bigint;
  connectionIdFactory?: () => string;
}

export interface BinanceMarketStreamRecorderStatus {
  schema_version: "glitch.crypto.binance-usdm-market-recorder-status.v1";
  desired_running: boolean;
  mutation_authority: false;
  symbol: string;
  state: BinanceStreamLaneState;
  epoch: number;
  reconnect_attempt: number;
  aggregate_trade_messages: number;
  mark_price_messages: number;
  last_aggregate_trade_id: number | null;
  last_aggregate_trade_event_time: number | null;
  last_mark_price_event_time: number | null;
}

export class BinanceMarketStreamRecorder {
  private desiredRunning = false;
  private state: BinanceStreamLaneState = "stopped";
  private epoch = 0;
  private reconnectAttempt = 0;
  private socket: BinanceWebSocketLike | null = null;
  private restartTimer: unknown = null;
  private aggregateTradeMessages = 0;
  private markPriceMessages = 0;
  private lastAggregateTradeId: number | null = null;
  private lastAggregateTradeEventTime: number | null = null;
  private lastMarkPriceEventTime: number | null = null;

  constructor(private readonly options: BinanceMarketStreamRecorderOptions) {}

  start(): BinanceMarketStreamRecorderStatus {
    if (this.desiredRunning) {
      throw new Error("Binance market stream recorder is already running");
    }
    this.desiredRunning = true;
    this.connect();
    return this.status();
  }

  stop(): BinanceMarketStreamRecorderStatus {
    this.desiredRunning = false;
    this.epoch += 1;
    this.clearRestartTimer();
    closeBinanceSocket(this.socket, 1000, "operator stop");
    this.socket = null;
    this.state = "stopped";
    this.record("transition", { state: "stopped", epoch: this.epoch });
    return this.status();
  }

  status(): BinanceMarketStreamRecorderStatus {
    return {
      schema_version: "glitch.crypto.binance-usdm-market-recorder-status.v1",
      desired_running: this.desiredRunning,
      mutation_authority: false,
      symbol: this.options.symbol,
      state: this.state,
      epoch: this.epoch,
      reconnect_attempt: this.reconnectAttempt,
      aggregate_trade_messages: this.aggregateTradeMessages,
      mark_price_messages: this.markPriceMessages,
      last_aggregate_trade_id: this.lastAggregateTradeId,
      last_aggregate_trade_event_time: this.lastAggregateTradeEventTime,
      last_mark_price_event_time: this.lastMarkPriceEventTime,
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
    const symbol = this.options.symbol.toLowerCase();
    const streams = [`${symbol}@aggTrade`, `${symbol}@markPrice@1s`];
    const socket = this.options.socketFactory.create(
      binanceMarketStreamUrl(this.options.streamsBaseUrl, "market", streams),
    );
    this.socket = socket;
    this.record("transition", {
      state: "connecting",
      epoch,
      streams,
      connection_id: connectionId,
      mutation_authority: false,
    });
    socket.addEventListener("open", () => {
      if (epoch !== this.epoch || !this.desiredRunning) {
        return;
      }
      this.state = "running";
      this.record("transition", {
        state: "running",
        epoch,
        connection_id: connectionId,
      });
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
      const summary = inspectBinanceMarketEvent(payload, this.options.symbol);
      if (summary.event_type === "aggTrade") {
        if (
          this.lastAggregateTradeId !== null &&
          summary.aggregate_trade_id <= this.lastAggregateTradeId
        ) {
          throw new Error("aggregate trade IDs must increase");
        }
        if (
          this.lastAggregateTradeEventTime !== null &&
          summary.event_time < this.lastAggregateTradeEventTime
        ) {
          throw new Error("aggregate trade event time moved backwards");
        }
        this.aggregateTradeMessages += 1;
        this.lastAggregateTradeId = summary.aggregate_trade_id;
        this.lastAggregateTradeEventTime = summary.event_time;
      } else {
        if (
          this.lastMarkPriceEventTime !== null &&
          summary.event_time <= this.lastMarkPriceEventTime
        ) {
          throw new Error("mark-price event times must increase");
        }
        this.markPriceMessages += 1;
        this.lastMarkPriceEventTime = summary.event_time;
      }
      this.reconnectAttempt = 0;
    } catch (error) {
      if (epoch !== this.epoch) {
        return;
      }
      this.recordError("invalid_market_message", error);
      this.scheduleRestart("invalid_market_message");
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
      "market stream resynchronization",
    );
    this.socket = null;
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
    kind: "message" | "transition" | "error",
    payload: unknown,
  ): void {
    this.options.evidence.record("public-market", kind, payload);
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
    const providerSequence = describeProviderSequence(payload);
    const provenance: BinanceRawMarketFrameInput = {
      venue: "BINANCE_USDM",
      instrument: this.options.symbol,
      channel: "public-market",
      connection_id: connectionId,
      local_receive_timestamp_ms: localReceiveTimestampMs,
      monotonic_receive_ns: monotonicReceiveNs,
      exchange_timestamp_ms: positiveInteger(providerSequence.event_time_ms),
      provider_sequence: providerSequence,
      normalization_version: "binance-usdm-market-inspection.v1",
      raw_frame: rawFrame,
    };
    this.options.evidence.record(
      "public-market",
      "message",
      payload,
      provenance,
    );
  }
}

function describeProviderSequence(
  payload: unknown,
): BinanceRawMarketProviderSequence {
  const record =
    payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
  const eventType = typeof record.e === "string" ? record.e : null;
  const aggregateTrade = eventType === "aggTrade";
  return {
    event_type: eventType,
    event_time_ms: safeInteger(record.E),
    aggregate_trade_id: aggregateTrade ? safeInteger(record.a) : null,
    first_trade_id: aggregateTrade ? safeInteger(record.f) : null,
    last_trade_id: aggregateTrade ? safeInteger(record.l) : null,
    trade_time_ms: aggregateTrade ? safeInteger(record.T) : null,
    first_update_id: null,
    final_update_id: null,
    previous_final_update_id: null,
    transaction_time_ms: null,
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
