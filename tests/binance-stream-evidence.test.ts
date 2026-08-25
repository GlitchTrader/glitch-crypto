import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryBinanceStreamEvidenceSink,
  JsonlBinanceStreamEvidenceSink,
} from "../src/venue/binance-usdm/stream-evidence.js";
import {
  readBinanceStreamEvidenceJsonl,
  replayBinanceStreamEvidence,
} from "../src/venue/binance-usdm/stream-replay.js";

test("stream evidence replays public and private state deterministically", () => {
  const sink = new InMemoryBinanceStreamEvidenceSink({ now: () => 1_700_000_000_000 });
  sink.record("public-depth", "snapshot", {
    lastUpdateId: 100,
    bids: [["60000", "1"]],
    asks: [["60001", "1"]],
  });
  sink.record("public-depth", "message", {
    U: 101,
    u: 101,
    pu: 100,
    s: "BTCUSDT",
    b: [["60000", "2"]],
    a: [],
  });
  sink.record("private-user", "transition", { state: "synchronizing" });
  sink.record("private-user", "message", {
    e: "ACCOUNT_UPDATE",
    E: 1_700_000_000_001,
    T: 1_700_000_000_001,
    a: { B: [{ a: "USDT", wb: "1005", cw: "1005", bc: "5" }], P: [] },
  });
  sink.record("private-user", "reconciliation", {
    observedAt: 1_700_000_000_000,
    balances: [{ asset: "USDT", balance: "1000", crossWalletBalance: "1000" }],
    positions: [],
    openOrders: [],
  });

  const replay = replayBinanceStreamEvidence(sink.records);
  assert.equal(replay.processed_records, 4);
  assert.equal(replay.ignored_records, 1);
  assert.deepEqual(replay.public_order_book.best_bid, ["60000", "2"]);
  assert.equal(replay.private_account.balances[0]?.wallet_balance, "1005");
});

test("JSONL evidence is bounded, rotated, and credential-free", () => {
  const path = join(tmpdir(), `glitch-binance-evidence-${randomUUID()}.jsonl`);
  const backup = `${path}.1`;
  try {
    const sink = new JsonlBinanceStreamEvidenceSink(path, {
      maxBytes: 1_024,
      forbiddenValues: ["secret-value"],
      now: () => 1_700_000_000_000,
    });
    sink.record("supervisor", "transition", { secret: "secret-value", padding: "x".repeat(700) });
    sink.record("supervisor", "transition", { padding: "y".repeat(700) });
    assert.equal(existsSync(path), true);
    assert.equal(existsSync(backup), true);
    const combined = readFileSync(path, "utf8") + readFileSync(backup, "utf8");
    assert.equal(combined.includes("secret-value"), false);
    assert.match(combined, /\[REDACTED\]/);
    const records = readBinanceStreamEvidenceJsonl(path);
    assert.equal(records.length, 2);
    assert.equal(records[0]?.sequence, 1);
    assert.equal(records[1]?.sequence, 2);
    assert.equal(records[0]?.session_id, records[1]?.session_id);
  } finally {
    rmSync(path, { force: true });
    rmSync(backup, { force: true });
  }
});

test("exact raw market frames reject configured credentials instead of rewriting them", () => {
  const sink = new InMemoryBinanceStreamEvidenceSink({
    forbiddenValues: ["credential-value"],
    now: () => 1_700_000_000_000,
  });
  assert.throws(() => sink.record(
    "public-market",
    "message",
    null,
    {
      venue: "BINANCE_USDM",
      instrument: "BTCUSDT",
      channel: "public-market",
      connection_id: "market-connection-0001",
      local_receive_timestamp_ms: 1_700_000_000_000,
      monotonic_receive_ns: "1000000",
      exchange_timestamp_ms: null,
      provider_sequence: {
        event_type: null,
        event_time_ms: null,
        aggregate_trade_id: null,
        first_trade_id: null,
        last_trade_id: null,
        trade_time_ms: null,
        first_update_id: null,
        final_update_id: null,
        previous_final_update_id: null,
        transaction_time_ms: null,
      },
      normalization_version: "binance-usdm-market-inspection.v1",
      raw_frame: '{"token":"credential-value"}',
    },
  ), /configured credential/);
  assert.equal(sink.records.length, 0);
});

test("exact raw depth snapshots use version 3 and reject configured credentials", () => {
  const sink = new InMemoryBinanceStreamEvidenceSink({
    forbiddenValues: ["credential-value"],
    now: () => 1_700_000_000_000,
  });
  const provenance = {
    venue: "BINANCE_USDM" as const,
    instrument: "BTCUSDT",
    channel: "public-depth" as const,
    transport: "REST" as const,
    method: "GET" as const,
    origin: "https://demo-fapi.binance.com",
    path: "/fapi/v1/depth" as const,
    query: "limit=1000&symbol=BTCUSDT",
    http_status: 200,
    local_receive_timestamp_ms: 1_700_000_000_500,
    monotonic_receive_ns: "2000000",
    normalization_version:
      "binance-usdm-depth-snapshot-inspection.v1" as const,
    raw_response: '{"lastUpdateId":100,"bids":[],"asks":[]}',
  };
  const record = sink.record(
    "public-depth",
    "raw_snapshot",
    null,
    provenance,
  );
  assert.equal(
    record.schema_version,
    "glitch.crypto.binance-usdm-stream-evidence.v3",
  );
  if (
    record.schema_version !==
    "glitch.crypto.binance-usdm-stream-evidence.v3"
  ) {
    throw new Error("expected version-3 raw snapshot evidence");
  }
  assert.equal(record.provenance.raw_response, provenance.raw_response);
  assert.equal(record.provenance.raw_response_sha256.length, 64);
  assert.throws(
    () => sink.record(
      "public-depth",
      "raw_snapshot",
      null,
      { ...provenance, raw_response: '{"token":"credential-value"}' },
    ),
    /configured credential/,
  );
});
