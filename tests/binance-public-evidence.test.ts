import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import {
  verifyBinancePublicEvidence,
  writeBinancePublicEvidenceManifest,
} from "../src/venue/binance-usdm/public-evidence.js";
import { JsonlBinanceStreamEvidenceSink } from "../src/venue/binance-usdm/stream-evidence.js";

test("public runtime evidence is accepted only when the finite session replays ready", () => {
  const path = `/tmp/glitch-binance-public-${randomUUID()}.jsonl`;
  const manifestPath = `${path}.manifest.json`;
  let now = 1_700_000_000_000;
  try {
    const sink = new JsonlBinanceStreamEvidenceSink(path, {
      now: () => now += 100,
    });
    sink.record("supervisor", "transition", {
      action: "start",
      symbol: "BTCUSDT",
      private_enabled: false,
      mutation_authority: false,
    });
    sink.record("public-depth", "transition", {
      state: "connecting",
      epoch: 1,
    });
    sink.record("public-depth", "message", {
      U: 101,
      u: 101,
      pu: 100,
      s: "BTCUSDT",
      b: [["60000", "2"]],
      a: [],
    });
    sink.record("public-depth", "snapshot", {
      lastUpdateId: 100,
      bids: [["60000", "1"]],
      asks: [["60001", "1"]],
    });
    sink.record("public-depth", "transition", {
      state: "running",
      epoch: 1,
      update_id: 101,
    });
    sink.record("public-depth", "message", {
      U: 102,
      u: 102,
      pu: 101,
      s: "BTCUSDT",
      b: [],
      a: [["60001", "3"]],
    });
    sink.record("public-depth", "transition", {
      state: "stopped",
      epoch: 2,
    });
    sink.record("supervisor", "transition", {
      action: "stop",
      symbol: "BTCUSDT",
    });

    const report = writeBinancePublicEvidenceManifest(
      path,
      manifestPath,
      { minimumMessages: 2 },
    );
    assert.equal(report.accepted_for_public_replay, true);
    assert.equal(report.rejection_reasons.length, 0);
    assert.equal(report.sequence_contiguous, true);
    assert.equal(report.timestamps_monotonic, true);
    assert.equal(report.counts.public_snapshots, 1);
    assert.equal(report.counts.public_messages, 2);
    assert.equal(report.replay.order_book_status, "ready");
    assert.deepEqual(report.replay.best_bid, ["60000", "2"]);
    assert.deepEqual(report.replay.best_ask, ["60001", "3"]);
    assert.equal(report.evidence_sha256.length, 64);
    assert.equal(existsSync(manifestPath), true);
    assert.equal(
      JSON.parse(readFileSync(manifestPath, "utf8")).accepted_for_public_replay,
      true,
    );
  } finally {
    rmSync(path, { force: true });
    rmSync(`${path}.1`, { force: true });
    rmSync(manifestPath, { force: true });
  }
});

test("public evidence rejects sequence corruption and private records", () => {
  const path = `/tmp/glitch-binance-public-invalid-${randomUUID()}.jsonl`;
  try {
    const sink = new JsonlBinanceStreamEvidenceSink(path, {
      now: () => 1_700_000_000_000,
    });
    sink.record("supervisor", "transition", {
      action: "start",
      mutation_authority: false,
    });
    sink.record("public-depth", "snapshot", {
      lastUpdateId: 100,
      bids: [["60000", "1"]],
      asks: [["60001", "1"]],
    });
    sink.record("public-depth", "transition", { state: "running" });
    sink.record("public-depth", "message", {
      U: 101,
      u: 101,
      pu: 100,
      s: "BTCUSDT",
      b: [],
      a: [],
    });
    sink.record("private-user", "message", { e: "ACCOUNT_UPDATE" });
    sink.record("supervisor", "transition", { action: "stop" });

    const corrupted = readFileSync(path, "utf8").replace(
      '"sequence":4',
      '"sequence":40',
    );
    rmSync(path, { force: true });
    appendFileSync(path, corrupted, { encoding: "utf8" });

    const report = verifyBinancePublicEvidence(path, { minimumMessages: 1 });
    assert.equal(report.accepted_for_public_replay, false);
    assert.equal(
      report.rejection_reasons.includes("evidence_sequence_not_contiguous"),
      true,
    );
    assert.equal(
      report.rejection_reasons.includes("public_fixture_contains_private_records"),
      true,
    );
  } finally {
    rmSync(path, { force: true });
    rmSync(`${path}.1`, { force: true });
  }
});

test("the frozen observed Testnet fixture remains checksum-bound and replay-ready", () => {
  const report = verifyBinancePublicEvidence(
    "tests/fixtures/binance-usdm/observed-testnet-public.jsonl",
    { minimumMessages: 5 },
  );

  assert.equal(report.accepted_for_public_replay, true);
  assert.equal(
    report.evidence_sha256,
    "0b1053f5607bfc9354e4744f993f42637dada8902b5982f69319c5b279dd2ab7",
  );
  assert.equal(report.record_count, 12);
  assert.equal(report.counts.public_messages, 5);
  assert.equal(report.counts.public_errors, 0);
  assert.equal(report.replay.order_book_status, "ready");
  assert.equal(report.replay.update_id, 410_623_244_109);
  assert.deepEqual(report.replay.best_bid, ["78688.20", "0.0129"]);
  assert.deepEqual(report.replay.best_ask, ["78718.20", "0.0054"]);
  assert.equal(report.replay.gap_reason, null);
});
