import { randomUUID } from "node:crypto";
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
  | "private-user"
  | "supervisor";

export type BinanceStreamEvidenceKind =
  | "message"
  | "snapshot"
  | "reconciliation"
  | "transition"
  | "keepalive"
  | "error";

export interface BinanceStreamEvidenceRecord {
  schema_version: "glitch.crypto.binance-usdm-stream-evidence.v1";
  session_id: string;
  sequence: number;
  recorded_utc: string;
  channel: BinanceStreamEvidenceChannel;
  kind: BinanceStreamEvidenceKind;
  payload: unknown;
}

export interface BinanceStreamEvidenceSink {
  record(
    channel: BinanceStreamEvidenceChannel,
    kind: BinanceStreamEvidenceKind,
    payload: unknown,
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
  ): BinanceStreamEvidenceRecord {
    const record = makeRecord(
      this.sessionId,
      ++this.sequence,
      this.now,
      channel,
      kind,
      payload,
      this.forbiddenValues,
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
  ): BinanceStreamEvidenceRecord {
    const record = makeRecord(
      this.sessionId,
      ++this.sequence,
      this.now,
      channel,
      kind,
      payload,
      this.forbiddenValues,
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
): BinanceStreamEvidenceRecord {
  const redacted = redactProviderEvidence(payload, forbiddenValues);
  assertProviderEvidenceIsSecretFree(redacted, forbiddenValues);
  return {
    schema_version: "glitch.crypto.binance-usdm-stream-evidence.v1",
    session_id: sessionId,
    sequence,
    recorded_utc: new Date(now()).toISOString(),
    channel,
    kind,
    payload: redacted,
  };
}
