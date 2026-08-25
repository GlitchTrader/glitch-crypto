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

export interface BinanceRawMarketProviderSequence {
  event_type: string | null;
  event_time_ms: number | null;
  aggregate_trade_id: number | null;
  first_trade_id: number | null;
  last_trade_id: number | null;
  trade_time_ms: number | null;
}

export interface BinanceRawMarketFrameInput {
  venue: "BINANCE_USDM";
  instrument: string;
  channel: "public-market";
  connection_id: string;
  local_receive_timestamp_ms: number;
  monotonic_receive_ns: string;
  exchange_timestamp_ms: number | null;
  provider_sequence: BinanceRawMarketProviderSequence;
  normalization_version: "binance-usdm-market-inspection.v1";
  raw_frame: string;
}

export interface BinanceRawMarketFrameProvenance
  extends BinanceRawMarketFrameInput {
  raw_frame_sha256: string;
}

export interface BinanceStreamEvidenceRecordV2
  extends BinanceStreamEvidenceRecordBase {
  schema_version: "glitch.crypto.binance-usdm-stream-evidence.v2";
  channel: "public-market";
  kind: "message";
  provenance: BinanceRawMarketFrameProvenance;
}

export type BinanceStreamEvidenceRecord =
  | BinanceStreamEvidenceRecordV1
  | BinanceStreamEvidenceRecordV2;

export interface BinanceStreamEvidenceSink {
  record(
    channel: BinanceStreamEvidenceChannel,
    kind: BinanceStreamEvidenceKind,
    payload: unknown,
    rawMarketFrame?: BinanceRawMarketFrameInput,
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
    rawMarketFrame?: BinanceRawMarketFrameInput,
  ): BinanceStreamEvidenceRecord {
    const record = makeRecord(
      this.sessionId,
      ++this.sequence,
      this.now,
      channel,
      kind,
      payload,
      this.forbiddenValues,
      rawMarketFrame,
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
    rawMarketFrame?: BinanceRawMarketFrameInput,
  ): BinanceStreamEvidenceRecord {
    const record = makeRecord(
      this.sessionId,
      ++this.sequence,
      this.now,
      channel,
      kind,
      payload,
      this.forbiddenValues,
      rawMarketFrame,
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
  rawMarketFrame?: BinanceRawMarketFrameInput,
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
  if (rawMarketFrame !== undefined) {
    if (channel !== "public-market" || kind !== "message") {
      throw new Error("raw market provenance is valid only for public-market messages");
    }
    validateRawMarketFrame(rawMarketFrame);
    assertProviderEvidenceIsSecretFree(rawMarketFrame.raw_frame, forbiddenValues);
    return {
      schema_version: "glitch.crypto.binance-usdm-stream-evidence.v2",
      ...common,
      channel: "public-market",
      kind: "message",
      provenance: {
        ...rawMarketFrame,
        raw_frame_sha256: createHash("sha256")
          .update(rawMarketFrame.raw_frame)
          .digest("hex"),
      },
    };
  }
  return {
    schema_version: "glitch.crypto.binance-usdm-stream-evidence.v1",
    ...common,
  };
}

function validateRawMarketFrame(input: BinanceRawMarketFrameInput): void {
  if (input.venue !== "BINANCE_USDM" || input.channel !== "public-market") {
    throw new Error("raw market provenance authority is invalid");
  }
  if (!/^[A-Z0-9]{5,24}$/.test(input.instrument)) {
    throw new Error("raw market provenance instrument is invalid");
  }
  if (!/^[A-Za-z0-9:_-]{8,128}$/.test(input.connection_id)) {
    throw new Error("raw market provenance connection ID is invalid");
  }
  if (
    !Number.isSafeInteger(input.local_receive_timestamp_ms) ||
    input.local_receive_timestamp_ms <= 0
  ) {
    throw new Error("raw market local receive timestamp is invalid");
  }
  if (!/^[1-9]\d*$/.test(input.monotonic_receive_ns)) {
    throw new Error("raw market monotonic receive timestamp is invalid");
  }
  if (
    input.exchange_timestamp_ms !== null &&
    (!Number.isSafeInteger(input.exchange_timestamp_ms) ||
      input.exchange_timestamp_ms <= 0)
  ) {
    throw new Error("raw market exchange timestamp is invalid");
  }
  if (input.normalization_version !== "binance-usdm-market-inspection.v1") {
    throw new Error("raw market normalization version is invalid");
  }
  if (typeof input.raw_frame !== "string" || input.raw_frame.length === 0) {
    throw new Error("raw market frame is required");
  }
  validateProviderSequence(input.provider_sequence);
}

function validateProviderSequence(
  sequence: BinanceRawMarketProviderSequence,
): void {
  if (sequence === null || typeof sequence !== "object") {
    throw new Error("raw market provider sequence is invalid");
  }
  if (sequence.event_type !== null && typeof sequence.event_type !== "string") {
    throw new Error("raw market provider event type is invalid");
  }
  for (const value of [
    sequence.event_time_ms,
    sequence.aggregate_trade_id,
    sequence.first_trade_id,
    sequence.last_trade_id,
    sequence.trade_time_ms,
  ]) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error("raw market provider sequence value is invalid");
    }
  }
}
