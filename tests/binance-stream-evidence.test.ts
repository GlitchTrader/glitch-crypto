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
