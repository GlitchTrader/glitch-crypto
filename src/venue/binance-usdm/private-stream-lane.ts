import type { BinanceUsdmListenKeySession } from "./listen-key-client.js";
import {
  BinanceUsdmPrivateState,
  type BinancePrivateStateView,
} from "./private-state.js";
import { redactProviderEvidence } from "./redaction.js";
import type { BinanceStreamEvidenceSink } from "./stream-evidence.js";
import {
  SERVICE_RESTART_CLOSE,
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

export interface BinancePrivateStreamLaneOptions {
  streamsBaseUrl: string;
  keepaliveMs: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  maximumBufferedEvents: number;
  socketFactory: BinanceWebSocketFactory;
  scheduler: BinanceStreamScheduler;
  evidence: BinanceStreamEvidenceSink;
  now: () => number;
}

export interface BinancePrivateStreamLaneStatus {
  state: BinanceStreamLaneState;
  epoch: number;
  reconnect_attempt: number;
  buffered_events: number;
  account: BinancePrivateStateView;
}

export class BinancePrivateStreamLane {
  private readonly privateState = new BinanceUsdmPrivateState();
  private desiredRunning = false;
  private state: BinanceStreamLaneState = "stopped";
  private epoch = 0;
  private reconnectAttempt = 0;
  private socket: BinanceWebSocketLike | null = null;
  private listenKey: string | null = null;
  private buffer: unknown[] = [];
  private restartTimer: unknown = null;
  private keepaliveTimer: unknown = null;
  private restartPending = false;

  constructor(
    private readonly rest: BinanceUsdmStreamRestClient,
    private readonly session: BinanceUsdmListenKeySession,
    private readonly options: BinancePrivateStreamLaneOptions,
  ) {}

  async start(): Promise<void> {
    if (this.desiredRunning) {
      throw new Error("Binance private stream lane is already running");
    }
    this.desiredRunning = true;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.desiredRunning = false;
    this.epoch += 1;
    this.clearRestartTimer();
    this.clearKeepaliveTimer();
    closeBinanceSocket(this.socket, 1000, "operator stop");
    this.socket = null;
    const hadSession = this.listenKey !== null;
    this.listenKey = null;
    this.buffer = [];
    this.state = "stopped";
    if (hadSession) {
      try {
        await this.session.close();
      } catch (error) {
        this.recordError("listen_key_close_failed", error);
      }
    }
    this.record("transition", { state: "stopped", epoch: this.epoch });
  }

  status(): BinancePrivateStreamLaneStatus {
    return {
      state: this.state,
      epoch: this.epoch,
      reconnect_attempt: this.reconnectAttempt,
      buffered_events: this.buffer.length,
      account: this.privateState.view(),
    };
  }

  private async connect(): Promise<void> {
    if (!this.desiredRunning) {
      return;
    }
    this.clearRestartTimer();
    const epoch = ++this.epoch;
    this.state = "connecting";
    this.buffer = [];
    this.record("transition", { state: "creating_listen_key", epoch });
    try {
      const listenKey = await this.session.create();
      if (epoch !== this.epoch || !this.desiredRunning) {
        try {
          await this.session.close();
        } catch (error) {
          this.recordError("stale_listen_key_close_failed", error);
        }
        return;
      }
      this.listenKey = listenKey;
      const socket = this.options.socketFactory.create(
        `${this.options.streamsBaseUrl}/ws/${encodeURIComponent(listenKey)}`,
      );
      this.socket = socket;
      this.record("transition", {
        state: "connecting",
        epoch,
        listen_key_configured: true,
      });
      socket.addEventListener("open", () => {
        void this.onOpen(epoch);
      });
      socket.addEventListener("message", (event) => {
        void this.onMessage(epoch, event.data);
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
    } catch (error) {
      if (epoch !== this.epoch) {
        return;
      }
      this.recordError("listen_key_create_failed", error);
      this.scheduleRestart("listen_key_create_failed");
    }
  }

  private async onOpen(epoch: number): Promise<void> {
    if (epoch !== this.epoch || !this.desiredRunning) {
      return;
    }
    this.state = "synchronizing";
    this.record("transition", { state: "synchronizing", epoch });
    try {
      const snapshot = await this.rest.accountSnapshot();
      if (epoch !== this.epoch || !this.desiredRunning) {
        return;
      }
      const reconciliation = {
        balances: snapshot.balances,
        positions: snapshot.positions,
        openOrders: snapshot.open_orders,
        observedAt: this.options.now(),
      };
      this.record("reconciliation", reconciliation);
      this.privateState.reconcile(reconciliation);
      while (this.buffer.length > 0) {
        const buffered = this.buffer.splice(0, this.buffer.length);
        for (const event of buffered) {
          this.privateState.apply(event);
        }
      }
      if (this.privateState.view().stream_expired) {
        this.scheduleRestart("listen_key_expired_during_sync");
        return;
      }
      this.reconnectAttempt = 0;
      this.state = "running";
      this.record("transition", { state: "running", epoch });
      this.scheduleKeepalive(epoch);
    } catch (error) {
      if (epoch !== this.epoch) {
        return;
      }
      this.recordError("private_reconciliation_failed", error);
      this.scheduleRestart("private_reconciliation_failed");
    }
  }

  private async onMessage(epoch: number, data: unknown): Promise<void> {
    if (epoch !== this.epoch || !this.desiredRunning) {
      return;
    }
    try {
      const payload = unwrapBinanceStreamPayload(
        await decodeBinanceMessageData(data),
      );
      this.record("message", payload);
      if (this.state !== "running") {
        this.buffer.push(payload);
        if (this.buffer.length > this.options.maximumBufferedEvents) {
          this.scheduleRestart("private_buffer_overflow");
        }
        return;
      }
      this.privateState.apply(payload);
      if (this.privateState.view().stream_expired) {
        this.scheduleRestart("listen_key_expired");
      }
    } catch (error) {
      if (epoch !== this.epoch) {
        return;
      }
      this.recordError("invalid_private_message", error);
      this.scheduleRestart("invalid_private_message");
    }
  }

  private scheduleKeepalive(epoch: number): void {
    this.clearKeepaliveTimer();
    this.keepaliveTimer = this.options.scheduler.setInterval(() => {
      void this.keepAlive(epoch);
    }, this.options.keepaliveMs);
  }

  private async keepAlive(epoch: number): Promise<void> {
    if (
      epoch !== this.epoch ||
      !this.desiredRunning ||
      this.state !== "running"
    ) {
      return;
    }
    try {
      await this.session.keepAlive();
      if (epoch === this.epoch) {
        this.record("keepalive", { status: "ok", epoch });
      }
    } catch (error) {
      if (epoch !== this.epoch) {
        return;
      }
      this.recordError("listen_key_keepalive_failed", error);
      this.scheduleRestart("listen_key_keepalive_failed");
    }
  }

  private scheduleRestart(reason: string): void {
    if (!this.desiredRunning || this.restartPending) {
      return;
    }
    this.restartPending = true;
    const restartEpoch = ++this.epoch;
    this.clearKeepaliveTimer();
    closeBinanceSocket(
      this.socket,
      SERVICE_RESTART_CLOSE,
      "private resynchronization",
    );
    this.socket = null;
    const hadListenKey = this.listenKey !== null;
    this.listenKey = null;
    this.buffer = [];
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

    const cleanup = hadListenKey
      ? this.session.close().catch((error) => {
          this.recordError("listen_key_close_failed", error);
        })
      : Promise.resolve();
    void cleanup.finally(() => {
      if (!this.desiredRunning || this.epoch !== restartEpoch) {
        this.restartPending = false;
        return;
      }
      this.restartTimer = this.options.scheduler.setTimeout(() => {
        this.restartTimer = null;
        this.restartPending = false;
        if (this.desiredRunning && this.epoch === restartEpoch) {
          void this.connect();
        }
      }, delayMs);
    });
  }

  private clearRestartTimer(): void {
    if (this.restartTimer !== null) {
      this.options.scheduler.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private clearKeepaliveTimer(): void {
    if (this.keepaliveTimer !== null) {
      this.options.scheduler.clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  private record(
    kind:
      | "message"
      | "reconciliation"
      | "transition"
      | "keepalive"
      | "error",
    payload: unknown,
  ): void {
    this.options.evidence.record(
      "private-user",
      kind,
      redactProviderEvidence(payload, this.listenKey ? [this.listenKey] : []),
    );
  }

  private recordError(type: string, error: unknown): void {
    this.record("error", {
      type,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
