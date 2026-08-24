import { bpsToPct, pctToBps, quantityToString, usdToCents, centsToUsd } from "./money.js";
import type { PublicRiskPolicy, RiskPolicy } from "./types.js";

export const DEFAULT_RISK_POLICY: RiskPolicy = {
  schemaVersion: "glitch.crypto.risk-policy.v1",
  dailyLockTargetBps: 50,
  usableBalanceLimitCents: null,
  maxLeverage: 3,
  maxTradeRiskBps: 50,
  maxOpenRiskBps: 100,
  maxDailyLossBps: 200,
  estimatedRoundTripCostBps: 10,
  stressedExitCostBps: 5,
  quantityStepUnits: 10_000,
  minimumNotionalCents: 1_000,
};

export function toPublicPolicy(policy: RiskPolicy): PublicRiskPolicy {
  return {
    schema_version: "glitch.crypto.risk-policy.v1",
    daily_lock_target_pct: bpsToPct(policy.dailyLockTargetBps),
    usable_balance_limit_usd:
      policy.usableBalanceLimitCents === null
        ? null
        : centsToUsd(policy.usableBalanceLimitCents),
    max_leverage: policy.maxLeverage,
    max_trade_risk_pct: bpsToPct(policy.maxTradeRiskBps),
    max_open_risk_pct: bpsToPct(policy.maxOpenRiskBps),
    max_daily_loss_pct: bpsToPct(policy.maxDailyLossBps),
    estimated_round_trip_cost_pct: bpsToPct(policy.estimatedRoundTripCostBps),
    stressed_exit_cost_pct: bpsToPct(policy.stressedExitCostBps),
    quantity_step: quantityToString(policy.quantityStepUnits),
    minimum_notional_usd: centsToUsd(policy.minimumNotionalCents),
  };
}

export function mergePublicPolicy(
  current: RiskPolicy,
  patch: Record<string, unknown>,
): RiskPolicy {
  const next: RiskPolicy = { ...current };

  if ("daily_lock_target_pct" in patch) {
    next.dailyLockTargetBps = pctToBps(requireNumber(patch.daily_lock_target_pct, "daily_lock_target_pct"));
  }
  if ("usable_balance_limit_usd" in patch) {
    const value = patch.usable_balance_limit_usd;
    next.usableBalanceLimitCents = value === null || value === ""
      ? null
      : usdToCents(requireNumber(value, "usable_balance_limit_usd"));
  }
  if ("max_leverage" in patch) {
    next.maxLeverage = requireInteger(patch.max_leverage, "max_leverage");
  }
  if ("max_trade_risk_pct" in patch) {
    next.maxTradeRiskBps = pctToBps(requireNumber(patch.max_trade_risk_pct, "max_trade_risk_pct"));
  }
  if ("max_open_risk_pct" in patch) {
    next.maxOpenRiskBps = pctToBps(requireNumber(patch.max_open_risk_pct, "max_open_risk_pct"));
  }
  if ("max_daily_loss_pct" in patch) {
    next.maxDailyLossBps = pctToBps(requireNumber(patch.max_daily_loss_pct, "max_daily_loss_pct"));
  }
  if ("estimated_round_trip_cost_pct" in patch) {
    next.estimatedRoundTripCostBps = pctToBps(
      requireNumber(patch.estimated_round_trip_cost_pct, "estimated_round_trip_cost_pct"),
    );
  }
  if ("stressed_exit_cost_pct" in patch) {
    next.stressedExitCostBps = pctToBps(
      requireNumber(patch.stressed_exit_cost_pct, "stressed_exit_cost_pct"),
    );
  }

  validatePolicy(next);
  return next;
}

export function validatePolicy(policy: RiskPolicy): void {
  integerRange(policy.dailyLockTargetBps, 1, 1_000, "daily lock target");
  if (policy.usableBalanceLimitCents !== null) {
    integerRange(policy.usableBalanceLimitCents, 1_000, Number.MAX_SAFE_INTEGER, "usable balance limit");
  }
  integerRange(policy.maxLeverage, 1, 10, "max leverage");
  integerRange(policy.maxTradeRiskBps, 1, 500, "max trade risk");
  integerRange(policy.maxOpenRiskBps, policy.maxTradeRiskBps, 1_000, "max open risk");
  integerRange(policy.maxDailyLossBps, policy.maxOpenRiskBps, 2_000, "max daily loss");
  integerRange(policy.estimatedRoundTripCostBps, 0, 500, "estimated round-trip cost");
  integerRange(policy.stressedExitCostBps, 0, 500, "stressed exit cost");
  integerRange(policy.quantityStepUnits, 1, 100_000_000, "quantity step");
  integerRange(policy.minimumNotionalCents, 1, Number.MAX_SAFE_INTEGER, "minimum notional");
}

function requireNumber(value: unknown, name: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a finite number`);
  }
  return parsed;
}

function requireInteger(value: unknown, name: string): number {
  const parsed = requireNumber(value, name);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer`);
  }
  return parsed;
}

function integerRange(value: number, minimum: number, maximum: number, name: string): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
}
