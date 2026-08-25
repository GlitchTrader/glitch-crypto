import { randomUUID } from "node:crypto";
import type { TradingEngine } from "../core/trading-engine.js";
import {
  CryptoOpportunityEngine,
  type CryptoOpportunitySnapshot,
  type OpportunityEngineConfig,
} from "./opportunity-engine.js";
import { BinanceUsdmListenKeyClient } from "../venue/binance-usdm/listen-key-client.js";
import { inspectBinanceMarketEvent } from "../venue/binance-usdm/market-events.js";
import { BinanceMarketStreamRecorder } from "../venue/binance-usdm/market-stream-recorder.js";
import {
  BinanceUsdmOrderBook,
  parseBinanceDepthDelta,
  parseBinanceDepthSnapshot,
} from "../venue/binance-usdm/order-book.js";
import { BinanceUsdmShadowClient } from "../venue/binance-usdm/shadow-client.js";
import {
  NativeBinanceWebSocketFactory,
  defaultBinanceStreamScheduler,
} from "../venue/binance-usdm/stream-common.js";
import {
  JsonlBinanceStreamEvidenceSink,
  type BinanceStreamEvidenceRecord,
  type BinanceStreamEvidenceSink,
} from "../venue/binance-usdm/stream-evidence.js";
import { BinanceUsdmStreamSupervisor } from "../venue/binance-usdm/stream-supervisor.js";

export interface BinanceShadowRuntimeConfig {
  baseUrl: string;
  streamsUrl: string;
  symbol: string;
  apiKey: string;
  apiSecret: string;
  includePrivate: boolean;
  recvWindowMs: number;
  timeoutMs: number;
  evidencePath: string;
  evidenceMaxBytes: number;
  evaluationIntervalMs: number;
  candidateCooldownMs: number;
  positionReviewMs: number;
  eventLifetimeMs: number;
  opportunity: OpportunityEngineConfig;
}

export interface ShadowDecisionEvent {
  schema_version: "glitch.crypto.shadow-decision-event.v1";
  event_id: string;
  event_type: "CANDIDATE" | "POSITION";
  instrument: "BTCUSDT-PERP";
  created_utc: string;
  expires_utc: string;
  source_observation_id: string;
  suggested_action: CryptoOpportunitySnapshot["action"];
  reason: string;
  position_tranche_ids: string[];
}

export interface BinanceShadowRuntimeStatus {
  schema_version: "glitch.crypto.binance-shadow-runtime.v1";
  mode: "binance-shadow";
  running: boolean;
  mutation_authority: false;
  started_utc: string | null;
  last_error: string | null;
  evidence_path: string;
  streams: {
    depth: string;
    market: string;
    private: {
      enabled: boolean;
      state: string;
      positions: number;
      orders: number;
      last_event_time: number | null;
    };
  };
  latest_event_id: string | null;
}

export interface BinanceShadowRuntimeSnapshot {
  status: BinanceShadowRuntimeStatus;
  market_observation: CryptoOpportunitySnapshot;
  decision_event: ShadowDecisionEvent | null;
}

export interface ShadowRuntimeProvider {
  snapshot(): BinanceShadowRuntimeSnapshot;
  acknowledgeDecision(eventId: string): void;
}

export class BinanceShadowRuntime implements ShadowRuntimeProvider {
  private readonly opportunity: CryptoOpportunityEngine;
  private readonly replayBook = new BinanceUsdmOrderBook();
  private readonly depthSupervisor: BinanceUsdmStreamSupervisor;
  private readonly marketRecorder: BinanceMarketStreamRecorder;
  private running = false;
  private startedUtc: string | null = null;
  private lastError: string | null = null;
  private latestObservation: CryptoOpportunitySnapshot;
  private latestDecisionEvent: ShadowDecisionEvent | null = null;
  private lastEvaluationMs = 0;
  private lastCandidateEventMs = 0;
  private lastPositionEventMs = 0;

  constructor(
    private readonly engine: TradingEngine,
    private readonly config: BinanceShadowRuntimeConfig,
  ) {
    this.opportunity = new CryptoOpportunityEngine(config.opportunity);
    this.latestObservation = this.opportunity.snapshot();
    const delegate = new JsonlBinanceStreamEvidenceSink(config.evidencePath, {
      forbiddenValues: [config.apiKey, config.apiSecret],
      maxBytes: config.evidenceMaxBytes,
    });
    const evidence = new ObservedEvidenceSink(delegate, (record) => {
      this.observeEvidence(record);
    });
    const client = new BinanceUsdmShadowClient({
      baseUrl: config.baseUrl,
      symbol: config.symbol,
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
      recvWindow: config.recvWindowMs,
      timeoutMs: config.timeoutMs,
    });
    const listenKey = config.includePrivate
      ? new BinanceUsdmListenKeyClient({
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          timeoutMs: config.timeoutMs,
        })
      : null;
    this.depthSupervisor = new BinanceUsdmStreamSupervisor(client, listenKey, {
      symbol: config.symbol,
      streamsBaseUrl: config.streamsUrl,
      evidence,
    });
    this.marketRecorder = new BinanceMarketStreamRecorder({
      symbol: config.symbol,
      streamsBaseUrl: config.streamsUrl,
      reconnectBaseMs: 500,
      reconnectMaxMs: 30_000,
      socketFactory: new NativeBinanceWebSocketFactory(),
      scheduler: defaultBinanceStreamScheduler(),
      evidence,
    });
  }

  async start(): Promise<BinanceShadowRuntimeSnapshot> {
    if (this.running) {
      return this.snapshot();
    }
    this.running = true;
    this.startedUtc = new Date().toISOString();
    this.lastError = null;
    try {
      await this.depthSupervisor.start(this.config.includePrivate);
      this.marketRecorder.start();
      return this.snapshot();
    } catch (error) {
      this.running = false;
      this.lastError = errorMessage(error);
      this.marketRecorder.stop();
      await this.depthSupervisor.stop();
      throw error;
    }
  }

  async stop(): Promise<BinanceShadowRuntimeSnapshot> {
    if (!this.running) {
      return this.snapshot();
    }
    this.running = false;
    this.latestDecisionEvent = null;
    this.marketRecorder.stop();
    await this.depthSupervisor.stop();
    return this.snapshot();
  }

  acknowledgeDecision(eventId: string): void {
    const current = this.latestDecisionEvent;
    if (!current || current.event_id !== eventId) {
      return;
    }
    const now = Date.now();
    if (current.event_type === "CANDIDATE") {
      this.lastCandidateEventMs = now;
    } else {
      this.lastPositionEventMs = now;
    }
    this.latestDecisionEvent = null;
  }

  snapshot(): BinanceShadowRuntimeSnapshot {
    const depth = this.depthSupervisor.status();
    const market = this.marketRecorder.status();
    return {
      status: {
        schema_version: "glitch.crypto.binance-shadow-runtime.v1",
        mode: "binance-shadow",
        running: this.running,
        mutation_authority: false,
        started_utc: this.startedUtc,
        last_error: this.lastError,
        evidence_path: this.config.evidencePath,
        streams: {
          depth: depth.public.state,
          market: market.state,
          private: {
            enabled: depth.private.enabled,
            state: depth.private.state,
            positions: depth.private.account.positions.length,
            orders: depth.private.account.orders.length,
            last_event_time: depth.private.account.last_event_time,
          },
        },
        latest_event_id: this.latestDecisionEvent?.event_id ?? null,
      },
      market_observation: this.latestObservation,
      decision_event: this.latestDecisionEvent
        ? {
            ...this.latestDecisionEvent,
            position_tranche_ids: [...this.latestDecisionEvent.position_tranche_ids],
          }
        : null,
    };
  }

  private observeEvidence(record: BinanceStreamEvidenceRecord): void {
    try {
      if (record.channel === "public-depth") {
        this.observeDepth(record);
      } else if (record.channel === "public-market" && record.kind === "message") {
        const event = inspectBinanceMarketEvent(record.payload, this.config.symbol);
        this.opportunity.updateMarket(event);
        if (event.event_type === "markPriceUpdate") {
          const mark = Number(event.mark_price);
          if (Number.isFinite(mark) && mark > 0) {
            this.engine.updatePaperMark(mark);
          }
        }
        this.evaluate(recordedMilliseconds(record));
      }
    } catch (error) {
      this.lastError = errorMessage(error);
    }
  }

  private observeDepth(record: BinanceStreamEvidenceRecord): void {
    if (record.kind === "transition") {
      const transition = objectValue(record.payload);
      if (
        transition.state === "connecting" ||
        transition.state === "backoff" ||
        transition.state === "stopped"
      ) {
        this.replayBook.reset();
        this.opportunity.updateBook(this.replayBook.view());
      }
      return;
    }
    if (record.kind === "snapshot") {
      this.opportunity.updateBook(
        this.replayBook.loadSnapshot(parseBinanceDepthSnapshot(record.payload)),
      );
      this.evaluate(recordedMilliseconds(record));
      return;
    }
    if (record.kind === "message") {
      this.replayBook.ingest(parseBinanceDepthDelta(record.payload));
      this.opportunity.updateBook(this.replayBook.view());
      this.evaluate(recordedMilliseconds(record));
    }
  }

  private evaluate(nowMs: number): void {
    if (!this.running || nowMs - this.lastEvaluationMs < this.config.evaluationIntervalMs) {
      return;
    }
    this.lastEvaluationMs = nowMs;
    this.latestObservation = this.opportunity.snapshot(nowMs);
    const positions = this.engine.database.getPositions();
    const current = this.latestDecisionEvent;

    if (positions.length > 0) {
      const trancheIds = positions.map((position) => position.trancheId);
      if (
        current?.event_type === "POSITION" &&
        eventIsFresh(current, nowMs) &&
        sameStrings(current.position_tranche_ids, trancheIds)
      ) {
        return;
      }
      if (nowMs - this.lastPositionEventMs < this.config.positionReviewMs) {
        return;
      }
      this.lastPositionEventMs = nowMs;
      this.latestDecisionEvent = this.createDecisionEvent(
        "POSITION",
        nowMs,
        `Review ${positions.length} protected paper position against live Binance evidence.`,
        trancheIds,
      );
      return;
    }

    if (current?.event_type === "POSITION") {
      this.latestDecisionEvent = null;
    }
    if (!this.latestObservation.actionable) {
      if (this.latestDecisionEvent?.event_type === "CANDIDATE") {
        this.latestDecisionEvent = null;
      }
      return;
    }

    const candidate = this.latestDecisionEvent;
    if (
      candidate?.event_type === "CANDIDATE" &&
      eventIsFresh(candidate, nowMs) &&
      candidate.suggested_action === this.latestObservation.action
    ) {
      return;
    }
    const directionChanged =
      candidate?.event_type === "CANDIDATE" &&
      candidate.suggested_action !== this.latestObservation.action;
    if (!directionChanged && nowMs - this.lastCandidateEventMs < this.config.candidateCooldownMs) {
      return;
    }
    this.lastCandidateEventMs = nowMs;
    this.latestDecisionEvent = this.createDecisionEvent(
      "CANDIDATE",
      nowMs,
      this.latestObservation.reason,
      [],
    );
  }

  private createDecisionEvent(
    eventType: ShadowDecisionEvent["event_type"],
    nowMs: number,
    reason: string,
    positionTrancheIds: string[],
  ): ShadowDecisionEvent {
    return {
      schema_version: "glitch.crypto.shadow-decision-event.v1",
      event_id: randomUUID(),
      event_type: eventType,
      instrument: "BTCUSDT-PERP",
      created_utc: new Date(nowMs).toISOString(),
      expires_utc: new Date(nowMs + this.config.eventLifetimeMs).toISOString(),
      source_observation_id: this.latestObservation.observation_id,
      suggested_action: this.latestObservation.action,
      reason,
      position_tranche_ids: [...positionTrancheIds],
    };
  }
}

class ObservedEvidenceSink implements BinanceStreamEvidenceSink {
  constructor(
    private readonly delegate: BinanceStreamEvidenceSink,
    private readonly observer: (record: BinanceStreamEvidenceRecord) => void,
  ) {}

  record(
    channel: Parameters<BinanceStreamEvidenceSink["record"]>[0],
    kind: Parameters<BinanceStreamEvidenceSink["record"]>[1],
    payload: unknown,
    rawEvidence?: Parameters<BinanceStreamEvidenceSink["record"]>[3],
  ): BinanceStreamEvidenceRecord {
    const record = this.delegate.record(channel, kind, payload, rawEvidence);
    this.observer(record);
    return record;
  }
}

function eventIsFresh(event: ShadowDecisionEvent, nowMs: number): boolean {
  const expires = Date.parse(event.expires_utc);
  return Number.isFinite(expires) && expires > nowMs;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function recordedMilliseconds(record: BinanceStreamEvidenceRecord): number {
  const value = Date.parse(record.recorded_utc);
  return Number.isFinite(value) ? value : Date.now();
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
