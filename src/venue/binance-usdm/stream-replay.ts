import { existsSync, readFileSync } from "node:fs";
import {
  BinanceUsdmOrderBook,
  parseBinanceDepthDelta,
  parseBinanceDepthSnapshot,
  type BinanceOrderBookView,
} from "./order-book.js";
import {
  BinanceUsdmPrivateState,
  type BinancePrivateStateView,
} from "./private-state.js";
import type { BinanceStreamEvidenceRecord } from "./stream-evidence.js";

const backwardCompatibleDepthSequenceKeys = new Set([
  "first_update_id",
  "final_update_id",
  "previous_final_update_id",
  "transaction_time_ms",
]);

export interface BinanceStreamReplayResult {
  schema_version: "glitch.crypto.binance-usdm-stream-replay.v1";
  processed_records: number;
  ignored_records: number;
  public_order_book: BinanceOrderBookView;
  private_account: BinancePrivateStateView;
}

export function replayBinanceStreamEvidence(
  records: readonly BinanceStreamEvidenceRecord[],
): BinanceStreamReplayResult {
  const orderBook = new BinanceUsdmOrderBook();
  const privateState = new BinanceUsdmPrivateState();
  let processed = 0;
  let ignored = 0;
  let privateSynchronized = false;
  let privateBuffer: unknown[] = [];

  for (const record of records) {
    if (
      record.schema_version !== "glitch.crypto.binance-usdm-stream-evidence.v1" &&
      record.schema_version !== "glitch.crypto.binance-usdm-stream-evidence.v2"
    ) {
      throw new Error("unsupported Binance stream evidence schema");
    }
    if (record.channel === "public-depth" && record.kind === "transition") {
      const transition = objectValue(record.payload, "public transition evidence");
      if (transition.state === "connecting" || transition.state === "backoff") {
        orderBook.reset();
      }
      ignored += 1;
      continue;
    }
    if (record.channel === "public-depth" && record.kind === "snapshot") {
      orderBook.loadSnapshot(parseBinanceDepthSnapshot(record.payload));
      processed += 1;
      continue;
    }
    if (record.channel === "public-depth" && record.kind === "message") {
      orderBook.ingest(parseBinanceDepthDelta(record.payload));
      processed += 1;
      continue;
    }
    if (record.channel === "private-user" && record.kind === "transition") {
      const transition = objectValue(record.payload, "private transition evidence");
      if (transition.state === "connecting" || transition.state === "synchronizing" || transition.state === "backoff") {
        privateSynchronized = false;
        privateBuffer = [];
      }
      ignored += 1;
      continue;
    }
    if (record.channel === "private-user" && record.kind === "reconciliation") {
      const payload = objectValue(record.payload, "private reconciliation evidence");
      privateState.reconcile({
        balances: payload.balances,
        positions: payload.positions,
        openOrders: payload.openOrders,
        observedAt: integerOrUndefined(payload.observedAt),
      });
      for (const buffered of privateBuffer) {
        privateState.apply(buffered);
      }
      privateBuffer = [];
      privateSynchronized = true;
      processed += 1;
      continue;
    }
    if (record.channel === "private-user" && record.kind === "message") {
      if (privateSynchronized) {
        privateState.apply(record.payload);
      } else {
        privateBuffer.push(record.payload);
      }
      processed += 1;
      continue;
    }
    ignored += 1;
  }

  return {
    schema_version: "glitch.crypto.binance-usdm-stream-replay.v1",
    processed_records: processed,
    ignored_records: ignored,
    public_order_book: orderBook.view(),
    private_account: privateState.view(),
  };
}

export function readBinanceStreamEvidenceJsonl(path: string): BinanceStreamEvidenceRecord[] {
  const paths = [`${path}.1`, path].filter((candidate) => existsSync(candidate));
  let absoluteLine = 0;
  return paths.flatMap((candidate) =>
    readFileSync(candidate, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        absoluteLine += 1;
        let value: unknown;
        try {
          value = JSON.parse(line) as unknown;
        } catch {
          throw new Error(`invalid JSON at evidence line ${absoluteLine}`);
        }
        return parseRecord(value, absoluteLine);
      }),
  );
}

function parseRecord(value: unknown, line: number): BinanceStreamEvidenceRecord {
  const record = objectValue(value, `evidence line ${line}`);
  if (
    record.schema_version !== "glitch.crypto.binance-usdm-stream-evidence.v1" &&
    record.schema_version !== "glitch.crypto.binance-usdm-stream-evidence.v2"
  ) {
    throw new Error(`unsupported evidence schema at line ${line}`);
  }
  if (typeof record.session_id !== "string" || record.session_id.length < 8) {
    throw new Error(`invalid evidence session ID at line ${line}`);
  }
  if (!Number.isSafeInteger(record.sequence) || (record.sequence as number) <= 0) {
    throw new Error(`invalid evidence sequence at line ${line}`);
  }
  if (typeof record.recorded_utc !== "string" || Number.isNaN(Date.parse(record.recorded_utc))) {
    throw new Error(`invalid evidence timestamp at line ${line}`);
  }
  if (!new Set(["public-depth", "public-market", "private-user", "supervisor"]).has(String(record.channel))) {
    throw new Error(`invalid evidence channel at line ${line}`);
  }
  if (!new Set(["message", "snapshot", "reconciliation", "transition", "keepalive", "error"]).has(String(record.kind))) {
    throw new Error(`invalid evidence kind at line ${line}`);
  }
  if (record.schema_version === "glitch.crypto.binance-usdm-stream-evidence.v2") {
    validateRawFrameRecord(record, line);
  }
  return record as unknown as BinanceStreamEvidenceRecord;
}

function validateRawFrameRecord(
  record: Record<string, unknown>,
  line: number,
): void {
  if (
    !new Set(["public-market", "public-depth"]).has(String(record.channel)) ||
    record.kind !== "message"
  ) {
    throw new Error(`invalid version-2 evidence authority at line ${line}`);
  }
  const provenance = objectValue(
    record.provenance,
    `version-2 provenance at line ${line}`,
  );
  if (
    provenance.venue !== "BINANCE_USDM" ||
    provenance.channel !== record.channel ||
    typeof provenance.instrument !== "string" ||
    !/^[A-Z0-9]{5,24}$/.test(provenance.instrument) ||
    typeof provenance.connection_id !== "string" ||
    !/^[A-Za-z0-9:_-]{8,128}$/.test(provenance.connection_id) ||
    !Number.isSafeInteger(provenance.local_receive_timestamp_ms) ||
    (provenance.local_receive_timestamp_ms as number) <= 0 ||
    typeof provenance.monotonic_receive_ns !== "string" ||
    !/^[1-9]\d*$/.test(provenance.monotonic_receive_ns) ||
    provenance.normalization_version !== (
      record.channel === "public-market"
        ? "binance-usdm-market-inspection.v1"
        : "binance-usdm-depth-inspection.v1"
    ) ||
    typeof provenance.raw_frame !== "string" ||
    provenance.raw_frame.length === 0 ||
    !/^[a-f0-9]{64}$/.test(String(provenance.raw_frame_sha256))
  ) {
    throw new Error(`invalid version-2 provenance at line ${line}`);
  }
  if (
    provenance.exchange_timestamp_ms !== null &&
    (!Number.isSafeInteger(provenance.exchange_timestamp_ms) ||
      (provenance.exchange_timestamp_ms as number) <= 0)
  ) {
    throw new Error(`invalid version-2 exchange timestamp at line ${line}`);
  }
  const providerSequence = objectValue(
    provenance.provider_sequence,
    `version-2 provider sequence at line ${line}`,
  );
  for (const key of [
    "event_time_ms",
    "aggregate_trade_id",
    "first_trade_id",
    "last_trade_id",
    "trade_time_ms",
    "first_update_id",
    "final_update_id",
    "previous_final_update_id",
    "transaction_time_ms",
  ]) {
    const value = providerSequence[key];
    if (
      value === undefined &&
      backwardCompatibleDepthSequenceKeys.has(key)
    ) {
      continue;
    }
    if (
      value !== null &&
      (!Number.isSafeInteger(value) || (value as number) < 0)
    ) {
      throw new Error(`invalid version-2 provider sequence at line ${line}`);
    }
  }
  if (
    providerSequence.event_type !== null &&
    typeof providerSequence.event_type !== "string"
  ) {
    throw new Error(`invalid version-2 provider event type at line ${line}`);
  }
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function integerOrUndefined(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error("private reconciliation observedAt must be a positive safe integer");
  }
  return value as number;
}
