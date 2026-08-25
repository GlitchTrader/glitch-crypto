import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  parseBinanceDepthDelta,
  type BinanceDepthDelta,
} from "./order-book.js";
import { verifyBinanceRawFrame } from "./raw-frame-evidence.js";
import {
  readBinanceStreamEvidenceJsonl,
  replayBinanceStreamEvidence,
} from "./stream-replay.js";
import type {
  BinanceStreamEvidenceRecord,
  BinanceStreamEvidenceRecordV2,
} from "./stream-evidence.js";

export interface BinancePublicEvidenceCounts {
  supervisor_transitions: number;
  public_transitions: number;
  public_snapshots: number;
  public_messages: number;
  public_errors: number;
  public_backoff_transitions: number;
  private_records: number;
  other_records: number;
}

export interface BinancePublicEvidenceReport {
  schema_version: "glitch.crypto.binance-usdm-public-evidence-report.v2";
  evidence_sha256: string;
  mutation_authority: false;
  accepted_for_public_replay: boolean;
  accepted_for_depth_frame_replay: boolean;
  rejection_reasons: string[];
  depth_frame_rejection_reasons: string[];
  warnings: string[];
  session_ids: string[];
  record_count: number;
  first_recorded_utc: string | null;
  last_recorded_utc: string | null;
  duration_ms: number | null;
  sequence_contiguous: boolean;
  timestamps_monotonic: boolean;
  supervisor_start_observed: boolean;
  supervisor_stop_observed: boolean;
  public_running_observed: boolean;
  counts: BinancePublicEvidenceCounts;
  depth_provenance: {
    legacy_message_records: number;
    replay_grade_message_records: number;
    connection_ids: string[];
    raw_hash_mismatches: number;
    raw_payload_mismatches: number;
    provider_identity_mismatches: number;
    unattributed_connection_records: number;
    non_monotonic_receive_times: number;
  };
  replay: {
    processed_records: number;
    ignored_records: number;
    order_book_status: string;
    symbol: string | null;
    update_id: number | null;
    best_bid: readonly [string, string] | null;
    best_ask: readonly [string, string] | null;
    gap_reason: string | null;
  };
}

export interface BinancePublicEvidenceVerificationOptions {
  minimumMessages?: number;
}

export function verifyBinancePublicEvidence(
  evidencePath: string,
  options: BinancePublicEvidenceVerificationOptions = {},
): BinancePublicEvidenceReport {
  const minimumMessages = boundedPositiveInteger(
    options.minimumMessages ?? 10,
    1,
    1_000_000,
    "minimum public messages",
  );
  const records = readBinanceStreamEvidenceJsonl(evidencePath);
  const rejectionReasons: string[] = [];
  const warnings: string[] = [];
  const counts: BinancePublicEvidenceCounts = {
    supervisor_transitions: 0,
    public_transitions: 0,
    public_snapshots: 0,
    public_messages: 0,
    public_errors: 0,
    public_backoff_transitions: 0,
    private_records: 0,
    other_records: 0,
  };
  const sessionIds = [...new Set(records.map((record) => record.session_id))].sort();
  const sequenceContiguous = hasContiguousSequence(records);
  const timestampsMonotonic = hasMonotonicTimestamps(records);
  let supervisorStartObserved = false;
  let supervisorStopObserved = false;
  let publicRunningObserved = false;
  let expectedSymbol: string | null = null;
  let legacyMessageRecords = 0;
  let replayGradeMessageRecords = 0;
  let rawHashMismatches = 0;
  let rawPayloadMismatches = 0;
  let providerIdentityMismatches = 0;
  let unattributedConnectionRecords = 0;
  let nonMonotonicReceiveTimes = 0;
  let lastMonotonicReceiveNs: bigint | null = null;
  const connectionIds = new Set<string>();

  for (const record of records) {
    if (record.channel === "supervisor" && record.kind === "transition") {
      counts.supervisor_transitions += 1;
      const payload = objectValue(record.payload);
      if (payload.action === "start" && payload.mutation_authority === false) {
        supervisorStartObserved = true;
        if (typeof payload.symbol === "string") {
          expectedSymbol = payload.symbol;
        }
      }
      if (payload.action === "stop") {
        supervisorStopObserved = true;
      }
      continue;
    }
    if (record.channel === "public-depth") {
      if (record.kind === "transition") {
        counts.public_transitions += 1;
        const payload = objectValue(record.payload);
        if (payload.state === "running") {
          publicRunningObserved = true;
        }
        if (payload.state === "backoff") {
          counts.public_backoff_transitions += 1;
        }
        if (typeof payload.connection_id === "string") {
          connectionIds.add(payload.connection_id);
        }
      } else if (record.kind === "snapshot") {
        counts.public_snapshots += 1;
      } else if (record.kind === "message") {
        counts.public_messages += 1;
        if (
          record.schema_version ===
            "glitch.crypto.binance-usdm-stream-evidence.v2"
        ) {
          replayGradeMessageRecords += 1;
          const raw = verifyBinanceRawFrame(
            record,
            {
              channel: "public-depth",
              instrument: expectedSymbol ?? record.provenance.instrument,
              normalization_version: "binance-usdm-depth-inspection.v1",
            },
            connectionIds,
            lastMonotonicReceiveNs,
          );
          let identityMatches = false;
          try {
            identityMatches = depthIdentityMatches(
              record,
              parseBinanceDepthDelta(record.payload),
              expectedSymbol,
            );
          } catch {
            identityMatches =
              record.payload === null &&
              record.provenance.exchange_timestamp_ms === null &&
              record.provenance.provider_sequence.event_type === null;
          }
          rawHashMismatches += Number(!raw.hash_matches);
          rawPayloadMismatches += Number(!raw.payload_matches);
          providerIdentityMismatches += Number(
            !raw.authority_matches || !identityMatches,
          );
          unattributedConnectionRecords += Number(!raw.connection_attributed);
          nonMonotonicReceiveTimes += Number(!raw.receive_time_monotonic);
          lastMonotonicReceiveNs = BigInt(
            record.provenance.monotonic_receive_ns,
          );
        } else {
          legacyMessageRecords += 1;
        }
      } else if (record.kind === "error") {
        counts.public_errors += 1;
      } else {
        counts.other_records += 1;
      }
      continue;
    }
    if (record.channel === "private-user") {
      counts.private_records += 1;
      continue;
    }
    counts.other_records += 1;
  }

  if (records.length === 0) {
    rejectionReasons.push("evidence_empty");
  }
  if (sessionIds.length !== 1) {
    rejectionReasons.push("evidence_must_contain_exactly_one_session");
  }
  if (!sequenceContiguous) {
    rejectionReasons.push("evidence_sequence_not_contiguous");
  }
  if (!timestampsMonotonic) {
    rejectionReasons.push("evidence_timestamps_not_monotonic");
  }
  if (!supervisorStartObserved) {
    rejectionReasons.push("supervisor_start_not_observed");
  }
  if (!supervisorStopObserved) {
    rejectionReasons.push("supervisor_stop_not_observed");
  }
  if (!publicRunningObserved) {
    rejectionReasons.push("public_running_state_not_observed");
  }
  if (counts.public_snapshots < 1) {
    rejectionReasons.push("public_snapshot_not_observed");
  }
  if (counts.public_messages < minimumMessages) {
    rejectionReasons.push(
      `public_message_count_below_minimum:${counts.public_messages}<${minimumMessages}`,
    );
  }
  if (counts.private_records > 0) {
    rejectionReasons.push("public_fixture_contains_private_records");
  }
  if (counts.public_errors > 0) {
    warnings.push(`public_errors_observed:${counts.public_errors}`);
  }
  if (rawHashMismatches > 0) {
    rejectionReasons.push(`raw_frame_hash_mismatches:${rawHashMismatches}`);
  }
  if (rawPayloadMismatches > 0) {
    rejectionReasons.push(`raw_frame_payload_mismatches:${rawPayloadMismatches}`);
  }
  if (providerIdentityMismatches > 0) {
    rejectionReasons.push(
      `depth_provider_identity_mismatches:${providerIdentityMismatches}`,
    );
  }
  if (unattributedConnectionRecords > 0) {
    rejectionReasons.push(
      `unattributed_connection_records:${unattributedConnectionRecords}`,
    );
  }
  if (nonMonotonicReceiveTimes > 0) {
    rejectionReasons.push(
      `non_monotonic_receive_times:${nonMonotonicReceiveTimes}`,
    );
  }

  let replay: ReturnType<typeof replayBinanceStreamEvidence> | null = null;
  try {
    replay = replayBinanceStreamEvidence(records);
    if (replay.public_order_book.status !== "ready") {
      rejectionReasons.push(
        `public_order_book_not_ready:${replay.public_order_book.status}`,
      );
    }
    if (replay.public_order_book.best_bid === null || replay.public_order_book.best_ask === null) {
      rejectionReasons.push("public_order_book_missing_top_of_book");
    } else if (
      Number(replay.public_order_book.best_bid[0]) >=
      Number(replay.public_order_book.best_ask[0])
    ) {
      rejectionReasons.push("public_order_book_crossed_or_locked");
    }
  } catch (error) {
    rejectionReasons.push(
      `public_replay_failed:${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const firstRecordedUtc = records[0]?.recorded_utc ?? null;
  const lastRecordedUtc = records.at(-1)?.recorded_utc ?? null;
  const durationMs = firstRecordedUtc && lastRecordedUtc
    ? Date.parse(lastRecordedUtc) - Date.parse(firstRecordedUtc)
    : null;
  const orderBook = replay?.public_order_book;
  const acceptedForPublicReplay = rejectionReasons.length === 0;
  const depthFrameRejectionReasons: string[] = [];
  if (legacyMessageRecords > 0) {
    depthFrameRejectionReasons.push(
      `legacy_depth_message_records:${legacyMessageRecords}`,
    );
  }
  if (replayGradeMessageRecords === 0) {
    depthFrameRejectionReasons.push("replay_grade_depth_messages_missing");
  }
  if (expectedSymbol === null) {
    depthFrameRejectionReasons.push("public_symbol_not_observed");
  }
  if (counts.public_errors > 0) {
    depthFrameRejectionReasons.push(
      `public_errors_observed:${counts.public_errors}`,
    );
  }
  if (counts.public_backoff_transitions > 0) {
    depthFrameRejectionReasons.push(
      `public_backoff_observed:${counts.public_backoff_transitions}`,
    );
  }
  depthFrameRejectionReasons.push(
    ...rejectionReasons.filter((reason) =>
      reason.startsWith("raw_frame_") ||
      reason.startsWith("depth_provider_") ||
      reason.startsWith("unattributed_connection_") ||
      reason.startsWith("non_monotonic_receive_"),
    ),
  );

  return {
    schema_version: "glitch.crypto.binance-usdm-public-evidence-report.v2",
    evidence_sha256: evidenceSha256(evidencePath),
    mutation_authority: false,
    accepted_for_public_replay: acceptedForPublicReplay,
    accepted_for_depth_frame_replay:
      acceptedForPublicReplay && depthFrameRejectionReasons.length === 0,
    rejection_reasons: rejectionReasons,
    depth_frame_rejection_reasons: [
      ...new Set(depthFrameRejectionReasons),
    ],
    warnings,
    session_ids: sessionIds,
    record_count: records.length,
    first_recorded_utc: firstRecordedUtc,
    last_recorded_utc: lastRecordedUtc,
    duration_ms: durationMs,
    sequence_contiguous: sequenceContiguous,
    timestamps_monotonic: timestampsMonotonic,
    supervisor_start_observed: supervisorStartObserved,
    supervisor_stop_observed: supervisorStopObserved,
    public_running_observed: publicRunningObserved,
    counts,
    depth_provenance: {
      legacy_message_records: legacyMessageRecords,
      replay_grade_message_records: replayGradeMessageRecords,
      connection_ids: [...connectionIds].sort(),
      raw_hash_mismatches: rawHashMismatches,
      raw_payload_mismatches: rawPayloadMismatches,
      provider_identity_mismatches: providerIdentityMismatches,
      unattributed_connection_records: unattributedConnectionRecords,
      non_monotonic_receive_times: nonMonotonicReceiveTimes,
    },
    replay: {
      processed_records: replay?.processed_records ?? 0,
      ignored_records: replay?.ignored_records ?? 0,
      order_book_status: orderBook?.status ?? "unavailable",
      symbol: orderBook?.symbol ?? null,
      update_id: orderBook?.update_id ?? null,
      best_bid: orderBook?.best_bid ?? null,
      best_ask: orderBook?.best_ask ?? null,
      gap_reason: orderBook?.gap_reason ?? null,
    },
  };
}

export function writeBinancePublicEvidenceManifest(
  evidencePath: string,
  manifestPath = `${evidencePath}.manifest.json`,
  options: BinancePublicEvidenceVerificationOptions = {},
): BinancePublicEvidenceReport {
  const report = verifyBinancePublicEvidence(evidencePath, options);
  mkdirSync(dirname(manifestPath), { recursive: true });
  rmSync(manifestPath, { force: true });
  appendFileSync(manifestPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
  });
  return report;
}

function evidenceSha256(path: string): string {
  const hash = createHash("sha256");
  for (const candidate of [`${path}.1`, path]) {
    if (!existsSync(candidate)) {
      continue;
    }
    hash.update(`${candidate.endsWith(".1") ? "backup" : "current"}\n`);
    // Git may materialize text fixtures with platform line endings. Hash the
    // canonical JSONL text so one observed session has one portable identity.
    hash.update(readFileSync(candidate, "utf8").replace(/\r\n?/g, "\n"));
  }
  return hash.digest("hex");
}

function hasContiguousSequence(records: readonly BinanceStreamEvidenceRecord[]): boolean {
  if (records.length === 0) {
    return false;
  }
  const session = records[0]?.session_id;
  return records.every(
    (record, index) =>
      record.session_id === session && record.sequence === index + 1,
  );
}

function hasMonotonicTimestamps(records: readonly BinanceStreamEvidenceRecord[]): boolean {
  let previous = Number.NEGATIVE_INFINITY;
  for (const record of records) {
    const current = Date.parse(record.recorded_utc);
    if (!Number.isFinite(current) || current < previous) {
      return false;
    }
    previous = current;
  }
  return records.length > 0;
}

function boundedPositiveInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function depthIdentityMatches(
  record: BinanceStreamEvidenceRecordV2,
  delta: BinanceDepthDelta,
  expectedSymbol: string | null,
): boolean {
  const provenance = record.provenance;
  const sequence = provenance.provider_sequence;
  return (
    sequence.event_type === "depthUpdate" &&
    (expectedSymbol === null || delta.s === expectedSymbol) &&
    provenance.exchange_timestamp_ms === (delta.E ?? null) &&
    sequence.event_time_ms === (delta.E ?? null) &&
    sequence.first_update_id === delta.U &&
    sequence.final_update_id === delta.u &&
    sequence.previous_final_update_id === (delta.pu ?? null) &&
    sequence.transaction_time_ms === (delta.T ?? null) &&
    sequence.aggregate_trade_id === null &&
    sequence.first_trade_id === null &&
    sequence.last_trade_id === null &&
    sequence.trade_time_ms === null
  );
}
