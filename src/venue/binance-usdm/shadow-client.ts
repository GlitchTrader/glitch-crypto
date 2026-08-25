import { parseBinanceUsdmSymbolRules, type BinanceUsdmSymbolRules } from "./contracts.js";
import { buildSignedBinanceQuery, encodeBinanceQuery, type BinanceQueryValue } from "./query.js";
import { assertProviderEvidenceIsSecretFree, redactProviderEvidence } from "./redaction.js";

const PUBLIC_GET_ENDPOINTS = new Set([
  "/fapi/v1/time",
  "/fapi/v1/exchangeInfo",
  "/fapi/v1/ticker/bookTicker",
  "/fapi/v1/depth",
  "/fapi/v1/premiumIndex",
]);

const SIGNED_GET_ENDPOINTS = new Set([
  "/fapi/v3/balance",
  "/fapi/v3/positionRisk",
  "/fapi/v1/openOrders",
  "/fapi/v1/commissionRate",
  "/fapi/v1/positionSide/dual",
  "/fapi/v1/multiAssetsMargin",
  "/fapi/v1/symbolConfig",
  "/fapi/v1/accountConfig",
]);

export interface BinanceUsdmShadowClientConfig {
  baseUrl?: string;
  symbol?: string;
  apiKey?: string;
  apiSecret?: string;
  recvWindow?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  monotonicClock?: () => bigint;
}

export interface BinanceUsdmPublicRawResponse {
  method: "GET";
  origin: string;
  path: string;
  query: string;
  http_status: number;
  local_receive_timestamp_ms: number;
  monotonic_receive_ns: string;
  raw_response: string;
}

export interface BinanceUsdmPublicSnapshot {
  server_time: number;
  exchange_information: unknown;
  symbol_rules: BinanceUsdmSymbolRules;
  book_ticker: unknown;
  depth: unknown;
  premium_index: unknown;
}

export interface BinanceUsdmAccountSnapshot {
  balances: unknown;
  positions: unknown;
  open_orders: unknown;
  commission_rate: unknown;
  position_mode: unknown;
  multi_asset_mode: unknown;
  symbol_configuration: unknown;
  account_configuration: unknown;
}

export interface BinanceUsdmShadowEvidence {
  schema_version: "glitch.crypto.binance-usdm-shadow-evidence.v1";
  venue: "binance-usdm";
  symbol: string;
  base_url_origin: string;
  mutation_authority: false;
  credential_mode: "public_only" | "read_only_authenticated";
  observed_utc: string;
  public: BinanceUsdmPublicSnapshot;
  private: BinanceUsdmAccountSnapshot | null;
}

export class BinanceUsdmShadowClient {
  readonly symbol: string;
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly recvWindow: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly monotonicClock: () => bigint;
  private clockOffsetMs = 0;

  constructor(config: BinanceUsdmShadowClientConfig = {}) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl ?? "https://fapi.binance.com");
    this.symbol = normalizeSymbol(config.symbol ?? "BTCUSDT");
    this.apiKey = (config.apiKey ?? "").trim();
    this.apiSecret = (config.apiSecret ?? "").trim();
    if ((this.apiKey.length === 0) !== (this.apiSecret.length === 0)) {
      throw new Error("Binance API key and secret must either both be configured or both be absent");
    }
    this.recvWindow = config.recvWindow ?? 5_000;
    if (!Number.isSafeInteger(this.recvWindow) || this.recvWindow < 1 || this.recvWindow > 60_000) {
      throw new Error("Binance recvWindow must be an integer between 1 and 60000 milliseconds");
    }
    this.timeoutMs = config.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 60_000) {
      throw new Error("Binance timeout must be an integer between 100 and 60000 milliseconds");
    }
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.now ?? Date.now;
    this.monotonicClock = config.monotonicClock ?? (() =>
      BigInt(Math.max(1, Math.trunc(performance.now() * 1_000_000))));
  }

  credentialsConfigured(): boolean {
    return this.apiKey.length > 0 && this.apiSecret.length > 0;
  }

  async capture(includePrivate = false): Promise<BinanceUsdmShadowEvidence> {
    const publicSnapshot = await this.publicSnapshot();
    const privateSnapshot = includePrivate ? await this.accountSnapshot() : null;
    const evidence: BinanceUsdmShadowEvidence = {
      schema_version: "glitch.crypto.binance-usdm-shadow-evidence.v1",
      venue: "binance-usdm",
      symbol: this.symbol,
      base_url_origin: new URL(this.baseUrl).origin,
      mutation_authority: false,
      credential_mode: privateSnapshot === null ? "public_only" : "read_only_authenticated",
      observed_utc: new Date(this.now()).toISOString(),
      public: publicSnapshot,
      private: privateSnapshot,
    };
    const redacted = redactProviderEvidence(evidence, [this.apiKey, this.apiSecret]);
    assertProviderEvidenceIsSecretFree(redacted, [this.apiKey, this.apiSecret]);
    return redacted as BinanceUsdmShadowEvidence;
  }

  async publicSnapshot(): Promise<BinanceUsdmPublicSnapshot> {
    const time = await this.publicGet("/fapi/v1/time");
    const serverTime = safeInteger(objectValue(time, "server-time response").serverTime, "server time");
    this.clockOffsetMs = serverTime - this.now();
    const exchangeInformation = await this.publicGet("/fapi/v1/exchangeInfo");
    const symbolRules = parseBinanceUsdmSymbolRules(exchangeInformation, this.symbol);
    const bookTicker = await this.publicGet("/fapi/v1/ticker/bookTicker", { symbol: this.symbol });
    const depth = await this.publicGet("/fapi/v1/depth", { symbol: this.symbol, limit: 1_000 });
    const premiumIndex = await this.publicGet("/fapi/v1/premiumIndex", { symbol: this.symbol });
    return {
      server_time: serverTime,
      exchange_information: exchangeInformation,
      symbol_rules: symbolRules,
      book_ticker: bookTicker,
      depth,
      premium_index: premiumIndex,
    };
  }

  async accountSnapshot(): Promise<BinanceUsdmAccountSnapshot> {
    this.requireCredentials();
    await this.synchronizeClock();
    const symbol = { symbol: this.symbol };
    return {
      balances: await this.signedGet("/fapi/v3/balance"),
      positions: await this.signedGet("/fapi/v3/positionRisk", symbol),
      open_orders: await this.signedGet("/fapi/v1/openOrders", symbol),
      commission_rate: await this.signedGet("/fapi/v1/commissionRate", symbol),
      position_mode: await this.signedGet("/fapi/v1/positionSide/dual"),
      multi_asset_mode: await this.signedGet("/fapi/v1/multiAssetsMargin"),
      symbol_configuration: await this.signedGet("/fapi/v1/symbolConfig", symbol),
      account_configuration: await this.signedGet("/fapi/v1/accountConfig"),
    };
  }

  async publicGet(
    path: string,
    parameters: Readonly<Record<string, BinanceQueryValue>> = {},
  ): Promise<unknown> {
    if (!PUBLIC_GET_ENDPOINTS.has(path)) {
      throw new Error(`Binance public endpoint is not approved for shadow use: ${path}`);
    }
    const query = encodeBinanceQuery(parameters);
    return this.getJson(path, query, {});
  }

  async publicGetRaw(
    path: string,
    parameters: Readonly<Record<string, BinanceQueryValue>> = {},
  ): Promise<BinanceUsdmPublicRawResponse> {
    if (!PUBLIC_GET_ENDPOINTS.has(path)) {
      throw new Error(`Binance public endpoint is not approved for shadow use: ${path}`);
    }
    return this.getRaw(path, encodeBinanceQuery(parameters), {});
  }

  async signedGet(
    path: string,
    parameters: Readonly<Record<string, BinanceQueryValue>> = {},
  ): Promise<unknown> {
    this.requireCredentials();
    if (!SIGNED_GET_ENDPOINTS.has(path)) {
      throw new Error(`Binance signed endpoint is not approved for read-only shadow use: ${path}`);
    }
    const timestamp = Math.trunc(this.now() + this.clockOffsetMs);
    const query = buildSignedBinanceQuery(parameters, this.apiSecret, timestamp, this.recvWindow);
    return this.getJson(path, query, { "X-MBX-APIKEY": this.apiKey });
  }

  private async synchronizeClock(): Promise<void> {
    const response = await this.publicGet("/fapi/v1/time");
    const serverTime = safeInteger(objectValue(response, "server-time response").serverTime, "server time");
    this.clockOffsetMs = serverTime - this.now();
  }

  private async getJson(
    path: string,
    query: string,
    headers: Record<string, string>,
  ): Promise<unknown> {
    return parseJson((await this.getRaw(path, query, headers)).raw_response);
  }

  private async getRaw(
    path: string,
    query: string,
    headers: Record<string, string>,
  ): Promise<BinanceUsdmPublicRawResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const url = `${this.baseUrl}${path}${query ? `?${query}` : ""}`;
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: { Accept: "application/json", ...headers },
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        const payload = parseJson(text);
        const safe = redactProviderEvidence(payload, [this.apiKey, this.apiSecret]);
        throw new Error(`Binance read-only request failed with HTTP ${response.status}: ${JSON.stringify(safe)}`);
      }
      const raw: BinanceUsdmPublicRawResponse = {
        method: "GET",
        origin: new URL(this.baseUrl).origin,
        path,
        query,
        http_status: response.status,
        local_receive_timestamp_ms: this.now(),
        monotonic_receive_ns: this.monotonicClock().toString(),
        raw_response: text,
      };
      assertProviderEvidenceIsSecretFree(raw, [this.apiKey, this.apiSecret]);
      return raw;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Binance read-only request timed out");
      }
      if (error instanceof Error) {
        const safeMessage = redactProviderEvidence(error.message, [this.apiKey, this.apiSecret]);
        throw new Error(String(safeMessage));
      }
      throw new Error("Binance read-only request failed");
    } finally {
      clearTimeout(timeout);
    }
  }

  private requireCredentials(): void {
    if (!this.credentialsConfigured()) {
      throw new Error("Binance read-only API credentials are not configured");
    }
  }
}

function normalizeBaseUrl(value: string): string {
  const parsed = new URL(value);
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "::1" || parsed.hostname === "localhost";
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== "/" && parsed.pathname !== "")) {
    throw new Error("Binance base URL must be a bare origin without credentials, path, query, or fragment");
  }
  if (parsed.protocol !== "https:" && !(loopback && parsed.protocol === "http:")) {
    throw new Error("Binance base URL must use HTTPS unless it is numeric loopback test infrastructure");
  }
  return parsed.origin;
}

function normalizeSymbol(value: string): string {
  const symbol = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{5,24}$/.test(symbol)) {
    throw new Error("Binance symbol must contain 5-24 uppercase alphanumeric characters");
  }
  return symbol;
}

function parseJson(value: string): unknown {
  if (value.length === 0) {
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { error: "non_json_response" };
  }
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function safeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value as number;
}
