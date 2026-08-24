import { resolve } from "node:path";
import { priceToCents, usdToCents } from "./domain/money.js";
import type { GatewayMode } from "./domain/types.js";

export interface RuntimeConfig {
  host: "127.0.0.1" | "::1";
  port: number;
  localToken: string;
  operatorToken: string;
  databasePath: string;
  gatewayMode: GatewayMode;
  initialEquityCents: number;
  initialMarkPriceCents: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): RuntimeConfig {
  const host = (env.GLITCH_LOCAL_HOST ?? "127.0.0.1").trim();
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("GLITCH_LOCAL_HOST must be numeric loopback 127.0.0.1 or ::1");
  }
  const port = Number(env.GLITCH_LOCAL_PORT ?? "8791");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("GLITCH_LOCAL_PORT must be an integer between 1 and 65535");
  }
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
  const initialEquity = Number(env.GLITCH_PAPER_INITIAL_EQUITY_USD ?? "1000");
  const initialMark = Number(env.GLITCH_PAPER_INITIAL_BTC_PRICE_USD ?? "60000");
  return {
    host,
    port,
    localToken,
    operatorToken,
    databasePath: resolve(dataDir, "glitch-crypto.sqlite"),
    gatewayMode,
    initialEquityCents: usdToCents(initialEquity),
    initialMarkPriceCents: priceToCents(initialMark),
  };
}

function requireToken(value: string | undefined, name: string): string {
  const token = (value ?? "").trim();
  if (token.length < 16) {
    throw new Error(`${name} must contain at least 16 characters`);
  }
  return token;
}
