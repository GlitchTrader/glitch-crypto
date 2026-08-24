import { redactProviderEvidence } from "./redaction.js";

export interface BinanceUsdmListenKeyClientConfig {
  baseUrl?: string;
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface BinanceUsdmListenKeySession {
  create(): Promise<string>;
  keepAlive(): Promise<void>;
  close(): Promise<void>;
}

export class BinanceUsdmListenKeyClient implements BinanceUsdmListenKeySession {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: BinanceUsdmListenKeyClientConfig) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl ?? "https://fapi.binance.com");
    this.apiKey = config.apiKey.trim();
    if (!this.apiKey) {
      throw new Error("Binance API key is required for a user-data stream");
    }
    this.timeoutMs = config.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 60_000) {
      throw new Error("Binance listen-key timeout must be an integer between 100 and 60000 milliseconds");
    }
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async create(): Promise<string> {
    const payload = objectValue(await this.request("POST"), "listen-key response");
    const listenKey = payload.listenKey;
    if (typeof listenKey !== "string" || listenKey.length < 8) {
      throw new Error("Binance user-data stream returned an invalid listen key");
    }
    return listenKey;
  }

  async keepAlive(): Promise<void> {
    await this.request("PUT");
  }

  async close(): Promise<void> {
    await this.request("DELETE");
  }

  private async request(method: "POST" | "PUT" | "DELETE"): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/fapi/v1/listenKey`, {
        method,
        headers: {
          Accept: "application/json",
          "X-MBX-APIKEY": this.apiKey,
        },
        signal: controller.signal,
      });
      const text = await response.text();
      const payload = parseJson(text);
      if (!response.ok) {
        const safe = redactProviderEvidence(payload, [this.apiKey]);
        throw new Error(`Binance listen-key request failed with HTTP ${response.status}: ${JSON.stringify(safe)}`);
      }
      return payload;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Binance listen-key request timed out");
      }
      if (error instanceof Error) {
        throw new Error(String(redactProviderEvidence(error.message, [this.apiKey])));
      }
      throw new Error("Binance listen-key request failed");
    } finally {
      clearTimeout(timeout);
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
    throw new Error("Binance base URL must use HTTPS unless it is loopback test infrastructure");
  }
  return parsed.origin;
}

function parseJson(value: string): unknown {
  if (!value) {
    return {};
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
