import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  assertProviderEvidenceIsSecretFree,
  redactProviderEvidence,
} from "./redaction.js";

export type BinanceStreamEvidenceChannel =
  | "public-depth"
  | "public-market"
  | "private-user"
  | "supervisor";

export type BinanceStreamEvidenceKind =
  | "message"
  | "snapshot"
  | "reconciliation"
  | "transition"
  | "keepalive"
  | "error";

interface BinanceStreamEvidenceRecordBase {
  session_id: string;
  sequence: number;
  recorded_utc: string;
  channel: BinanceStreamEvidenceChannel;
  kind: BinanceStreamEvidenceKind;
  payload: unknown;
}

export interface BinanceStreamEvidenceRecordV1
  extends BinanceStreamEvidenceRecordBase {
  schema_version: "glitch.crypto.binance-usdm-stream-evidence.v1";
}

export type BinanceRawFrameChannel = "public-market" | "public-depth";

export type BinanceRawFrameNormalizationVersion =
  | "binance-usdm-market-inspection.v1"
  | "binance-usdm-depth-inspection.v1";

export interface BinanceRawProviderSequence {
  event_type: string | null;
  event_time_ms: number | null;
  aggregate_trade_id: number | null;
  first_trade_id: number | null;
  last_trade_id: number | null;
  trade_time_ms: number | null;
  first_update_id: number | null;
  final_update_id: number | null;
  previous_final_update_id: number | null;
  transaction_time_ms: number | null;
}

interface BinanceRawFrameInputBase {
  venue: "BINANCE_USDM";
  instrument: string;
  channel: BinanceRawFrameChannel;
  connection_id: string;
  local_receive_timestamp_ms: number;
  monotonic_receive_ns: string;
  exchange_timestamp_ms: number | null;
  provider_sequence: BinanceRawProviderSequence;
  normalization_version: BinanceRawFrameNormalizationVersion;
  raw_frame: string;
}

export interface BinanceRawMarketFrameInput extends BinanceRawFrameInputBase {
  channel: "public-market";
  normalization_version: "binance-usdm-market-inspection.v1";
}

export interface BinanceRawDepthFrameInput extends BinanceRawFrameInputBase {
  channel: "public-depth";
  normalization_version: "binance-usdm-depth-inspection.v1";
}

export type BinanceRawFrameInput =
  | BinanceRawMarketFrameInput
  | BinanceRawDepthFrameInput;

export type BinanceRawFrameProvenance = BinanceRawFrameInput & {
  raw_frame_sha256: string;
};

export type BinanceRawMarketProviderSequence = BinanceRawProviderSequence;

export interface BinanceStreamEvidenceRecordV2
  extends BinanceStreamEvidenceRecordBase {
  schema_version: "glitch.crypto.binance-usdm-stream-evidence.v2";
  channel: BinanceRawFrameChannel;
  kind: "message";
  provenance: BinanceRawFrameProvenance;
}

export type BinanceStreamEvidenceRecord =
  | BinanceStreamEvidenceRecordV1
  | BinanceStreamEvidenceRecordV2;

export interface BinanceStreamEvidenceSink {
  record(
    channel: BinanceStreamEvidenceChannel,
    kind: BinanceStreamEvidenceKind,
    payload: unknown,
    rawFrame?: BinanceRawFrameInput,
  ): BinanceStreamEvidenceRecord;
}

export interface BinanceStreamEvidenceOptions {
  forbiddenValues?: readonly string[];
  now?: () => number;
}

export class InMemoryBinanceStreamEvidenceSink implements BinanceStreamEvidenceSink {
  readonly records: BinanceStreamEvidenceRecord[] = [];
  private readonly forbiddenValues: readonly string[];
  private readonly now: () => number;
  private readonly sessionId = randomUUID();
  private sequence = 0;

  constructor(options: BinanceStreamEvidenceOptions = {}) {
    this.forbiddenValues = options.forbiddenValues ?? [];
    this.now = options.now ?? Date.now;
  }

  record(
    channel: BinanceStreamEvidenceChannel,
    kind: BinanceStreamEvidenceKind,
    payload: unknown,
    rawFrame?: BinanceRawFrameInput,
  ): BinanceStreamEvidenceRecord {
    const record = makeRecord(
      this.sessionId,
      ++this.sequence,
      this.now,
      channel,
      kind,
      payload,
      this.forbiddenValues,
      rawFrame,
    );
    this.records.push(record);
    return record;
  }
}

export interface JsonlBinanceStreamEvidenceOptions extends BinanceStreamEvidenceOptions {
  maxBytes?: number;
  backupPath?: string;
}

export class JsonlBinanceStreamEvidenceSink implements BinanceStreamEvidenceSink {
  private readonly forbiddenValues: readonly string[];
  private readonly now: () => number;
  private readonly maxBytes: number;
  private readonly backupPath: string;
  private readonly sessionId = randomUUID();
  private sequence = 0;

  constructor(
    private readonly path: string,
    options: JsonlBinanceStreamEvidenceOptions = {},
  ) {
    if (!path.trim()) {
      throw new Error("stream evidence path is required");
    }
    this.forbiddenValues = options.forbiddenValues ?? [];
    this.now = options.now ?? Date.now;
    this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1024) {
      throw new Error("stream evidence maxBytes must be a safe integer of at least 1024");
    }
    this.backupPath = options.backupPath ?? `${path}.1`;
    mkdirSync(dirname(path), { recursive: true });
  }

  record(
    channel: BinanceStreamEvidenceChannel,
    kind: BinanceStreamEvidenceKind,
    payload: unknown,
    rawFrame?: BinanceRawFrameInput,
  ): BinanceStreamEvidenceRecord {
    const record = makeRecord(
      this.sessionId,
      ++this.sequence,
      this.now,
      channel,
      kind,
      payload,
      this.forbiddenValues,
      rawFrame,
    );
    const line = `${JSON.stringify(record)}\n`;
    this.rotateIfNeeded(new TextEncoder().encode(line).byteLength);
    appendFileSync(this.path, line, { encoding: "utf8" });
    return record;
  }

  private rotateIfNeeded(incomingBytes: number): void {
    const currentBytes = existsSync(this.path) ? statSync(this.path).size : 0;
    if (currentBytes === 0 || currentBytes + incomingBytes <= this.maxBytes) {
      return;
    }
    if (existsSync(this.backupPath)) {
      rmSync(this.backupPath, { force: true });
    }
    renameSync(this.path, this.backupPath);
  }
}

function makeRecord(
  sessionId: string,
  sequence: number,
  now: () => number,
  channel: BinanceStreamEvidenceChannel,
  kind: BinanceStreamEvidenceKind,
  payload: unknown,
  forbiddenValues: readonly string[],
  rawFrame?: BinanceRawFrameInput,
): BinanceStreamEvidenceRecord {
  const redacted = redactProviderEvidence(payload, forbiddenValues);
  assertProviderEvidenceIsSecretFree(redacted, forbiddenValues);
  const common = {
    session_id: sessionId,
    sequence,
    recorded_utc: new Date(now()).toISOString(),
    channel,
    kind,
    payload: redacted,
  };
  if (rawFrame !== undefined) {
    if (channel !== rawFrame.channel || kind !== "message") {
      throw new Error("raw frame provenance must match its public message channel");
    }
    validateRawFrame(rawFrame);
    assertProviderEvidenceIsSecretFree(rawFrame.raw_frame, forbiddenValues);
    return {
      schema_version: "glitch.crypto.binance-usdm-stream-evidence.v2",
      ...common,
      channel: rawFrame.channel,
      kind: "message",
      provenance: {
        ...rawFrame,
        raw_frame_sha256: createHash("sha256")
          .update(rawFrame.raw_frame)
          .digest("hex"),
      },
    };
  }
  return {
    schema_version: "glitch.crypto.binance-usdm-stream-evidence.v1",
    ...common,
  };
}

function validateRawFrame(input: BinanceRawFrameInput): void {
  if (
    input.venue !== "BINANCE_USDM" ||
    !new Set(["public-market", "public-depth"]).has(input.channel)
  ) {
    throw new Error("raw frame provenance authority is invalid");
  }
  if (!/^[A-Z0-9]{5,24}$/.test(input.instrument)) {
    throw new Error("raw public provenance instrument is invalid");
  }
  if (!/^[A-Za-z0-9:_-]{8,128}$/.test(input.connection_id)) {
    throw new Error("raw public provenance connection ID is invalid");
  }
  if (
    !Number.isSafeInteger(input.local_receive_timestamp_ms) ||
    input.local_receive_timestamp_ms <= 0
  ) {
    throw new Error("raw public local receive timestamp is invalid");
  }
  if (!/^[1-9]\d*$/.test(input.monotonic_receive_ns)) {
    throw new Error("raw public monotonic receive timestamp is invalid");
  }
  if (
    input.exchange_timestamp_ms !== null &&
    (!Number.isSafeInteger(input.exchange_timestamp_ms) ||
      input.exchange_timestamp_ms <= 0)
  ) {
    throw new Error("raw public exchange timestamp is invalid");
  }
  const expectedVersion = input.channel === "public-market"
    ? "binance-usdm-market-inspection.v1"
    : "binance-usdm-depth-inspection.v1";
  if (input.normalization_version !== expectedVersion) {
    throw new Error("raw frame normalization version is invalid");
  }
  if (typeof input.raw_frame !== "string" || input.raw_frame.length === 0) {
    throw new Error("raw public frame is required");
  }
  validateProviderSequence(input.provider_sequence);
}

function validateProviderSequence(
  sequence: BinanceRawProviderSequence,
): void {
  if (sequence === null || typeof sequence !== "object") {
    throw new Error("raw public provider sequence is invalid");
  }
  if (sequence.event_type !== null && typeof sequence.event_type !== "string") {
    throw new Error("raw public provider event type is invalid");
  }
  for (const value of [
    sequence.event_time_ms,
    sequence.aggregate_trade_id,
    sequence.first_trade_id,
    sequence.last_trade_id,
    sequence.trade_time_ms,
    sequence.first_update_id,
    sequence.final_update_id,
    sequence.previous_final_update_id,
    sequence.transaction_time_ms,
  ]) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error("raw public provider sequence value is invalid");
    }
  }
}
