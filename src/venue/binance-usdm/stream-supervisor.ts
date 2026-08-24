import type { BinanceUsdmListenKeySession } from "./listen-key-client.js";
import {
  BinancePrivateStreamLane,
  type BinancePrivateStreamLaneStatus,
} from "./private-stream-lane.js";
import {
  BinancePublicStreamLane,
  type BinancePublicStreamLaneStatus,
} from "./public-stream-lane.js";
import {
  InMemoryBinanceStreamEvidenceSink,
  type BinanceStreamEvidenceSink,
} from "./stream-evidence.js";
import {
  NativeBinanceWebSocketFactory,
  boundedBinanceInteger,
  defaultBinanceStreamScheduler,
  normalizeBinanceStreamsBaseUrl,
  normalizeBinanceSymbol,
  type BinanceStreamScheduler,
  type BinanceUsdmStreamRestClient,
  type BinanceWebSocketEventMap,
  type BinanceWebSocketFactory,
  type BinanceWebSocketLike,
} from "./stream-common.js";

export type {
  BinanceStreamLaneState,
  BinanceStreamScheduler,
  BinanceUsdmStreamRestClient,
  BinanceWebSocketEventMap,
  BinanceWebSocketFactory,
  BinanceWebSocketLike,
} from "./stream-common.js";

export interface BinanceUsdmStreamSupervisorOptions {
  symbol?: string;
  streamsBaseUrl?: string;
  includePrivate?: boolean;
  depthLimit?: number;
  keepaliveMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  maximumBufferedPrivateEvents?: number;
  socketFactory?: BinanceWebSocketFactory;
  scheduler?: BinanceStreamScheduler;
  evidence?: BinanceStreamEvidenceSink;
  now?: () => number;
}

export interface BinanceUsdmStreamSupervisorStatus {
  schema_version: "glitch.crypto.binance-usdm-stream-status.v1";
  desired_running: boolean;
  mutation_authority: false;
  symbol: string;
  public: BinancePublicStreamLaneStatus;
  private: BinancePrivateStreamLaneStatus & { enabled: boolean };
}

export class BinanceUsdmStreamSupervisor {
  private readonly symbol: string;
  private readonly includePrivateByDefault: boolean;
  private readonly evidence: BinanceStreamEvidenceSink;
  private readonly publicLane: BinancePublicStreamLane;
  private readonly privateLane: BinancePrivateStreamLane | null;
  private desiredRunning = false;
  private privateEnabled = false;

  constructor(
    rest: BinanceUsdmStreamRestClient,
    listenKeySession: BinanceUsdmListenKeySession | null,
    options: BinanceUsdmStreamSupervisorOptions = {},
  ) {
    this.symbol = normalizeBinanceSymbol(options.symbol ?? "BTCUSDT");
    this.includePrivateByDefault = options.includePrivate ?? false;
    const streamsBaseUrl = normalizeBinanceStreamsBaseUrl(
      options.streamsBaseUrl ?? "wss://fstream.binance.com",
    );
    const depthLimit = boundedBinanceInteger(
      options.depthLimit ?? 1_000,
      5,
      1_000,
      "depth limit",
    );
    const keepaliveMs = boundedBinanceInteger(
      options.keepaliveMs ?? 30 * 60 * 1_000,
      60_000,
      59 * 60 * 1_000,
      "listen-key keepalive interval",
    );
    const reconnectBaseMs = boundedBinanceInteger(
      options.reconnectBaseMs ?? 500,
      1,
      60_000,
      "reconnect base",
    );
    const reconnectMaxMs = boundedBinanceInteger(
      options.reconnectMaxMs ?? 30_000,
      reconnectBaseMs,
      5 * 60_000,
      "reconnect maximum",
    );
    const maximumBufferedPrivateEvents = boundedBinanceInteger(
      options.maximumBufferedPrivateEvents ?? 10_000,
      1,
      100_000,
      "maximum buffered private events",
    );
    const socketFactory =
      options.socketFactory ?? new NativeBinanceWebSocketFactory();
    const scheduler = options.scheduler ?? defaultBinanceStreamScheduler();
    this.evidence =
      options.evidence ?? new InMemoryBinanceStreamEvidenceSink();
    const now = options.now ?? Date.now;

    this.publicLane = new BinancePublicStreamLane(rest, {
      symbol: this.symbol,
      streamsBaseUrl,
      depthLimit,
      reconnectBaseMs,
      reconnectMaxMs,
      socketFactory,
      scheduler,
      evidence: this.evidence,
    });
    this.privateLane = listenKeySession
      ? new BinancePrivateStreamLane(rest, listenKeySession, {
          streamsBaseUrl,
          keepaliveMs,
          reconnectBaseMs,
          reconnectMaxMs,
          maximumBufferedEvents: maximumBufferedPrivateEvents,
          socketFactory,
          scheduler,
          evidence: this.evidence,
          now,
        })
      : null;
  }

  async start(
    includePrivate = this.includePrivateByDefault,
  ): Promise<BinanceUsdmStreamSupervisorStatus> {
    if (this.desiredRunning) {
      throw new Error("Binance stream supervisor is already running");
    }
    if (includePrivate && this.privateLane === null) {
      throw new Error(
        "private Binance stream supervision requires a listen-key session client",
      );
    }
    this.desiredRunning = true;
    this.privateEnabled = includePrivate;
    this.evidence.record("supervisor", "transition", {
      action: "start",
      symbol: this.symbol,
      private_enabled: includePrivate,
      mutation_authority: false,
    });
    this.publicLane.start();
    if (includePrivate && this.privateLane) {
      await this.privateLane.start();
    }
    return this.status();
  }

  async stop(): Promise<BinanceUsdmStreamSupervisorStatus> {
    this.desiredRunning = false;
    this.publicLane.stop();
    if (this.privateLane) {
      await this.privateLane.stop();
    }
    this.evidence.record("supervisor", "transition", {
      action: "stop",
      symbol: this.symbol,
    });
    return this.status();
  }

  status(): BinanceUsdmStreamSupervisorStatus {
    const publicStatus = this.publicLane.status();
    const privateStatus = this.privateLane?.status() ?? emptyPrivateStatus();
    return {
      schema_version: "glitch.crypto.binance-usdm-stream-status.v1",
      desired_running: this.desiredRunning,
      mutation_authority: false,
      symbol: this.symbol,
      public: publicStatus,
      private: {
        enabled: this.privateEnabled,
        ...privateStatus,
      },
    };
  }
}

function emptyPrivateStatus(): BinancePrivateStreamLaneStatus {
  return {
    state: "stopped",
    epoch: 0,
    reconnect_attempt: 0,
    buffered_events: 0,
    account: {
      schema_version: "glitch.crypto.binance-usdm-private-state.v1",
      stream_expired: false,
      last_event_time: null,
      last_transaction_time: null,
      balances: [],
      positions: [],
      orders: [],
      applied_event_count: 0,
    },
  };
}
