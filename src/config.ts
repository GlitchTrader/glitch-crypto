import { resolve } from "node:path";
import { priceToCents, usdToCents } from "./domain/money.js";
import type { GatewayMode } from "./domain/types.js";
import type { BinanceShadowRuntimeConfig } from "./runtime/binance-shadow-runtime.js";

export type RuntimeMode = "paper" | "binance-shadow";

export interface RuntimeConfig {
  host: "127.0.0.1" | "::1";
  port: number;
  localToken: string;
  operatorToken: string;
  databasePath: string;
  gatewayMode: GatewayMode;
  initialEquityCents: number;
  initialMarkPriceCents: number;
  runtimeMode?: RuntimeMode;
  binanceShadow?: BinanceShadowRuntimeConfig;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): RuntimeConfig {
  const host = (env.GLITCH_LOCAL_HOST ?? "127.0.0.1").trim();
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("GLITCH_LOCAL_HOST must be numeric loopback 127.0.0.1 or ::1");
  }
  const port = integer(env.GLITCH_LOCAL_PORT, 8_791, 1, 65_535, "GLITCH_LOCAL_PORT");
  const localToken = requireToken(env.GLITCH_LOCAL_TOKEN, "GLITCH_LOCAL_TOKEN");
  const operatorToken = requireToken(env.GLITCH_OPERATOR_TOKEN, "GLITCH_OPERATOR_TOKEN");
  if (localToken === operatorToken) {
    throw new Error("model and operator tokens must be different");
  }
  const dataDir = resolve(env.GLITCH_DATA_DIR ?? "./data");
  const gatewayMode = (env.GLITCH_GATEWAY_MODE ?? "shadow") as GatewayMode;
  if (!new Set<GatewayMode>(["disabled", "shadow", "armed"]).has(gatewayMode)) {
    throw new Error("GLITCH_GATEWAY_MODE must be disabled, shadow, or armed");
  }
  const runtimeMode = (env.GLITCH_RUNTIME_MODE ?? "binance-shadow") as RuntimeMode;
  if (!new Set<RuntimeMode>(["paper", "binance-shadow"]).has(runtimeMode)) {
    throw new Error("GLITCH_RUNTIME_MODE must be paper or binance-shadow");
  }
  const initialEquity = finite(env.GLITCH_PAPER_INITIAL_EQUITY_USD, 1_000, 0.01, 1_000_000_000, "initial equity");
  const initialMark = finite(env.GLITCH_PAPER_INITIAL_BTC_PRICE_USD, 60_000, 0.01, 10_000_000, "initial mark");
  const apiKey = (env.GLITCH_BINANCE_USDM_API_KEY ?? "").trim();
  const apiSecret = (env.GLITCH_BINANCE_USDM_API_SECRET ?? "").trim();
  if ((apiKey.length === 0) !== (apiSecret.length === 0)) {
    throw new Error("Binance API key and secret must both be configured or both be blank");
  }
  const includePrivate = booleanValue(env.GLITCH_BINANCE_INCLUDE_PRIVATE, false);
  if (includePrivate && (!apiKey || !apiSecret)) {
    throw new Error("GLITCH_BINANCE_INCLUDE_PRIVATE requires Binance read-only credentials");
  }

  return {
    host,
    port,
    localToken,
    operatorToken,
    databasePath: resolve(dataDir, "glitch-crypto.sqlite"),
    gatewayMode,
    initialEquityCents: usdToCents(initialEquity),
    initialMarkPriceCents: priceToCents(initialMark),
    runtimeMode,
    binanceShadow: {
      baseUrl: (env.GLITCH_BINANCE_USDM_BASE_URL ?? "https://fapi.binance.com").trim(),
      streamsUrl: (env.GLITCH_BINANCE_USDM_STREAMS_URL ?? "wss://fstream.binance.com").trim(),
      symbol: (env.GLITCH_BINANCE_USDM_SYMBOL ?? "BTCUSDT").trim().toUpperCase(),
      apiKey,
      apiSecret,
      includePrivate,
      recvWindowMs: integer(
        env.GLITCH_BINANCE_USDM_RECV_WINDOW_MS,
        5_000,
        1,
        60_000,
        "Binance receive window",
      ),
      timeoutMs: integer(
        env.GLITCH_BINANCE_USDM_TIMEOUT_MS,
        10_000,
        100,
        120_000,
        "Binance timeout",
      ),
      evidencePath: resolve(
        env.GLITCH_BINANCE_USDM_EVIDENCE_PATH ??
          resolve(dataDir, "binance-usdm-shadow.jsonl"),
      ),
      evidenceMaxBytes: integer(
        env.GLITCH_BINANCE_USDM_EVIDENCE_MAX_BYTES,
        32 * 1024 * 1024,
        1_024,
        512 * 1024 * 1024,
        "Binance evidence maximum bytes",
      ),
      evaluationIntervalMs: integer(
        env.GLITCH_SHADOW_EVALUATION_INTERVAL_MS,
        250,
        50,
        10_000,
        "shadow evaluation interval",
      ),
      candidateCooldownMs: integer(
        env.GLITCH_SHADOW_CANDIDATE_COOLDOWN_MS,
        30_000,
        1_000,
        300_000,
        "shadow candidate cooldown",
      ),
      positionReviewMs: integer(
        env.GLITCH_SHADOW_POSITION_REVIEW_MS,
        5_000,
        500,
        300_000,
        "shadow position review interval",
      ),
      eventLifetimeMs: integer(
        env.GLITCH_SHADOW_EVENT_LIFETIME_MS,
        180_000,
        5_000,
        600_000,
        "shadow event lifetime",
      ),
      opportunity: {
        minimumTrades: integer(
          env.GLITCH_SHADOW_MINIMUM_TRADES,
          20,
          1,
          10_000,
          "shadow minimum trades",
        ),
        minimumDirectionalBps: finite(
          env.GLITCH_SHADOW_MINIMUM_DIRECTIONAL_BPS,
          4,
          0,
          1_000,
          "shadow minimum directional bps",
        ),
        minimumGrossMoveBps: finite(
          env.GLITCH_SHADOW_MINIMUM_GROSS_MOVE_BPS,
          10,
          0,
          5_000,
          "shadow minimum gross move bps",
        ),
        minimumConservativeEdgeBps: finite(
          env.GLITCH_SHADOW_MINIMUM_EDGE_BPS,
          1.5,
          0,
          1_000,
          "shadow minimum conservative edge bps",
        ),
        estimatedRoundTripCostBps: finite(
          env.GLITCH_SHADOW_ESTIMATED_ROUND_TRIP_COST_BPS,
          10,
          0,
          1_000,
          "shadow estimated round-trip cost bps",
        ),
        maximumMarketAgeMs: integer(
          env.GLITCH_SHADOW_MAXIMUM_MARKET_AGE_MS,
          3_000,
          100,
          120_000,
          "shadow maximum market age",
        ),
      },
    },
  };
}

function requireToken(value: string | undefined, name: string): string {
  const token = (value ?? "").trim();
  if (token.length < 16) {
    throw new Error(`${name} must contain at least 16 characters`);
  }
  return token;
}

function integer(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const parsed = value === undefined || value.trim() === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function finite(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const parsed = value === undefined || value.trim() === "" ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  throw new Error("Boolean environment values must be true/false, 1/0, or yes/no");
}
