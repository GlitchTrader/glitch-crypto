import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
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

  rawMessage(value: string): void {
    this.emit("message", { data: value });
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
  assert.equal(recorder.status().last_mark_price?.mark_price, "79700.10000000");
  assert.equal(
    recorder.status().last_aggregate_trade?.aggregate_trade_id,
    305_925_519,
  );
  assert.equal(
    evidence.records.filter(
      (record) =>
        record.channel === "public-market" && record.kind === "message",
    ).length,
    2,
  );
  const messages = evidence.records.filter(
    (record) => record.schema_version ===
      "glitch.crypto.binance-usdm-stream-evidence.v2",
  );
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.provenance.venue, "BINANCE_USDM");
  assert.equal(messages[0]?.provenance.instrument, "BTCUSDT");
  assert.equal(messages[0]?.provenance.raw_frame_sha256.length, 64);
  assert.equal(messages[1]?.provenance.provider_sequence.aggregate_trade_id, 305_925_519);
  socket.close(1006, "network");
  const reconnect = [...scheduler.timeouts.entries()][0];
  assert.ok(reconnect);
  scheduler.timeouts.delete(reconnect![0]);
  reconnect![1]();
  assert.equal(recorder.status().state, "connecting");
  assert.equal(recorder.status().last_mark_price, null);
  assert.equal(recorder.status().last_aggregate_trade, null);
  recorder.stop();
  assert.equal(scheduler.timeouts.size, 0);
});

test("invalid JSON is retained exactly before the attributable reconnect boundary", async () => {
  const sockets = new FakeSocketFactory();
  const scheduler = new FakeScheduler();
  const evidence = new InMemoryBinanceStreamEvidenceSink();
  const connectionIds = ["market-connection-0001", "market-connection-0002"];
  let connectionIndex = 0;
  const recorder = new BinanceMarketStreamRecorder({
    symbol: "BTCUSDT",
    streamsBaseUrl: "wss://fstream.binance.com",
    reconnectBaseMs: 1,
    reconnectMaxMs: 100,
    socketFactory: sockets,
    scheduler,
    evidence,
    wallClock: () => 1_787_622_187_100,
    monotonicClock: () => 1_000_000n,
    connectionIdFactory: () => connectionIds[connectionIndex++] ?? "unexpected-connection",
  });

  recorder.start();
  const socket = sockets.sockets[0];
  if (!socket) {
    throw new Error("market socket was not created");
  }
  socket.open();
  socket.rawMessage("{invalid-json");
  await flushAsync();

  const rawRecord = evidence.records.find(
    (record) => record.schema_version ===
      "glitch.crypto.binance-usdm-stream-evidence.v2",
  );
  const errorRecord = evidence.records.find((record) => record.kind === "error");
  assert.ok(rawRecord);
  assert.ok(errorRecord);
  assert.equal(rawRecord?.payload, null);
  assert.equal(rawRecord?.provenance.raw_frame, "{invalid-json");
  assert.ok(evidence.records.indexOf(rawRecord!) < evidence.records.indexOf(errorRecord!));
  assert.equal(recorder.status().state, "backoff");

  const restart = [...scheduler.timeouts.values()][0];
  assert.ok(restart);
  restart?.();
  const observedConnections = evidence.records
    .filter((record) => record.kind === "transition")
    .map((record) => (record.payload as Record<string, unknown>).connection_id)
    .filter((value): value is string => typeof value === "string");
  assert.equal(new Set(observedConnections).size, 2);
  recorder.stop();
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
    assert.equal(report.accepted_for_event_replay, false);
    assert.equal(report.legacy_message_records, 2);
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

test("replay-grade evidence verifies exact raw frames and rejects provenance tampering", async () => {
  const path = resolve(
    "artifacts",
    "tests",
    `glitch-binance-market-v2-${randomUUID()}.jsonl`,
  );
  const sockets = new FakeSocketFactory();
  const scheduler = new FakeScheduler();
  let evidenceNow = 1_787_622_186_000;
  let receiveNow = 1_787_622_187_000;
  let monotonicNow = 10_000_000n;
  try {
    const evidence = new JsonlBinanceStreamEvidenceSink(path, {
      now: () => (evidenceNow += 100),
    });
    const recorder = new BinanceMarketStreamRecorder({
      symbol: "BTCUSDT",
      streamsBaseUrl: "wss://fstream.binance.com",
      reconnectBaseMs: 1,
      reconnectMaxMs: 100,
      socketFactory: sockets,
      scheduler,
      evidence,
      wallClock: () => (receiveNow += 10),
      monotonicClock: () => (monotonicNow += 1_000n),
      connectionIdFactory: () => "market-connection-replay-0001",
    });
    recorder.start();
    const socket = sockets.sockets[0];
    if (!socket) {
      throw new Error("market socket was not created");
    }
    socket.open();
    socket.message(observedMarkPrice());
    socket.message(observedAggregateTrade(305_925_519));
    await flushAsync();
    recorder.stop();

    const report = verifyBinanceMarketEvidence(path, {
      minimumAggregateTrades: 1,
      minimumMarkPrices: 1,
    });
    assert.equal(report.accepted_for_raw_replay, true);
    assert.equal(report.accepted_for_event_replay, true);
    assert.equal(report.legacy_message_records, 0);
    assert.equal(report.replay_grade_message_records, 2);
    assert.deepEqual(report.connection_ids, ["market-connection-replay-0001"]);
    assert.equal(report.raw_hash_mismatches, 0);
    assert.equal(report.raw_payload_mismatches, 0);
    assert.equal(report.provider_identity_mismatches, 0);
    assert.equal(report.non_monotonic_receive_times, 0);

    const originalLines = readFileSync(path, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const tamperedHash = verifyTamperedMarketEvidence(path, originalLines, (messages) => {
      const provenance = messages[0]?.provenance as Record<string, unknown>;
      const hash = String(provenance.raw_frame_sha256);
      provenance.raw_frame_sha256 = `${hash[0] === "0" ? "1" : "0"}${hash.slice(1)}`;
    });
    assert.equal(tamperedHash.accepted_for_raw_replay, false);
    assert.equal(tamperedHash.raw_hash_mismatches, 1);

    const tamperedPayload = verifyTamperedMarketEvidence(path, originalLines, (messages) => {
      const payload = messages[0]?.payload as Record<string, unknown>;
      payload.p = "1.00";
    });
    assert.equal(tamperedPayload.accepted_for_event_replay, false);
    assert.equal(tamperedPayload.raw_payload_mismatches, 1);

    const tamperedClock = verifyTamperedMarketEvidence(path, originalLines, (messages) => {
      const first = messages[0]?.provenance as Record<string, unknown>;
      const second = messages[1]?.provenance as Record<string, unknown>;
      second.monotonic_receive_ns = first.monotonic_receive_ns;
    });
    assert.equal(tamperedClock.non_monotonic_receive_times, 1);

    const tamperedConnection = verifyTamperedMarketEvidence(path, originalLines, (messages) => {
      const provenance = messages[0]?.provenance as Record<string, unknown>;
      provenance.connection_id = "market-connection-unobserved";
    });
    assert.equal(tamperedConnection.unattributed_connection_records, 1);

    const tamperedIdentity = verifyTamperedMarketEvidence(path, originalLines, (messages) => {
      const provenance = messages[0]?.provenance as Record<string, unknown>;
      const sequence = provenance.provider_sequence as Record<string, unknown>;
      sequence.event_time_ms = Number(sequence.event_time_ms) + 1;
    });
    assert.equal(tamperedIdentity.provider_identity_mismatches, 1);
  } finally {
    rmSync(path, { force: true });
    rmSync(`${path}.1`, { force: true });
  }
});

test("the frozen observed mainnet market fixture remains checksum-bound", () => {
  const report = verifyBinanceMarketEvidence(
    "operations/evidence/GC-002/binance-mainnet-market-2026-08-24.jsonl",
    { minimumAggregateTrades: 200, minimumMarkPrices: 10 },
  );

  assert.equal(report.accepted_for_raw_replay, true);
  assert.equal(report.accepted_for_event_replay, false);
  assert.equal(report.legacy_message_records, 257);
  assert.equal(
    report.replay_grade_rejection_reasons.includes("legacy_message_records:257"),
    true,
  );
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

test("the frozen observed Testnet provenance fixture is replay-grade and checksum-bound", () => {
  const report = verifyBinanceMarketEvidence(
    "operations/evidence/GC-002/binance-testnet-market-provenance-2026-08-25.jsonl",
    { minimumAggregateTrades: 30, minimumMarkPrices: 5 },
  );

  assert.equal(report.accepted_for_raw_replay, true);
  assert.equal(report.accepted_for_event_replay, true);
  assert.equal(
    report.evidence_sha256,
    "be102c024e52d8265857c41683504cc7f5a5609f01295c0f69fcf8e77173f5db",
  );
  assert.equal(report.record_count, 47);
  assert.equal(report.aggregate_trade_messages, 37);
  assert.equal(report.mark_price_messages, 7);
  assert.equal(report.legacy_message_records, 0);
  assert.equal(report.replay_grade_message_records, 44);
  assert.equal(report.connection_ids.length, 1);
  assert.equal(report.raw_hash_mismatches, 0);
  assert.equal(report.raw_payload_mismatches, 0);
  assert.equal(report.provider_identity_mismatches, 0);
  assert.equal(report.unattributed_connection_records, 0);
  assert.equal(report.non_monotonic_receive_times, 0);
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

function verifyTamperedMarketEvidence(
  path: string,
  originalLines: readonly Record<string, unknown>[],
  mutate: (messages: Record<string, unknown>[]) => void,
) {
  const lines = JSON.parse(JSON.stringify(originalLines)) as Record<string, unknown>[];
  const messages = lines.filter((record) => record.schema_version ===
    "glitch.crypto.binance-usdm-stream-evidence.v2");
  mutate(messages);
  rmSync(path, { force: true });
  appendFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, {
    encoding: "utf8",
  });
  return verifyBinanceMarketEvidence(path, {
    minimumAggregateTrades: 1,
    minimumMarkPrices: 1,
  });
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 0));
}
