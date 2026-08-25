import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  requireBinanceUsdmTestnetStreamsOrigin,
  verifyBinancePrivateEvidence,
  writeBinancePrivateEvidenceManifest,
} from "../src/venue/binance-usdm/private-evidence.js";
import { JsonlBinanceStreamEvidenceSink } from "../src/venue/binance-usdm/stream-evidence.js";

test("private evidence replays buffered account truth into a sanitized manifest", () => {
  const path = resolve(
    "artifacts",
    "tests",
    `glitch-binance-private-${randomUUID()}.jsonl`,
  );
  const manifestPath = `${path}.manifest.json`;
  let now = 1_700_000_000_000;
  try {
    const sink = new JsonlBinanceStreamEvidenceSink(path, {
      now: () => (now += 100),
    });
    sink.record("supervisor", "transition", {
      action: "start",
      private_enabled: true,
      mutation_authority: false,
    });
    sink.record("private-user", "transition", { state: "connecting" });
    sink.record("private-user", "transition", { state: "synchronizing" });
    sink.record("private-user", "message", {
      e: "ACCOUNT_UPDATE",
      E: 1_700_000_000_400,
      T: 1_700_000_000_400,
      a: {
        B: [{ a: "USDT", wb: "1005", cw: "1005", bc: "5" }],
        P: [],
      },
    });
    sink.record("private-user", "reconciliation", {
      observedAt: 1_700_000_000_300,
      balances: [
        {
          asset: "USDT",
          balance: "1000",
          crossWalletBalance: "1000",
        },
      ],
      positions: [],
      openOrders: [],
    });
    sink.record("private-user", "transition", { state: "running" });
    sink.record("private-user", "transition", { state: "stopped" });
    sink.record("supervisor", "transition", { action: "stop" });

    const report = writeBinancePrivateEvidenceManifest(path, manifestPath, {
      minimumPrivateMessages: 1,
    });
    assert.equal(report.accepted_for_private_replay, true);
    assert.equal(report.private_reconciliations, 1);
    assert.equal(report.private_messages, 1);
    assert.equal(report.replay.applied_event_count, 1);
    assert.equal(report.replay.balance_count, 1);
    assert.equal(report.replay.stream_expired, false);
    assert.equal(report.evidence_sha256.length, 64);
    assert.equal(existsSync(manifestPath), true);

    const manifest = readFileSync(manifestPath, "utf8");
    assert.equal(manifest.includes("1000"), false);
    assert.equal(manifest.includes("1005"), false);
    assert.equal(manifest.includes("ACCOUNT_UPDATE"), false);

    sink.record("private-user", "message", {
      e: "UNSUPPORTED_PRIVATE_EVENT",
      E: 1_700_000_000_500,
      T: 1_700_000_000_500,
    });
    const rejected = verifyBinancePrivateEvidence(path, {
      minimumPrivateMessages: 1,
    });
    assert.equal(rejected.accepted_for_private_replay, false);
    assert.equal(
      rejected.rejection_reasons.includes(
        "private_messages_not_fully_applied:1!=2",
      ),
      true,
    );
  } finally {
    rmSync(path, { force: true });
    rmSync(`${path}.1`, { force: true });
    rmSync(manifestPath, { force: true });
  }
});

test("private evidence rejects missing events and incomplete lifecycle", () => {
  const path = resolve(
    "artifacts",
    "tests",
    `glitch-binance-private-incomplete-${randomUUID()}.jsonl`,
  );
  try {
    const sink = new JsonlBinanceStreamEvidenceSink(path);
    sink.record("supervisor", "transition", {
      action: "start",
      private_enabled: true,
      mutation_authority: false,
    });
    sink.record("private-user", "reconciliation", {
      observedAt: 1_700_000_000_000,
      balances: [],
      positions: [],
      openOrders: [],
    });

    const report = verifyBinancePrivateEvidence(path, {
      minimumPrivateMessages: 1,
    });
    assert.equal(report.accepted_for_private_replay, false);
    assert.equal(
      report.rejection_reasons.includes("supervisor_lifecycle_incomplete"),
      true,
    );
    assert.equal(
      report.rejection_reasons.includes("private_lifecycle_incomplete"),
      true,
    );
    assert.equal(
      report.rejection_reasons.includes(
        "private_message_count_below_minimum:0<1",
      ),
      true,
    );
  } finally {
    rmSync(path, { force: true });
    rmSync(`${path}.1`, { force: true });
  }
});

test("private capture stream authority is Testnet-only", () => {
  assert.equal(
    requireBinanceUsdmTestnetStreamsOrigin(
      "wss://fstream.binancefuture.com",
    ),
    "wss://fstream.binancefuture.com",
  );
  assert.throws(
    () =>
      requireBinanceUsdmTestnetStreamsOrigin("wss://fstream.binance.com"),
    /requires Futures Testnet streams/,
  );
});
