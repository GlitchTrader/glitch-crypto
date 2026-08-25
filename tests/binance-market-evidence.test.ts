import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { inspectBinanceMarketEvent } from "../src/venue/binance-usdm/market-events.js";
import {
  verifyBinanceMarketEvidence,
  writeBinanceMarketEvidenceManifest,
} from "../src/venue/binance-usdm/market-evidence.js";
import { BinanceMarketStreamRecorder } from "../src/venue/binance-usdm/market-stream-recorder.js";
import {
  InMemoryBinanceStreamEvidenceSink,
  JsonlBinanceStreamEvidenceSink,
} from "../src/venue/binance-usdm/stream-evidence.js";
import type {
  BinanceStreamScheduler,
  BinanceWebSocketEventMap,
  BinanceWebSocketFactory,
  BinanceWebSocketLike,
} from "../src/venue/binance-usdm/stream-common.js";

class FakeSocket implements BinanceWebSocketLike {
  readyState = 0;
  readonly listeners: {
    [K in keyof BinanceWebSocketEventMap]: Array<
      (event: BinanceWebSocketEventMap[K]) => void
    >;
  } = { open: [], message: [], error: [], close: [] };

  constructor(readonly url: string) {}

  addEventListener<K extends keyof BinanceWebSocketEventMap>(
    type: K,
    listener: (event: BinanceWebSocketEventMap[K]) => void,
  ): void {
    (
      this.listeners[type] as Array<
        (event: BinanceWebSocketEventMap[K]) => void
      >
    ).push(listener);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  message(value: unknown): void {
    this.emit("message", { data: JSON.stringify(value) });
  }

  close(code = 1000, reason = "closed"): void {
    this.readyState = 3;
    this.emit("close", { code, reason, wasClean: true });
  }

  private emit<K extends keyof BinanceWebSocketEventMap>(
    type: K,
    event: BinanceWebSocketEventMap[K],
  ): void {
    for (const listener of this.listeners[type] as Array<
      (value: BinanceWebSocketEventMap[K]) => void
    >) {
      listener(event);
    }
  }
}

class FakeSocketFactory implements BinanceWebSocketFactory {
  readonly sockets: FakeSocket[] = [];

  create(url: string): FakeSocket {
    const socket = new FakeSocket(url);
    this.sockets.push(socket);
    return socket;
  }
}

class FakeScheduler implements BinanceStreamScheduler {
  private nextHandle = 1;
  readonly timeouts = new Map<number, () => void>();

  setTimeout(callback: () => void, _delayMs: number): number {
    const handle = this.nextHandle++;
    this.timeouts.set(handle, callback);
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.timeouts.delete(handle as number);
  }

  setInterval(_callback: () => void, _delayMs: number): number {
    return this.nextHandle++;
  }

  clearInterval(_handle: unknown): void {}
}

test("current Testnet aggregate-trade and mark-price payloads preserve raw extensions", () => {
  assert.deepEqual(
    inspectBinanceMarketEvent(observedAggregateTrade(305_925_519), "BTCUSDT"),
    {
      event_type: "aggTrade",
      event_time: 1_787_622_187_062,
      symbol: "BTCUSDT",
      aggregate_trade_id: 305_925_519,
      price: "79707.50",
      quantity: "0.0002",
      first_trade_id: 530_946_062,
      last_trade_id: 530_946_062,
      trade_time: 1_787_622_186_883,
      buyer_is_maker: false,
    },
  );
  assert.equal(
    inspectBinanceMarketEvent(observedMarkPrice(), "BTCUSDT").event_type,
    "markPriceUpdate",
  );
  assert.throws(
    () => inspectBinanceMarketEvent(observedMarkPrice(), "ETHUSDT"),
    /does not match/,
  );
});

test("market recorder uses the routed market socket and retains both raw event families", async () => {
  const sockets = new FakeSocketFactory();
  const scheduler = new FakeScheduler();
  const evidence = new InMemoryBinanceStreamEvidenceSink();
  const recorder = new BinanceMarketStreamRecorder({
    symbol: "BTCUSDT",
    streamsBaseUrl: "wss://fstream.binancefuture.com",
    reconnectBaseMs: 1,
    reconnectMaxMs: 100,
    socketFactory: sockets,
    scheduler,
    evidence,
  });

  recorder.start();
  const socket = sockets.sockets[0];
  if (!socket) {
    throw new Error("market socket was not created");
  }
  assert.equal(
    socket.url,
    "wss://fstream.binancefuture.com/market/ws/btcusdt@aggTrade/btcusdt@markPrice@1s",
  );
  socket.open();
  socket.message(observedMarkPrice());
  socket.message(observedAggregateTrade(305_925_519));
  await flushAsync();

  assert.equal(recorder.status().state, "running");
  assert.equal(recorder.status().aggregate_trade_messages, 1);
  assert.equal(recorder.status().mark_price_messages, 1);
  assert.equal(
    evidence.records.filter(
      (record) =>
        record.channel === "public-market" && record.kind === "message",
    ).length,
    2,
  );
  recorder.stop();
  assert.equal(scheduler.timeouts.size, 0);
});

test("market recorder fails closed on a non-increasing aggregate-trade identity", async () => {
  const sockets = new FakeSocketFactory();
  const scheduler = new FakeScheduler();
  const evidence = new InMemoryBinanceStreamEvidenceSink();
  const recorder = new BinanceMarketStreamRecorder({
    symbol: "BTCUSDT",
    streamsBaseUrl: "wss://fstream.binance.com",
    reconnectBaseMs: 1,
    reconnectMaxMs: 100,
    socketFactory: sockets,
    scheduler,
    evidence,
  });

  recorder.start();
  const socket = sockets.sockets[0];
  if (!socket) {
    throw new Error("market socket was not created");
  }
  socket.open();
  socket.message(observedAggregateTrade(305_925_519));
  socket.message(observedAggregateTrade(305_925_519));
  await flushAsync();

  assert.equal(recorder.status().state, "backoff");
  assert.equal(scheduler.timeouts.size, 1);
  assert.equal(
    evidence.records.some(
      (record) =>
        record.kind === "error" &&
        JSON.stringify(record.payload).includes("must increase"),
    ),
    true,
  );
  recorder.stop();
});

test("finite market evidence is accepted only with a clean complete lifecycle", () => {
  const path = resolve(
    "artifacts",
    "tests",
    `glitch-binance-market-${randomUUID()}.jsonl`,
  );
  const manifestPath = `${path}.manifest.json`;
  let now = 1_787_622_186_000;
  try {
    const sink = new JsonlBinanceStreamEvidenceSink(path, {
      now: () => (now += 100),
    });
    sink.record("public-market", "transition", {
      state: "connecting",
      mutation_authority: false,
    });
    sink.record("public-market", "transition", { state: "running" });
    sink.record("public-market", "message", observedMarkPrice());
    sink.record(
      "public-market",
      "message",
      observedAggregateTrade(305_925_519),
    );
    sink.record("public-market", "transition", { state: "stopped" });

    const report = writeBinanceMarketEvidenceManifest(
      path,
      manifestPath,
      { minimumAggregateTrades: 1, minimumMarkPrices: 1 },
    );
    assert.equal(report.accepted_for_raw_replay, true);
    assert.equal(report.aggregate_trade_messages, 1);
    assert.equal(report.mark_price_messages, 1);
    assert.equal(report.sequence_contiguous, true);
    assert.equal(report.evidence_sha256.length, 64);
    assert.equal(existsSync(manifestPath), true);

    sink.record("public-market", "error", { type: "late_error" });
    const rejected = verifyBinanceMarketEvidence(path, {
      minimumAggregateTrades: 1,
      minimumMarkPrices: 1,
    });
    assert.equal(rejected.accepted_for_raw_replay, false);
    assert.equal(
      rejected.rejection_reasons.includes("market_errors_observed:1"),
      true,
    );
  } finally {
    rmSync(path, { force: true });
    rmSync(`${path}.1`, { force: true });
    rmSync(manifestPath, { force: true });
  }
});

test("the frozen observed mainnet market fixture remains checksum-bound", () => {
  const report = verifyBinanceMarketEvidence(
    "operations/evidence/GC-002/binance-mainnet-market-2026-08-24.jsonl",
    { minimumAggregateTrades: 200, minimumMarkPrices: 10 },
  );

  assert.equal(report.accepted_for_raw_replay, true);
  assert.equal(
    report.evidence_sha256,
    "07185347c6e1f6bdc0f2900b026f49d753d41c6de573904e4c7d8315669eb48c",
  );
  assert.equal(report.record_count, 260);
  assert.equal(report.aggregate_trade_messages, 245);
  assert.equal(report.mark_price_messages, 12);
  assert.equal(report.error_records, 0);
  assert.equal(report.backoff_transitions, 0);
  assert.equal(report.invalid_messages, 0);
  assert.equal(report.non_increasing_aggregate_trade_ids, 0);
  assert.equal(report.non_monotonic_event_times, 0);
});

function observedAggregateTrade(id: number): Record<string, unknown> {
  return {
    e: "aggTrade",
    E: 1_787_622_187_062,
    a: id,
    s: "BTCUSDT",
    p: "79707.50",
    q: "0.0002",
    nq: "0.0002",
    f: 530_946_062,
    l: 530_946_062,
    T: 1_787_622_186_883,
    m: false,
    st: 1,
  };
}

function observedMarkPrice(): Record<string, unknown> {
  return {
    e: "markPriceUpdate",
    E: 1_787_622_187_001,
    s: "BTCUSDT",
    p: "79700.10000000",
    ap: "79700.10000000",
    P: "79752.71274915",
    i: "79744.02717391",
    r: "-0.00002106",
    T: 1_787_644_800_000,
    st: 1,
  };
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 0));
}
