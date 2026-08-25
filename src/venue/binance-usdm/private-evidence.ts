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
  readBinanceStreamEvidenceJsonl,
  replayBinanceStreamEvidence,
} from "./stream-replay.js";
import type { BinanceStreamEvidenceRecord } from "./stream-evidence.js";

const TESTNET_STREAMS_ORIGIN = "wss://fstream.binancefuture.com";

export interface BinancePrivateEvidenceVerificationOptions {
  minimumPrivateMessages?: number;
}

export interface BinancePrivateEvidenceReport {
  schema_version: "glitch.crypto.binance-usdm-private-evidence-report.v1";
  evidence_sha256: string;
  mutation_authority: false;
  accepted_for_private_replay: boolean;
  rejection_reasons: string[];
  session_ids: string[];
  record_count: number;
  first_recorded_utc: string | null;
  last_recorded_utc: string | null;
  duration_ms: number | null;
  sequence_contiguous: boolean;
  timestamps_monotonic: boolean;
  supervisor_start_observed: boolean;
  supervisor_stop_observed: boolean;
  private_connecting_observed: boolean;
  private_synchronizing_observed: boolean;
  private_running_observed: boolean;
  private_stopped_observed: boolean;
  private_reconciliations: number;
  private_messages: number;
  private_keepalives: number;
  private_errors: number;
  private_backoffs: number;
  replay: {
    stream_expired: boolean;
    last_event_time: number | null;
    last_transaction_time: number | null;
    applied_event_count: number;
    balance_count: number;
    position_count: number;
    order_count: number;
  };
}

export function verifyBinancePrivateEvidence(
  evidencePath: string,
  options: BinancePrivateEvidenceVerificationOptions = {},
): BinancePrivateEvidenceReport {
  const minimumPrivateMessages = boundedPositiveInteger(
    options.minimumPrivateMessages ?? 1,
    1,
    1_000_000,
    "minimum private messages",
  );
  const records = readBinanceStreamEvidenceJsonl(evidencePath);
  const rejectionReasons: string[] = [];
  const sessionIds = [...new Set(records.map((record) => record.session_id))].sort();
  const sequenceContiguous = hasContiguousSequence(records);
  const timestampsMonotonic = hasMonotonicTimestamps(records);
  let supervisorStartObserved = false;
  let supervisorStopObserved = false;
  let privateConnectingObserved = false;
  let privateSynchronizingObserved = false;
  let privateRunningObserved = false;
  let privateStoppedObserved = false;
  let privateReconciliations = 0;
  let privateMessages = 0;
  let privateKeepalives = 0;
  let privateErrors = 0;
  let privateBackoffs = 0;

  for (const record of records) {
    if (record.channel === "supervisor" && record.kind === "transition") {
      const payload = objectValue(record.payload);
      supervisorStartObserved ||=
        payload.action === "start" &&
        payload.private_enabled === true &&
        payload.mutation_authority === false;
      supervisorStopObserved ||= payload.action === "stop";
      continue;
    }
    if (record.channel === "public-depth") {
      continue;
    }
    if (record.channel !== "private-user") {
      rejectionReasons.push(`unexpected_evidence_channel:${record.channel}`);
      continue;
    }
    if (record.kind === "transition") {
      const state = objectValue(record.payload).state;
      privateConnectingObserved ||= state === "connecting";
      privateSynchronizingObserved ||= state === "synchronizing";
      privateRunningObserved ||= state === "running";
      privateStoppedObserved ||= state === "stopped";
      if (state === "backoff") {
        privateBackoffs += 1;
      }
    } else if (record.kind === "reconciliation") {
      privateReconciliations += 1;
    } else if (record.kind === "message") {
      privateMessages += 1;
    } else if (record.kind === "keepalive") {
      privateKeepalives += 1;
    } else if (record.kind === "error") {
      privateErrors += 1;
    } else {
      rejectionReasons.push(`unexpected_private_record_kind:${record.kind}`);
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
  if (!supervisorStartObserved || !supervisorStopObserved) {
    rejectionReasons.push("supervisor_lifecycle_incomplete");
  }
  if (
    !privateConnectingObserved ||
    !privateSynchronizingObserved ||
    !privateRunningObserved ||
    !privateStoppedObserved
  ) {
    rejectionReasons.push("private_lifecycle_incomplete");
  }
  if (privateReconciliations < 1) {
    rejectionReasons.push("private_reconciliation_not_observed");
  }
  if (privateMessages < minimumPrivateMessages) {
    rejectionReasons.push(
      `private_message_count_below_minimum:${privateMessages}<${minimumPrivateMessages}`,
    );
  }
  if (privateErrors > 0) {
    rejectionReasons.push(`private_errors_observed:${privateErrors}`);
  }
  if (privateBackoffs > 0) {
    rejectionReasons.push(`private_backoff_observed:${privateBackoffs}`);
  }

  let replay: ReturnType<typeof replayBinanceStreamEvidence> | null = null;
  try {
    replay = replayBinanceStreamEvidence(records);
    if (replay.private_account.stream_expired) {
      rejectionReasons.push("private_stream_expired");
    }
    if (replay.private_account.last_transaction_time === null) {
      rejectionReasons.push("private_replay_missing_transaction_time");
    }
    if (replay.private_account.applied_event_count < minimumPrivateMessages) {
      rejectionReasons.push(
        `private_applied_event_count_below_minimum:${replay.private_account.applied_event_count}<${minimumPrivateMessages}`,
      );
    }
    if (replay.private_account.applied_event_count !== privateMessages) {
      rejectionReasons.push(
        `private_messages_not_fully_applied:${replay.private_account.applied_event_count}!=${privateMessages}`,
      );
    }
  } catch (error) {
    rejectionReasons.push(
      `private_replay_failed:${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const account = replay?.private_account;
  const firstRecordedUtc = records[0]?.recorded_utc ?? null;
  const lastRecordedUtc = records.at(-1)?.recorded_utc ?? null;
  return {
    schema_version: "glitch.crypto.binance-usdm-private-evidence-report.v1",
    evidence_sha256: evidenceSha256(evidencePath),
    mutation_authority: false,
    accepted_for_private_replay: rejectionReasons.length === 0,
    rejection_reasons: [...new Set(rejectionReasons)],
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
    supervisor_start_observed: supervisorStartObserved,
    supervisor_stop_observed: supervisorStopObserved,
    private_connecting_observed: privateConnectingObserved,
    private_synchronizing_observed: privateSynchronizingObserved,
    private_running_observed: privateRunningObserved,
    private_stopped_observed: privateStoppedObserved,
    private_reconciliations: privateReconciliations,
    private_messages: privateMessages,
    private_keepalives: privateKeepalives,
    private_errors: privateErrors,
    private_backoffs: privateBackoffs,
    replay: {
      stream_expired: account?.stream_expired ?? true,
      last_event_time: account?.last_event_time ?? null,
      last_transaction_time: account?.last_transaction_time ?? null,
      applied_event_count: account?.applied_event_count ?? 0,
      balance_count: account?.balances.length ?? 0,
      position_count: account?.positions.length ?? 0,
      order_count: account?.orders.length ?? 0,
    },
  };
}

export function writeBinancePrivateEvidenceManifest(
  evidencePath: string,
  manifestPath = `${evidencePath}.manifest.json`,
  options: BinancePrivateEvidenceVerificationOptions = {},
): BinancePrivateEvidenceReport {
  const report = verifyBinancePrivateEvidence(evidencePath, options);
  mkdirSync(dirname(manifestPath), { recursive: true });
  rmSync(manifestPath, { force: true });
  appendFileSync(manifestPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
  });
  return report;
}

export function requireBinanceUsdmTestnetStreamsOrigin(value: string): string {
  const parsed = new URL(value);
  const loopback =
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "::1" ||
    parsed.hostname === "[::1]" ||
    parsed.hostname === "localhost";
  if (parsed.origin !== TESTNET_STREAMS_ORIGIN && !loopback) {
    throw new Error(
      "Binance private evidence capture requires Futures Testnet streams or loopback",
    );
  }
  return parsed.origin;
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
