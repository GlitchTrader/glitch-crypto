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
  | "raw_snapshot"
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

export interface BinanceRawDepthSnapshotInput {
  venue: "BINANCE_USDM";
  instrument: string;
  channel: "public-depth";
  transport: "REST";
  method: "GET";
  origin: string;
  path: "/fapi/v1/depth";
  query: string;
  http_status: number;
  local_receive_timestamp_ms: number;
  monotonic_receive_ns: string;
  normalization_version: "binance-usdm-depth-snapshot-inspection.v1";
  raw_response: string;
}

export type BinanceRawDepthSnapshotProvenance =
  BinanceRawDepthSnapshotInput & {
    raw_response_sha256: string;
  };

export interface BinanceStreamEvidenceRecordV2
  extends BinanceStreamEvidenceRecordBase {
  schema_version: "glitch.crypto.binance-usdm-stream-evidence.v2";
  channel: BinanceRawFrameChannel;
  kind: "message";
  provenance: BinanceRawFrameProvenance;
}

export interface BinanceStreamEvidenceRecordV3
  extends BinanceStreamEvidenceRecordBase {
  schema_version: "glitch.crypto.binance-usdm-stream-evidence.v3";
  channel: "public-depth";
  kind: "raw_snapshot";
  payload: null;
  provenance: BinanceRawDepthSnapshotProvenance;
}

export type BinanceRawEvidenceInput =
  | BinanceRawFrameInput
  | BinanceRawDepthSnapshotInput;

export type BinanceStreamEvidenceRecord =
  | BinanceStreamEvidenceRecordV1
  | BinanceStreamEvidenceRecordV2
  | BinanceStreamEvidenceRecordV3;

export interface BinanceStreamEvidenceSink {
  record(
    channel: BinanceStreamEvidenceChannel,
    kind: BinanceStreamEvidenceKind,
    payload: unknown,
    rawEvidence?: BinanceRawEvidenceInput,
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
    rawEvidence?: BinanceRawEvidenceInput,
  ): BinanceStreamEvidenceRecord {
    const record = makeRecord(
      this.sessionId,
      ++this.sequence,
      this.now,
      channel,
      kind,
      payload,
      this.forbiddenValues,
      rawEvidence,
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
    rawEvidence?: BinanceRawEvidenceInput,
  ): BinanceStreamEvidenceRecord {
    const record = makeRecord(
      this.sessionId,
      ++this.sequence,
      this.now,
      channel,
      kind,
      payload,
      this.forbiddenValues,
      rawEvidence,
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
  rawEvidence?: BinanceRawEvidenceInput,
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
  if (rawEvidence !== undefined && "raw_response" in rawEvidence) {
    if (
      channel !== "public-depth" ||
      kind !== "raw_snapshot" ||
      payload !== null
    ) {
      throw new Error(
        "raw snapshot provenance requires a null public-depth raw_snapshot record",
      );
    }
    validateRawSnapshot(rawEvidence);
    assertProviderEvidenceIsSecretFree(
      rawEvidence.raw_response,
      forbiddenValues,
    );
    return {
      schema_version: "glitch.crypto.binance-usdm-stream-evidence.v3",
      ...common,
      channel: "public-depth",
      kind: "raw_snapshot",
      payload: null,
      provenance: {
        ...rawEvidence,
        raw_response_sha256: createHash("sha256")
          .update(rawEvidence.raw_response)
          .digest("hex"),
      },
    };
  }
  if (rawEvidence !== undefined) {
    if (channel !== rawEvidence.channel || kind !== "message") {
      throw new Error("raw frame provenance must match its public message channel");
    }
    validateRawFrame(rawEvidence);
    assertProviderEvidenceIsSecretFree(rawEvidence.raw_frame, forbiddenValues);
    return {
      schema_version: "glitch.crypto.binance-usdm-stream-evidence.v2",
      ...common,
      channel: rawEvidence.channel,
      kind: "message",
      provenance: {
        ...rawEvidence,
        raw_frame_sha256: createHash("sha256")
          .update(rawEvidence.raw_frame)
          .digest("hex"),
      },
    };
  }
  if (kind === "raw_snapshot") {
    throw new Error("raw snapshot evidence requires exact response provenance");
  }
  return {
    schema_version: "glitch.crypto.binance-usdm-stream-evidence.v1",
    ...common,
  };
}

function validateRawSnapshot(input: BinanceRawDepthSnapshotInput): void {
  if (
    input.venue !== "BINANCE_USDM" ||
    input.channel !== "public-depth" ||
    input.transport !== "REST" ||
    input.method !== "GET" ||
    input.path !== "/fapi/v1/depth" ||
    input.normalization_version !==
      "binance-usdm-depth-snapshot-inspection.v1"
  ) {
    throw new Error("raw depth snapshot provenance authority is invalid");
  }
  if (!/^[A-Z0-9]{5,24}$/.test(input.instrument)) {
    throw new Error("raw depth snapshot instrument is invalid");
  }
  const origin = new URL(input.origin);
  const loopback =
    origin.hostname === "127.0.0.1" ||
    origin.hostname === "::1" ||
    origin.hostname === "[::1]";
  if (
    origin.origin !== input.origin ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    (origin.pathname !== "/" && origin.pathname !== "") ||
    (origin.protocol !== "https:" && !(loopback && origin.protocol === "http:"))
  ) {
    throw new Error("raw depth snapshot origin is invalid");
  }
  if (
    typeof input.query !== "string" ||
    input.query.length === 0 ||
    input.query.length > 2_048 ||
    /(?:^|&)(?:signature|timestamp|recvWindow)=/i.test(input.query)
  ) {
    throw new Error("raw depth snapshot query is invalid");
  }
  if (
    !Number.isSafeInteger(input.http_status) ||
    input.http_status < 200 ||
    input.http_status > 299
  ) {
    throw new Error("raw depth snapshot HTTP status is invalid");
  }
  if (
    !Number.isSafeInteger(input.local_receive_timestamp_ms) ||
    input.local_receive_timestamp_ms <= 0 ||
    !/^[1-9]\d*$/.test(input.monotonic_receive_ns)
  ) {
    throw new Error("raw depth snapshot receive time is invalid");
  }
  if (
    typeof input.raw_response !== "string" ||
    input.raw_response.length === 0
  ) {
    throw new Error("raw depth snapshot response is required");
  }
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
