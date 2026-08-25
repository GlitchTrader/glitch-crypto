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
import { buildSignedBinanceQuery, encodeBinanceQuery, type BinanceQueryValue } from "./query.js";
import { assertProviderEvidenceIsSecretFree, redactProviderEvidence } from "./redaction.js";
import type { BinanceUsdmAlgoOrderType, BinanceUsdmOrderSide } from "./mutation-contract.js";

const BINANCE_USDM_TESTNET_ORIGIN = "https://demo-fapi.binance.com";
const EXECUTION_UNKNOWN_MESSAGE = "unknown error, please check your request or try again later";

export type BinanceUsdmMutationDisposition = "accepted" | "ambiguous" | "rejected";

export interface BinanceUsdmMutationResult {
  disposition: BinanceUsdmMutationDisposition;
  operationId: string;
  httpStatus: number | null;
  reason: string;
  payload: unknown;
}

export interface BinanceUsdmLookupResult {
  disposition: "found" | "not_found" | "unavailable";
  operationId: string;
  httpStatus: number | null;
  reason: string;
  payload: unknown;
}

export interface BinanceUsdmMutationEvidenceEvent {
  schema_version: "glitch.crypto.binance-usdm-mutation-evidence.v1";
  session_id: string;
  sequence: number;
  recorded_utc: string;
  phase: "before_transport" | "transport_result";
  operation_id: string;
  method: "GET" | "POST" | "DELETE";
  path: string;
  parameters?: unknown;
  disposition?: string;
  http_status?: number | null;
  reason?: string;
  payload?: unknown;
}

export interface BinanceUsdmMutationEvidenceSink {
  record(event: BinanceUsdmMutationEvidenceEvent): void;
}

export class InMemoryBinanceUsdmMutationEvidenceSink implements BinanceUsdmMutationEvidenceSink {
  readonly events: BinanceUsdmMutationEvidenceEvent[] = [];

  record(event: BinanceUsdmMutationEvidenceEvent): void {
    this.events.push(event);
  }
}

export interface JsonlBinanceUsdmMutationEvidenceOptions {
  maxBytes?: number;
  backupPath?: string;
}

export class JsonlBinanceUsdmMutationEvidenceSink implements BinanceUsdmMutationEvidenceSink {
  private readonly maxBytes: number;
  private readonly backupPath: string;

  constructor(
    private readonly path: string,
    options: JsonlBinanceUsdmMutationEvidenceOptions = {},
  ) {
    if (!path.trim()) {
      throw new Error("Binance mutation evidence path is required");
    }
    this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1_024) {
      throw new Error("Binance mutation evidence maxBytes must be at least 1024");
    }
    this.backupPath = options.backupPath ?? path + ".1";
    mkdirSync(dirname(path), { recursive: true });
  }

  record(event: BinanceUsdmMutationEvidenceEvent): void {
    const line = JSON.stringify(event) + "\n";
    this.rotateIfNeeded(new TextEncoder().encode(line).byteLength);
    appendFileSync(this.path, line, { encoding: "utf8" });
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

export interface BinanceUsdmMutationClientConfig {
  environment: "testnet";
  baseUrl?: string;
  apiKey: string;
  apiSecret: string;
  recvWindow?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  evidence: BinanceUsdmMutationEvidenceSink;
}

export interface BinanceUsdmMarketOrderInput {
  symbol: string;
  side: BinanceUsdmOrderSide;
  quantity: string;
  clientOrderId: string;
}

export interface BinanceUsdmAlgoOrderInput {
  symbol: string;
  side: BinanceUsdmOrderSide;
  quantity: string;
  triggerPrice: string;
  type: BinanceUsdmAlgoOrderType;
  clientAlgoId: string;
}

export class BinanceUsdmMutationClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly recvWindow: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly evidence: BinanceUsdmMutationEvidenceSink;
  private clockOffsetMs = 0;
  private clockSynchronized = false;
  private readonly evidenceSessionId = randomUUID();
  private evidenceSequence = 0;

  constructor(config: BinanceUsdmMutationClientConfig) {
    if (config.environment !== "testnet") {
      throw new Error("Binance mutation client requires the testnet environment");
    }
    this.baseUrl = normalizeMutationBaseUrl(config.baseUrl ?? BINANCE_USDM_TESTNET_ORIGIN);
    this.apiKey = config.apiKey.trim();
    this.apiSecret = config.apiSecret.trim();
    if (!this.apiKey || !this.apiSecret) {
      throw new Error("Binance Testnet mutation credentials must both be configured");
    }
    this.recvWindow = config.recvWindow ?? 5_000;
    if (!Number.isSafeInteger(this.recvWindow) || this.recvWindow < 1 || this.recvWindow > 60_000) {
      throw new Error("Binance recvWindow must be an integer between 1 and 60000 milliseconds");
    }
    this.timeoutMs = config.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 60_000) {
      throw new Error("Binance timeout must be an integer between 100 and 60000 milliseconds");
    }
    if (!config.evidence || typeof config.evidence.record !== "function") {
      throw new Error("Binance mutation evidence sink is required");
    }
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.now ?? Date.now;
    this.evidence = config.evidence;
  }

  async synchronizeClock(): Promise<number> {
    const response = await this.publicGet("/fapi/v1/time");
    const record = objectValue(response);
    const serverTime = record?.serverTime;
    if (!Number.isSafeInteger(serverTime) || (serverTime as number) <= 0) {
      throw new Error("Binance Testnet server time response is invalid");
    }
    this.clockOffsetMs = (serverTime as number) - this.now();
    this.clockSynchronized = true;
    return this.clockOffsetMs;
  }

  async placeMarketEntry(input: BinanceUsdmMarketOrderInput): Promise<BinanceUsdmMutationResult> {
    return this.signedMutation("POST", "/fapi/v1/order", {
      symbol: input.symbol,
      side: input.side,
      type: "MARKET",
      positionSide: "BOTH",
      quantity: input.quantity,
      newClientOrderId: checkedClientId(input.clientOrderId),
      newOrderRespType: "RESULT",
    }, input.clientOrderId);
  }

  async placeReduceOnlyAlgo(input: BinanceUsdmAlgoOrderInput): Promise<BinanceUsdmMutationResult> {
    return this.signedMutation("POST", "/fapi/v1/algoOrder", {
      algoType: "CONDITIONAL",
      symbol: input.symbol,
      side: input.side,
      type: input.type,
      positionSide: "BOTH",
      quantity: input.quantity,
      triggerPrice: input.triggerPrice,
      workingType: "MARK_PRICE",
      priceProtect: false,
      reduceOnly: true,
      clientAlgoId: checkedClientId(input.clientAlgoId),
      newOrderRespType: "ACK",
    }, input.clientAlgoId);
  }

  async placeEmergencyClose(input: BinanceUsdmMarketOrderInput): Promise<BinanceUsdmMutationResult> {
    return this.placeReduceOnlyMarket(input);
  }

  async placeReduceOnlyMarket(input: BinanceUsdmMarketOrderInput): Promise<BinanceUsdmMutationResult> {
    return this.signedMutation("POST", "/fapi/v1/order", {
      symbol: input.symbol,
      side: input.side,
      type: "MARKET",
      positionSide: "BOTH",
      reduceOnly: true,
      quantity: input.quantity,
      newClientOrderId: checkedClientId(input.clientOrderId),
      newOrderRespType: "RESULT",
    }, input.clientOrderId);
  }

  async cancelAlgoOrder(clientAlgoId: string): Promise<BinanceUsdmMutationResult> {
    const checked = checkedClientId(clientAlgoId);
    return this.signedMutation("DELETE", "/fapi/v1/algoOrder", {
      clientAlgoId: checked,
    }, checked);
  }

  async queryOrder(symbol: string, clientOrderId: string): Promise<BinanceUsdmLookupResult> {
    return this.signedLookup("GET", "/fapi/v1/order", {
      symbol,
      origClientOrderId: checkedClientId(clientOrderId),
    }, clientOrderId);
  }

  async queryAlgoOrder(clientAlgoId: string): Promise<BinanceUsdmLookupResult> {
    return this.signedLookup("GET", "/fapi/v1/algoOrder", {
      clientAlgoId: checkedClientId(clientAlgoId),
    }, clientAlgoId);
  }

  private async signedMutation(
    method: "POST" | "DELETE",
    path: string,
    parameters: Readonly<Record<string, BinanceQueryValue>>,
    operationId: string,
  ): Promise<BinanceUsdmMutationResult> {
    this.requireClock();
    this.record({
      phase: "before_transport",
      operationId,
      method,
      path,
      parameters,
    });
    const response = await this.signedTransport(method, path, parameters);
    let disposition: BinanceUsdmMutationDisposition;
    let reason: string;
    if (response.ok) {
      disposition = "accepted";
      reason = "venue_accepted";
    } else if (response.networkError || response.status === 408 || isExecutionUnknown503(response.status, response.payload)) {
      disposition = "ambiguous";
      reason = response.networkError ? "transport_outcome_unknown" : "venue_execution_outcome_unknown";
    } else {
      disposition = "rejected";
      reason = "venue_rejected";
    }
    const result: BinanceUsdmMutationResult = {
      disposition,
      operationId,
      httpStatus: response.status,
      reason,
      payload: response.payload,
    };
    this.record({
      phase: "transport_result",
      operationId,
      method,
      path,
      disposition,
      httpStatus: response.status,
      reason,
      payload: response.payload,
    });
    return result;
  }

  private async signedLookup(
    method: "GET",
    path: string,
    parameters: Readonly<Record<string, BinanceQueryValue>>,
    operationId: string,
  ): Promise<BinanceUsdmLookupResult> {
    this.requireClock();
    const response = await this.signedTransport(method, path, parameters);
    const errorCode = objectValue(response.payload)?.code;
    const disposition = response.ok
      ? "found"
      : response.status === 404 || errorCode === -2013
        ? "not_found"
        : "unavailable";
    const result: BinanceUsdmLookupResult = {
      disposition,
      operationId,
      httpStatus: response.status,
      reason: disposition === "found" ? "venue_identity_found" : disposition === "not_found" ? "venue_identity_not_found" : "venue_query_unavailable",
      payload: response.payload,
    };
    this.record({
      phase: "transport_result",
      operationId,
      method,
      path,
      disposition,
      httpStatus: response.status,
      reason: result.reason,
      payload: response.payload,
    });
    return result;
  }

  private async signedTransport(
    method: "GET" | "POST" | "DELETE",
    path: string,
    parameters: Readonly<Record<string, BinanceQueryValue>>,
  ): Promise<{ ok: boolean; status: number | null; payload: unknown; networkError: boolean }> {
    const timestamp = Math.trunc(this.now() + this.clockOffsetMs);
    const signed = buildSignedBinanceQuery(parameters, this.apiSecret, timestamp, this.recvWindow);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const url = method === "POST"
        ? this.baseUrl + path
        : this.baseUrl + path + "?" + signed;
      const response = await this.fetchImpl(url, {
        method,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "X-MBX-APIKEY": this.apiKey,
        },
        body: method === "POST" ? signed : undefined,
        signal: controller.signal,
      });
      const payload = redactProviderEvidence(parseJson(await response.text()), [
        this.apiKey,
        this.apiSecret,
      ]);
      return { ok: response.ok, status: response.status, payload, networkError: false };
    } catch (error) {
      const safe = redactProviderEvidence(
        error instanceof Error ? error.message : "Binance mutation transport failed",
        [this.apiKey, this.apiSecret],
      );
      return {
        ok: false,
        status: null,
        payload: { error: safe },
        networkError: true,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async publicGet(path: "/fapi/v1/time"): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.baseUrl + path + "?" + encodeBinanceQuery({}), {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      const payload = parseJson(await response.text());
      if (!response.ok) {
        throw new Error("Binance Testnet clock request failed with HTTP " + response.status);
      }
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }

  private requireClock(): void {
    if (!this.clockSynchronized) {
      throw new Error("Binance Testnet clock must be synchronized before signed transport");
    }
  }

  private record(input: {
    phase: BinanceUsdmMutationEvidenceEvent["phase"];
    operationId: string;
    method: BinanceUsdmMutationEvidenceEvent["method"];
    path: string;
    parameters?: unknown;
    disposition?: string;
    httpStatus?: number | null;
    reason?: string;
    payload?: unknown;
  }): void {
    const event: BinanceUsdmMutationEvidenceEvent = {
      schema_version: "glitch.crypto.binance-usdm-mutation-evidence.v1",
      session_id: this.evidenceSessionId,
      sequence: ++this.evidenceSequence,
      recorded_utc: new Date(this.now()).toISOString(),
      phase: input.phase,
      operation_id: input.operationId,
      method: input.method,
      path: input.path,
      parameters: redactProviderEvidence(input.parameters, [this.apiKey, this.apiSecret]),
      disposition: input.disposition,
      http_status: input.httpStatus,
      reason: input.reason,
      payload: redactProviderEvidence(input.payload, [this.apiKey, this.apiSecret]),
    };
    assertProviderEvidenceIsSecretFree(event, [this.apiKey, this.apiSecret]);
    this.evidence.record(event);
  }
}

function normalizeMutationBaseUrl(value: string): string {
  const parsed = new URL(value);
  const numericLoopback = parsed.hostname === "127.0.0.1"
    || parsed.hostname === "::1"
    || parsed.hostname === "[::1]";
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== "/" && parsed.pathname !== "")) {
    throw new Error("Binance mutation base URL must be a bare origin");
  }
  if (parsed.origin === BINANCE_USDM_TESTNET_ORIGIN) {
    return parsed.origin;
  }
  if (numericLoopback && (parsed.protocol === "http:" || parsed.protocol === "https:")) {
    return parsed.origin;
  }
  throw new Error("Binance mutation base URL must be Futures Testnet or numeric loopback");
}

function checkedClientId(value: string): string {
  if (!/^[.A-Z:/a-z0-9_-]{1,36}$/.test(value)) {
    throw new Error("Binance client order ID is invalid");
  }
  return value;
}

function isExecutionUnknown503(status: number | null, payload: unknown): boolean {
  if (status !== 503) {
    return false;
  }
  const message = objectValue(payload)?.msg;
  return typeof message === "string"
    && message.toLowerCase().includes(EXECUTION_UNKNOWN_MESSAGE);
}

function parseJson(value: string): unknown {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { error: "non_json_response" };
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
