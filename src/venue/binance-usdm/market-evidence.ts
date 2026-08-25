import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname } from "node:path";
import { inspectBinanceMarketEvent } from "./market-events.js";
import { readBinanceStreamEvidenceJsonl } from "./stream-replay.js";
import { unwrapBinanceStreamPayload } from "./stream-common.js";
import type {
  BinanceStreamEvidenceRecord,
  BinanceStreamEvidenceRecordV2,
} from "./stream-evidence.js";

export interface BinanceMarketEvidenceVerificationOptions {
  symbol?: string;
  minimumAggregateTrades?: number;
  minimumMarkPrices?: number;
}

export interface BinanceMarketEvidenceReport {
  schema_version: "glitch.crypto.binance-usdm-market-evidence-report.v2";
  evidence_sha256: string;
  mutation_authority: false;
  accepted_for_raw_replay: boolean;
  accepted_for_event_replay: boolean;
  rejection_reasons: string[];
  replay_grade_rejection_reasons: string[];
  session_ids: string[];
  record_count: number;
  first_recorded_utc: string | null;
  last_recorded_utc: string | null;
  duration_ms: number | null;
  sequence_contiguous: boolean;
  timestamps_monotonic: boolean;
  connecting_observed: boolean;
  running_observed: boolean;
  stopped_observed: boolean;
  symbol: string;
  aggregate_trade_messages: number;
  mark_price_messages: number;
  error_records: number;
  backoff_transitions: number;
  invalid_messages: number;
  non_increasing_aggregate_trade_ids: number;
  non_monotonic_event_times: number;
  first_event_time: number | null;
  last_event_time: number | null;
  first_aggregate_trade_id: number | null;
  last_aggregate_trade_id: number | null;
  legacy_message_records: number;
  replay_grade_message_records: number;
  connection_ids: string[];
  raw_hash_mismatches: number;
  raw_payload_mismatches: number;
  provider_identity_mismatches: number;
  unattributed_connection_records: number;
  non_monotonic_receive_times: number;
  first_local_receive_timestamp_ms: number | null;
  last_local_receive_timestamp_ms: number | null;
}

export function verifyBinanceMarketEvidence(
  evidencePath: string,
  options: BinanceMarketEvidenceVerificationOptions = {},
): BinanceMarketEvidenceReport {
  const symbol = (options.symbol ?? "BTCUSDT").trim().toUpperCase();
  if (!/^[A-Z0-9]{5,24}$/.test(symbol)) {
    throw new Error("market evidence symbol is invalid");
  }
  const minimumAggregateTrades = boundedPositiveInteger(
    options.minimumAggregateTrades ?? 10,
    1,
    1_000_000,
    "minimum aggregate trades",
  );
  const minimumMarkPrices = boundedPositiveInteger(
    options.minimumMarkPrices ?? 5,
    1,
    1_000_000,
    "minimum mark prices",
  );
  const records = readBinanceStreamEvidenceJsonl(evidencePath);
  const rejectionReasons: string[] = [];
  const sessionIds = [...new Set(records.map((record) => record.session_id))].sort();
  const sequenceContiguous = hasContiguousSequence(records);
  const timestampsMonotonic = hasMonotonicTimestamps(records);
  let connectingObserved = false;
  let runningObserved = false;
  let stoppedObserved = false;
  let aggregateTradeMessages = 0;
  let markPriceMessages = 0;
  let errorRecords = 0;
  let backoffTransitions = 0;
  let invalidMessages = 0;
  let nonIncreasingAggregateTradeIds = 0;
  let nonMonotonicEventTimes = 0;
  let firstEventTime: number | null = null;
  let lastEventTime: number | null = null;
  let firstAggregateTradeId: number | null = null;
  let lastAggregateTradeId: number | null = null;
  let lastAggregateTradeEventTime: number | null = null;
  let lastMarkPriceEventTime: number | null = null;
  let legacyMessageRecords = 0;
  let replayGradeMessageRecords = 0;
  let rawHashMismatches = 0;
  let rawPayloadMismatches = 0;
  let providerIdentityMismatches = 0;
  let unattributedConnectionRecords = 0;
  let nonMonotonicReceiveTimes = 0;
  let firstLocalReceiveTimestampMs: number | null = null;
  let lastLocalReceiveTimestampMs: number | null = null;
  let lastMonotonicReceiveNs: bigint | null = null;
  const connectionIds = new Set<string>();

  for (const record of records) {
    if (record.channel !== "public-market") {
      rejectionReasons.push(`unexpected_evidence_channel:${record.channel}`);
      continue;
    }
    if (record.kind === "transition") {
      const state = objectValue(record.payload).state;
      connectingObserved ||= state === "connecting";
      runningObserved ||= state === "running";
      stoppedObserved ||= state === "stopped";
      if (state === "backoff") {
        backoffTransitions += 1;
      }
      const connectionId = objectValue(record.payload).connection_id;
      if (typeof connectionId === "string") {
        connectionIds.add(connectionId);
      }
      continue;
    }
    if (record.kind === "error") {
      errorRecords += 1;
      continue;
    }
    if (record.kind !== "message") {
      rejectionReasons.push(`unexpected_market_record_kind:${record.kind}`);
      continue;
    }
    let event: ReturnType<typeof inspectBinanceMarketEvent> | null = null;
    try {
      event = inspectBinanceMarketEvent(record.payload, symbol);
      firstEventTime ??= event.event_time;
      lastEventTime = event.event_time;
      if (event.event_type === "aggTrade") {
        aggregateTradeMessages += 1;
        firstAggregateTradeId ??= event.aggregate_trade_id;
        if (
          lastAggregateTradeId !== null &&
          event.aggregate_trade_id <= lastAggregateTradeId
        ) {
          nonIncreasingAggregateTradeIds += 1;
        }
        if (
          lastAggregateTradeEventTime !== null &&
          event.event_time < lastAggregateTradeEventTime
        ) {
          nonMonotonicEventTimes += 1;
        }
        lastAggregateTradeId = event.aggregate_trade_id;
        lastAggregateTradeEventTime = event.event_time;
      } else {
        markPriceMessages += 1;
        if (
          lastMarkPriceEventTime !== null &&
          event.event_time <= lastMarkPriceEventTime
        ) {
          nonMonotonicEventTimes += 1;
        }
        lastMarkPriceEventTime = event.event_time;
      }
    } catch {
      invalidMessages += 1;
    }
    if (record.schema_version === "glitch.crypto.binance-usdm-stream-evidence.v2") {
      replayGradeMessageRecords += 1;
      const verification = verifyRawMarketRecord(
        record,
        event,
        symbol,
        connectionIds,
        lastMonotonicReceiveNs,
      );
      rawHashMismatches += Number(!verification.hash_matches);
      rawPayloadMismatches += Number(!verification.payload_matches);
      providerIdentityMismatches += Number(!verification.identity_matches);
      unattributedConnectionRecords += Number(!verification.connection_attributed);
      nonMonotonicReceiveTimes += Number(!verification.receive_time_monotonic);
      firstLocalReceiveTimestampMs ??=
        record.provenance.local_receive_timestamp_ms;
      lastLocalReceiveTimestampMs =
        record.provenance.local_receive_timestamp_ms;
      lastMonotonicReceiveNs = BigInt(record.provenance.monotonic_receive_ns);
    } else {
      legacyMessageRecords += 1;
    }
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
  if (!connectingObserved || !runningObserved || !stoppedObserved) {
    rejectionReasons.push("recorder_lifecycle_incomplete");
  }
  if (aggregateTradeMessages < minimumAggregateTrades) {
    rejectionReasons.push(
      `aggregate_trade_count_below_minimum:${aggregateTradeMessages}<${minimumAggregateTrades}`,
    );
  }
  if (markPriceMessages < minimumMarkPrices) {
    rejectionReasons.push(
      `mark_price_count_below_minimum:${markPriceMessages}<${minimumMarkPrices}`,
    );
  }
  if (errorRecords > 0) {
    rejectionReasons.push(`market_errors_observed:${errorRecords}`);
  }
  if (backoffTransitions > 0) {
    rejectionReasons.push(`market_backoff_observed:${backoffTransitions}`);
  }
  if (invalidMessages > 0) {
    rejectionReasons.push(`invalid_market_messages:${invalidMessages}`);
  }
  if (nonIncreasingAggregateTradeIds > 0) {
    rejectionReasons.push(
      `non_increasing_aggregate_trade_ids:${nonIncreasingAggregateTradeIds}`,
    );
  }
  if (nonMonotonicEventTimes > 0) {
    rejectionReasons.push(`non_monotonic_event_times:${nonMonotonicEventTimes}`);
  }
  if (rawHashMismatches > 0) {
    rejectionReasons.push(`raw_frame_hash_mismatches:${rawHashMismatches}`);
  }
  if (rawPayloadMismatches > 0) {
    rejectionReasons.push(`raw_frame_payload_mismatches:${rawPayloadMismatches}`);
  }
  if (providerIdentityMismatches > 0) {
    rejectionReasons.push(
      `raw_frame_provider_identity_mismatches:${providerIdentityMismatches}`,
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

  const replayGradeRejectionReasons: string[] = [];
  if (legacyMessageRecords > 0) {
    replayGradeRejectionReasons.push(
      `legacy_message_records:${legacyMessageRecords}`,
    );
  }
  if (replayGradeMessageRecords === 0) {
    replayGradeRejectionReasons.push("replay_grade_message_records_missing");
  }
  replayGradeRejectionReasons.push(
    ...rejectionReasons.filter((reason) =>
      reason.startsWith("raw_frame_") ||
      reason.startsWith("unattributed_connection_") ||
      reason.startsWith("non_monotonic_receive_"),
    ),
  );

  const firstRecordedUtc = records[0]?.recorded_utc ?? null;
  const lastRecordedUtc = records.at(-1)?.recorded_utc ?? null;
  const acceptedForRawReplay = rejectionReasons.length === 0;
  return {
    schema_version: "glitch.crypto.binance-usdm-market-evidence-report.v2",
    evidence_sha256: evidenceSha256(evidencePath),
    mutation_authority: false,
    accepted_for_raw_replay: acceptedForRawReplay,
    accepted_for_event_replay:
      acceptedForRawReplay && replayGradeRejectionReasons.length === 0,
    rejection_reasons: [...new Set(rejectionReasons)],
    replay_grade_rejection_reasons: [
      ...new Set(replayGradeRejectionReasons),
    ],
    session_ids: sessionIds,
    record_count: records.length,
    first_recorded_utc: firstRecordedUtc,
    last_recorded_utc: lastRecordedUtc,
    duration_ms:
      firstRecordedUtc && lastRecordedUtc
        ? Date.parse(lastRecordedUtc) - Date.parse(firstRecordedUtc)
        : null,
    sequence_contiguous: sequenceContiguous,
    timestamps_monotonic: timestampsMonotonic,
    connecting_observed: connectingObserved,
    running_observed: runningObserved,
    stopped_observed: stoppedObserved,
    symbol,
    aggregate_trade_messages: aggregateTradeMessages,
    mark_price_messages: markPriceMessages,
    error_records: errorRecords,
    backoff_transitions: backoffTransitions,
    invalid_messages: invalidMessages,
    non_increasing_aggregate_trade_ids: nonIncreasingAggregateTradeIds,
    non_monotonic_event_times: nonMonotonicEventTimes,
    first_event_time: firstEventTime,
    last_event_time: lastEventTime,
    first_aggregate_trade_id: firstAggregateTradeId,
    last_aggregate_trade_id: lastAggregateTradeId,
    legacy_message_records: legacyMessageRecords,
    replay_grade_message_records: replayGradeMessageRecords,
    connection_ids: [...connectionIds].sort(),
    raw_hash_mismatches: rawHashMismatches,
    raw_payload_mismatches: rawPayloadMismatches,
    provider_identity_mismatches: providerIdentityMismatches,
    unattributed_connection_records: unattributedConnectionRecords,
    non_monotonic_receive_times: nonMonotonicReceiveTimes,
    first_local_receive_timestamp_ms: firstLocalReceiveTimestampMs,
    last_local_receive_timestamp_ms: lastLocalReceiveTimestampMs,
  };
}

export function writeBinanceMarketEvidenceManifest(
  evidencePath: string,
  manifestPath = `${evidencePath}.manifest.json`,
  options: BinanceMarketEvidenceVerificationOptions = {},
): BinanceMarketEvidenceReport {
  const report = verifyBinanceMarketEvidence(evidencePath, options);
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
    hash.update(readFileSync(candidate, "utf8").replace(/\r\n?/g, "\n"));
  }
  return hash.digest("hex");
}

function hasContiguousSequence(
  records: readonly BinanceStreamEvidenceRecord[],
): boolean {
  if (records.length === 0) {
    return false;
  }
  const session = records[0]?.session_id;
  return records.every(
    (record, index) =>
      record.session_id === session && record.sequence === index + 1,
  );
}

function hasMonotonicTimestamps(
  records: readonly BinanceStreamEvidenceRecord[],
): boolean {
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

function verifyRawMarketRecord(
  record: BinanceStreamEvidenceRecordV2,
  event: ReturnType<typeof inspectBinanceMarketEvent> | null,
  symbol: string,
  connectionIds: ReadonlySet<string>,
  previousMonotonicReceiveNs: bigint | null,
): {
  hash_matches: boolean;
  payload_matches: boolean;
  identity_matches: boolean;
  connection_attributed: boolean;
  receive_time_monotonic: boolean;
} {
  const provenance = record.provenance;
  const hashMatches = createHash("sha256")
    .update(provenance.raw_frame)
    .digest("hex") === provenance.raw_frame_sha256;
  let payloadMatches = false;
  try {
    payloadMatches = JSON.stringify(
      unwrapBinanceStreamPayload(provenance.raw_frame),
    ) === JSON.stringify(record.payload);
  } catch {
    payloadMatches = record.payload === null;
  }
  const identityMatches = event === null
    ? provenance.exchange_timestamp_ms === null &&
      provenance.provider_sequence.event_type === null
    : rawIdentityMatches(record, event, symbol);
  const monotonic = BigInt(provenance.monotonic_receive_ns);
  return {
    hash_matches: hashMatches,
    payload_matches: payloadMatches,
    identity_matches: identityMatches,
    connection_attributed: connectionIds.has(provenance.connection_id),
    receive_time_monotonic:
      previousMonotonicReceiveNs === null ||
      monotonic > previousMonotonicReceiveNs,
  };
}

function rawIdentityMatches(
  record: BinanceStreamEvidenceRecordV2,
  event: ReturnType<typeof inspectBinanceMarketEvent>,
  symbol: string,
): boolean {
  const provenance = record.provenance;
  const sequence = provenance.provider_sequence;
  if (
    provenance.venue !== "BINANCE_USDM" ||
    provenance.channel !== "public-market" ||
    provenance.instrument !== symbol ||
    provenance.normalization_version !==
      "binance-usdm-market-inspection.v1" ||
    provenance.exchange_timestamp_ms !== event.event_time ||
    sequence.event_type !== event.event_type ||
    sequence.event_time_ms !== event.event_time
  ) {
    return false;
  }
  if (event.event_type === "aggTrade") {
    return sequence.aggregate_trade_id === event.aggregate_trade_id &&
      sequence.first_trade_id === event.first_trade_id &&
      sequence.last_trade_id === event.last_trade_id &&
      sequence.trade_time_ms === event.trade_time;
  }
  return sequence.aggregate_trade_id === null &&
    sequence.first_trade_id === null &&
    sequence.last_trade_id === null &&
    sequence.trade_time_ms === null;
}
