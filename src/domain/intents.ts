import type { TradingIntent } from "./types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIONS = new Set([
  "ENTER_LONG",
  "ENTER_SHORT",
  "HOLD",
  "NOTHING",
  "MOVE_STOP",
  "MOVE_TARGET",
  "REDUCE",
  "EXIT",
]);

export function parseIntent(value: unknown): TradingIntent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("intent must be a JSON object");
  }
  const input = value as Record<string, unknown>;
  requireEqual(input.schema_version, "glitch.crypto.intent.v1", "schema_version");
  const intentId = requireString(input.intent_id, "intent_id");
  if (!UUID_PATTERN.test(intentId)) {
    throw new Error("intent_id must be a UUID");
  }
  requireString(input.packet_id, "packet_id");
  requireString(input.account, "account");
  requireString(input.instrument, "instrument");
  requireString(input.reason, "reason");
  const action = requireString(input.action, "action");
  if (!ACTIONS.has(action)) {
    throw new Error(`unsupported action: ${action}`);
  }

  if (action === "ENTER_LONG" || action === "ENTER_SHORT") {
    requirePositiveNumber(input.stop_price, "stop_price");
    requirePositiveNumber(input.target_price, "target_price");
    optionalPositiveNumber(input.requested_risk_pct, "requested_risk_pct");
    optionalPositiveInteger(input.requested_leverage, "requested_leverage");
  } else if (action === "MOVE_STOP") {
    requireString(input.tranche_id, "tranche_id");
    requirePositiveNumber(input.stop_price, "stop_price");
  } else if (action === "MOVE_TARGET") {
    requireString(input.tranche_id, "tranche_id");
    requirePositiveNumber(input.target_price, "target_price");
  } else if (action === "REDUCE") {
    requireString(input.tranche_id, "tranche_id");
    const fraction = requirePositiveNumber(input.reduce_fraction_pct, "reduce_fraction_pct");
    if (fraction <= 0 || fraction >= 100) {
      throw new Error("reduce_fraction_pct must be greater than 0 and less than 100");
    }
  } else if (action === "EXIT") {
    requireString(input.tranche_id, "tranche_id");
  } else if (action === "HOLD" && input.tranche_id !== undefined) {
    requireString(input.tranche_id, "tranche_id");
  }

  return input as unknown as TradingIntent;
}

function requireEqual(value: unknown, expected: string, name: string): void {
  if (value !== expected) {
    throw new Error(`${name} must equal ${expected}`);
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function requirePositiveNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return value;
}

function optionalPositiveNumber(value: unknown, name: string): void {
  if (value !== undefined) {
    requirePositiveNumber(value, name);
  }
}

function optionalPositiveInteger(value: unknown, name: string): void {
  if (value !== undefined) {
    const parsed = requirePositiveNumber(value, name);
    if (!Number.isInteger(parsed)) {
      throw new Error(`${name} must be an integer`);
    }
  }
}
