import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  verifyBinancePublicEvidence,
  writeBinancePublicEvidenceManifest,
} from "../src/venue/binance-usdm/public-evidence.js";
import { JsonlBinanceStreamEvidenceSink } from "../src/venue/binance-usdm/stream-evidence.js";

test("public runtime evidence is accepted only when the finite session replays ready", () => {
  const path = testEvidencePath(`glitch-binance-public-${randomUUID()}.jsonl`);
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
    assert.equal(report.accepted_for_depth_frame_replay, false);
    assert.equal(report.accepted_for_depth_session_replay, false);
    assert.equal(report.depth_provenance.legacy_message_records, 2);
    assert.equal(
      report.depth_frame_rejection_reasons.includes(
        "legacy_depth_message_records:2",
      ),
      true,
    );
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
  const path = testEvidencePath(`glitch-binance-public-invalid-${randomUUID()}.jsonl`);
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

test("replay-grade public evidence verifies exact depth frames and rejects provenance tampering", () => {
  const path = testEvidencePath(`glitch-binance-public-v2-${randomUUID()}.jsonl`);
  let evidenceNow = 1_787_622_186_000;
  try {
    const sink = new JsonlBinanceStreamEvidenceSink(path, {
      now: () => (evidenceNow += 100),
    });
    const connectionId = "depth-connection-replay-0001";
    const first = observedDepthDelta(101, 100, [["60000", "2"]], []);
    const second = observedDepthDelta(102, 101, [], [["60001", "3"]]);
    const snapshot = {
      lastUpdateId: 100,
      bids: [["60000", "1"]],
      asks: [["60001", "1"]],
    };
    sink.record("supervisor", "transition", {
      action: "start",
      symbol: "BTCUSDT",
      private_enabled: false,
      mutation_authority: false,
    });
    sink.record("public-depth", "transition", {
      state: "connecting",
      epoch: 1,
      connection_id: connectionId,
    });
    sink.record(
      "public-depth",
      "message",
      first,
      depthFrame(first, connectionId, "10000000"),
    );
    sink.record(
      "public-depth",
      "raw_snapshot",
      null,
      depthSnapshot(snapshot, "10000500"),
    );
    sink.record("public-depth", "snapshot", snapshot);
    sink.record("public-depth", "transition", {
      state: "running",
      epoch: 1,
      connection_id: connectionId,
      update_id: 101,
    });
    sink.record(
      "public-depth",
      "message",
      second,
      depthFrame(second, connectionId, "10001000"),
    );
    sink.record("public-depth", "transition", { state: "stopped", epoch: 2 });
    sink.record("supervisor", "transition", { action: "stop", symbol: "BTCUSDT" });

    const report = verifyBinancePublicEvidence(path, { minimumMessages: 2 });
    assert.equal(report.accepted_for_public_replay, true);
    assert.equal(report.accepted_for_depth_frame_replay, true);
    assert.equal(report.accepted_for_depth_session_replay, true);
    assert.equal(report.depth_provenance.legacy_message_records, 0);
    assert.equal(report.depth_provenance.replay_grade_message_records, 2);
    assert.deepEqual(report.depth_provenance.connection_ids, [connectionId]);
    assert.equal(report.depth_provenance.raw_hash_mismatches, 0);
    assert.equal(report.depth_provenance.raw_payload_mismatches, 0);
    assert.equal(report.depth_provenance.provider_identity_mismatches, 0);
    assert.equal(report.depth_provenance.unattributed_connection_records, 0);
    assert.equal(report.depth_provenance.non_monotonic_receive_times, 0);
    assert.equal(report.snapshot_provenance.raw_snapshot_records, 1);
    assert.equal(report.snapshot_provenance.paired_snapshot_records, 1);
    assert.equal(report.snapshot_provenance.parsed_snapshots_without_raw, 0);
    assert.equal(report.snapshot_provenance.raw_snapshots_without_parsed, 0);
    assert.equal(report.snapshot_provenance.raw_hash_mismatches, 0);
    assert.equal(report.snapshot_provenance.normalized_payload_mismatches, 0);
    assert.equal(report.snapshot_provenance.request_identity_mismatches, 0);

    const originalLines = readFileSync(path, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const tamperedHash = verifyTamperedPublicEvidence(path, originalLines, (messages) => {
      const provenance = messages[0]?.provenance as Record<string, unknown>;
      const hash = String(provenance.raw_frame_sha256);
      provenance.raw_frame_sha256 = `${hash[0] === "0" ? "1" : "0"}${hash.slice(1)}`;
    });
    assert.equal(tamperedHash.accepted_for_depth_frame_replay, false);
    assert.equal(tamperedHash.depth_provenance.raw_hash_mismatches, 1);

    const tamperedPayload = verifyTamperedPublicEvidence(path, originalLines, (messages) => {
      const payload = messages[0]?.payload as Record<string, unknown>;
      payload.s = "ETHUSDT";
    });
    assert.equal(tamperedPayload.depth_provenance.raw_payload_mismatches, 1);

    const tamperedClock = verifyTamperedPublicEvidence(path, originalLines, (messages) => {
      const firstProvenance = messages[0]?.provenance as Record<string, unknown>;
      const secondProvenance = messages[1]?.provenance as Record<string, unknown>;
      secondProvenance.monotonic_receive_ns = firstProvenance.monotonic_receive_ns;
    });
    assert.equal(tamperedClock.depth_provenance.non_monotonic_receive_times, 1);

    const tamperedConnection = verifyTamperedPublicEvidence(path, originalLines, (messages) => {
      const provenance = messages[0]?.provenance as Record<string, unknown>;
      provenance.connection_id = "depth-connection-unobserved";
    });
    assert.equal(tamperedConnection.depth_provenance.unattributed_connection_records, 1);

    const tamperedIdentity = verifyTamperedPublicEvidence(path, originalLines, (messages) => {
      const provenance = messages[0]?.provenance as Record<string, unknown>;
      const sequence = provenance.provider_sequence as Record<string, unknown>;
      sequence.final_update_id = Number(sequence.final_update_id) + 1;
    });
    assert.equal(tamperedIdentity.depth_provenance.provider_identity_mismatches, 1);

    const tamperedSnapshotHash = verifyTamperedSnapshotEvidence(
      path,
      originalLines,
      (rawSnapshots) => {
        const provenance = rawSnapshots[0]?.provenance as Record<string, unknown>;
        const hash = String(provenance.raw_response_sha256);
        provenance.raw_response_sha256 = `${hash[0] === "0" ? "1" : "0"}${hash.slice(1)}`;
      },
    );
    assert.equal(tamperedSnapshotHash.accepted_for_depth_frame_replay, true);
    assert.equal(tamperedSnapshotHash.accepted_for_depth_session_replay, false);
    assert.equal(tamperedSnapshotHash.snapshot_provenance.raw_hash_mismatches, 1);

    const tamperedSnapshotPayload = verifyTamperedSnapshotEvidence(
      path,
      originalLines,
      (rawSnapshots) => {
        const provenance = rawSnapshots[0]?.provenance as Record<string, unknown>;
        const parsed = JSON.parse(String(provenance.raw_response)) as Record<string, unknown>;
        parsed.lastUpdateId = 99;
        provenance.raw_response = JSON.stringify(parsed);
        provenance.raw_response_sha256 = createHash("sha256")
          .update(String(provenance.raw_response))
          .digest("hex");
      },
    );
    assert.equal(tamperedSnapshotPayload.snapshot_provenance.normalized_payload_mismatches, 1);
    assert.equal(tamperedSnapshotPayload.snapshot_provenance.update_identity_mismatches, 1);

    const tamperedSnapshotRequest = verifyTamperedSnapshotEvidence(
      path,
      originalLines,
      (rawSnapshots) => {
        const provenance = rawSnapshots[0]?.provenance as Record<string, unknown>;
        provenance.query = "limit=1000&symbol=ETHUSDT";
      },
    );
    assert.equal(tamperedSnapshotRequest.snapshot_provenance.request_identity_mismatches, 1);

    const tamperedSnapshotClock = verifyTamperedSnapshotEvidence(
      path,
      originalLines,
      (rawSnapshots) => {
        const provenance = rawSnapshots[0]?.provenance as Record<string, unknown>;
        provenance.monotonic_receive_ns = "10000000";
      },
    );
    assert.equal(tamperedSnapshotClock.snapshot_provenance.non_monotonic_receive_times, 1);
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
  assert.equal(report.accepted_for_depth_frame_replay, false);
  assert.equal(report.accepted_for_depth_session_replay, false);
  assert.equal(report.depth_provenance.legacy_message_records, 5);
  assert.equal(report.snapshot_provenance.parsed_snapshots_without_raw, 1);
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

test("the frozen observed Testnet depth fixture is replay-grade and checksum-bound", () => {
  const report = verifyBinancePublicEvidence(
    "operations/evidence/GC-002/binance-testnet-depth-provenance-2026-08-25.jsonl",
    { minimumMessages: 25 },
  );

  assert.equal(report.accepted_for_public_replay, true);
  assert.equal(report.accepted_for_depth_frame_replay, true);
  assert.equal(report.accepted_for_depth_session_replay, false);
  assert.equal(report.snapshot_provenance.parsed_snapshots_without_raw, 1);
  assert.equal(
    report.evidence_sha256,
    "99c1ac43c95bb7e1890a6feca7e028ebf3ed0da3e40bcf0568db3279cc232467",
  );
  assert.equal(report.record_count, 34);
  assert.equal(report.counts.public_messages, 27);
  assert.equal(report.counts.public_errors, 0);
  assert.equal(report.counts.public_backoff_transitions, 0);
  assert.equal(report.depth_provenance.legacy_message_records, 0);
  assert.equal(report.depth_provenance.replay_grade_message_records, 27);
  assert.equal(report.depth_provenance.connection_ids.length, 1);
  assert.equal(report.depth_provenance.raw_hash_mismatches, 0);
  assert.equal(report.depth_provenance.raw_payload_mismatches, 0);
  assert.equal(report.depth_provenance.provider_identity_mismatches, 0);
  assert.equal(report.depth_provenance.unattributed_connection_records, 0);
  assert.equal(report.depth_provenance.non_monotonic_receive_times, 0);
  assert.equal(report.replay.order_book_status, "ready");
  assert.equal(report.replay.update_id, 410_738_930_139);
  assert.deepEqual(report.replay.best_bid, ["80770.00", "27.1156"]);
  assert.deepEqual(report.replay.best_ask, ["80781.20", "0.1313"]);
});

test("the frozen observed Testnet depth session proves its exact REST bootstrap", () => {
  const report = verifyBinancePublicEvidence(
    "operations/evidence/GC-002/binance-testnet-depth-session-provenance-2026-08-25.jsonl",
    { minimumMessages: 30 },
  );

  assert.equal(report.accepted_for_public_replay, true);
  assert.equal(report.accepted_for_depth_frame_replay, true);
  assert.equal(report.accepted_for_depth_session_replay, true);
  assert.equal(
    report.evidence_sha256,
    "b6063706916aa5b9ec2784a9b0bb4b4359d47be03f9a6ff2527c89c4522afb07",
  );
  assert.equal(report.record_count, 42);
  assert.equal(report.counts.public_raw_snapshots, 1);
  assert.equal(report.counts.public_snapshots, 1);
  assert.equal(report.counts.public_messages, 34);
  assert.equal(report.counts.public_errors, 0);
  assert.equal(report.counts.public_backoff_transitions, 0);
  assert.equal(report.depth_provenance.replay_grade_message_records, 34);
  assert.equal(report.depth_provenance.connection_ids.length, 1);
  assert.equal(report.snapshot_provenance.raw_snapshot_records, 1);
  assert.equal(report.snapshot_provenance.paired_snapshot_records, 1);
  assert.equal(report.snapshot_provenance.parsed_snapshots_without_raw, 0);
  assert.equal(report.snapshot_provenance.raw_snapshots_without_parsed, 0);
  assert.equal(report.snapshot_provenance.raw_hash_mismatches, 0);
  assert.equal(report.snapshot_provenance.raw_response_parse_failures, 0);
  assert.equal(report.snapshot_provenance.normalized_payload_mismatches, 0);
  assert.equal(report.snapshot_provenance.update_identity_mismatches, 0);
  assert.equal(report.snapshot_provenance.request_identity_mismatches, 0);
  assert.equal(report.snapshot_provenance.non_monotonic_receive_times, 0);
  assert.equal(report.replay.order_book_status, "ready");
  assert.equal(report.replay.update_id, 410_750_276_919);
  assert.deepEqual(report.replay.best_bid, ["80908.80", "32.6939"]);
  assert.deepEqual(report.replay.best_ask, ["80918.70", "2.0324"]);
});

function testEvidencePath(filename: string): string {
  return resolve("artifacts", "tests", filename);
}

function observedDepthDelta(
  updateId: number,
  previousUpdateId: number,
  bids: string[][],
  asks: string[][],
): Record<string, unknown> {
  return {
    e: "depthUpdate",
    E: 1_787_622_187_000 + updateId,
    T: 1_787_622_186_000 + updateId,
    s: "BTCUSDT",
    U: updateId,
    u: updateId,
    pu: previousUpdateId,
    b: bids,
    a: asks,
  };
}

function depthFrame(
  payload: Record<string, unknown>,
  connectionId: string,
  monotonicReceiveNs: string,
) {
  return {
    venue: "BINANCE_USDM" as const,
    instrument: "BTCUSDT",
    channel: "public-depth" as const,
    connection_id: connectionId,
    local_receive_timestamp_ms: 1_787_622_187_500,
    monotonic_receive_ns: monotonicReceiveNs,
    exchange_timestamp_ms: payload.E as number,
    provider_sequence: {
      event_type: payload.e as string,
      event_time_ms: payload.E as number,
      aggregate_trade_id: null,
      first_trade_id: null,
      last_trade_id: null,
      trade_time_ms: null,
      first_update_id: payload.U as number,
      final_update_id: payload.u as number,
      previous_final_update_id: payload.pu as number,
      transaction_time_ms: payload.T as number,
    },
    normalization_version: "binance-usdm-depth-inspection.v1" as const,
    raw_frame: JSON.stringify(payload),
  };
}

function depthSnapshot(
  payload: Record<string, unknown>,
  monotonicReceiveNs: string,
) {
  return {
    venue: "BINANCE_USDM" as const,
    instrument: "BTCUSDT",
    channel: "public-depth" as const,
    transport: "REST" as const,
    method: "GET" as const,
    origin: "https://demo-fapi.binance.com",
    path: "/fapi/v1/depth" as const,
    query: "limit=1000&symbol=BTCUSDT",
    http_status: 200,
    local_receive_timestamp_ms: 1_787_622_187_550,
    monotonic_receive_ns: monotonicReceiveNs,
    normalization_version:
      "binance-usdm-depth-snapshot-inspection.v1" as const,
    raw_response: JSON.stringify({
      ...payload,
      E: 1_787_622_187_050,
      T: 1_787_622_187_040,
    }),
  };
}

function verifyTamperedPublicEvidence(
  path: string,
  originalLines: readonly Record<string, unknown>[],
  mutate: (messages: Record<string, unknown>[]) => void,
) {
  const lines = JSON.parse(JSON.stringify(originalLines)) as Record<string, unknown>[];
  const messages = lines.filter(
    (record) =>
      record.schema_version ===
      "glitch.crypto.binance-usdm-stream-evidence.v2",
  );
  mutate(messages);
  rmSync(path, { force: true });
  appendFileSync(
    path,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    { encoding: "utf8" },
  );
  return verifyBinancePublicEvidence(path, { minimumMessages: 2 });
}

function verifyTamperedSnapshotEvidence(
  path: string,
  originalLines: readonly Record<string, unknown>[],
  mutate: (rawSnapshots: Record<string, unknown>[]) => void,
) {
  const lines = JSON.parse(JSON.stringify(originalLines)) as Record<string, unknown>[];
  const rawSnapshots = lines.filter(
    (record) =>
      record.schema_version ===
      "glitch.crypto.binance-usdm-stream-evidence.v3",
  );
  mutate(rawSnapshots);
  rmSync(path, { force: true });
  appendFileSync(
    path,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    { encoding: "utf8" },
  );
  return verifyBinancePublicEvidence(path, { minimumMessages: 2 });
}
