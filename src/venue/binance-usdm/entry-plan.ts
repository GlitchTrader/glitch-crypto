import { validatePolicy } from "../../domain/policy.js";
import type { DailyStateRecord, RiskPolicy } from "../../domain/types.js";
import {
  validateBinanceUsdmProtectedEntry,
  type BinanceUsdmProtectedEntryRequest,
  type BinanceUsdmPositionDirection,
} from "./mutation-contract.js";
import type { BinanceUsdmExecutionContext } from "./execution-context.js";

const QUANTITY_SCALE = 100_000_000;

export interface CompileBinanceUsdmProtectedEntryPlanInput {
  intentId: string;
  direction: BinanceUsdmPositionDirection;
  stopPrice: string;
  targetPrice: string;
  requestedRiskBps?: number;
  requestedLeverage?: number;
  context: BinanceUsdmExecutionContext;
  policy: RiskPolicy;
  daily: DailyStateRecord;
  observedAtMs: number;
  contextMaxAgeMs?: number;
  dailyMaxAgeMs?: number;
}

export interface BinanceUsdmProtectedEntryPlan {
  readonly schema_version: "glitch.crypto.binance-usdm-protected-entry-plan.v1";
  readonly venue: "binance-usdm";
  readonly environment: "testnet";
  readonly status: "ready" | "blocked";
  readonly mutation_authority: false;
  readonly engine_binding_authority: false;
  readonly observed_utc: string;
  readonly context_observed_utc: string;
  readonly request: Readonly<BinanceUsdmProtectedEntryRequest> | null;
  readonly risk: Readonly<{
    equity_cents: number | null;
    available_balance_cents: number | null;
    usable_pot_cents: number | null;
    daily_start_pot_cents: number | null;
    daily_target_profit_cents: number | null;
    daily_loss_boundary_cents: number | null;
    active_floor_cents: number | null;
    risk_budget_cents: number | null;
    planned_loss_cents: number | null;
    projected_protected_equity_cents: number | null;
    notional_cents: number | null;
    margin_required_cents: number | null;
    stop_distance_bps: number | null;
    total_loss_distance_bps: number | null;
    venue_round_trip_cost_bps: number | null;
    applied_round_trip_cost_bps: number | null;
    leverage: number | null;
  }>;
  readonly precision: Readonly<{
    tick_size: string;
    venue_quantity_step: string;
    effective_quantity_step: string | null;
    venue_minimum_quantity: string;
    effective_minimum_notional_cents: number | null;
  }>;
  readonly blockers: readonly string[];
}

export function compileBinanceUsdmProtectedEntryPlan(
  input: CompileBinanceUsdmProtectedEntryPlanInput,
): BinanceUsdmProtectedEntryPlan {
  validatePolicy(input.policy);
  const observedAtMs = integer(input.observedAtMs, 1, Number.MAX_SAFE_INTEGER, "entry-plan observation time");
  const contextMaxAgeMs = integer(input.contextMaxAgeMs ?? 1_000, 1, 60_000, "entry context maximum age");
  const dailyMaxAgeMs = integer(input.dailyMaxAgeMs ?? 1_000, 1, 60_000, "daily state maximum age");
  const blockers: string[] = [];
  const context = input.context;

  if (
    context.schema_version !== "glitch.crypto.binance-usdm-execution-context.v3" ||
    context.venue !== "binance-usdm" ||
    context.environment !== "testnet" ||
    context.mutation_authority !== false ||
    context.engine_binding_authority !== false
  ) {
    blockers.push("execution_context_contract_invalid");
  }
  if (context.status !== "ready" || context.blockers.length > 0) {
    blockers.push("execution_context_not_ready");
  }
  if (
    context.preconditions_satisfied_for_bounded_testnet_entry_exercise !== true ||
    context.capabilities.protected_entry !== true ||
    context.account.active_position_count !== 0 ||
    context.account.active_order_count !== 0
  ) {
    blockers.push("execution_context_entry_preconditions_invalid");
  }
  if (context.symbol !== "BTCUSDT") {
    blockers.push("unsupported_entry_symbol");
  }
  checkFreshness(
    context.observed_utc,
    observedAtMs,
    contextMaxAgeMs,
    "execution_context",
    blockers,
  );

  const equityCents = decimalToScaled(context.account.wallet_balance, 2, "floor");
  const availableCents = decimalToScaled(context.account.available_balance, 2, "floor");
  const entryPriceCents = decimalToScaled(
    input.direction === "LONG" ? context.market.best_ask : context.market.best_bid,
    2,
    "exact",
  );
  const stopPriceCents = decimalToScaled(input.stopPrice, 2, "exact");
  const targetPriceCents = decimalToScaled(input.targetPrice, 2, "exact");
  const tickCents = decimalToScaled(context.contract.tick_size, 2, "exact");
  const venueStepUnits = decimalToScaled(context.contract.market_quantity_step, 8, "exact");
  const venueMinimumQuantityUnits = decimalToScaled(
    context.contract.market_minimum_quantity,
    8,
    "exact",
  );
  const venueMinimumNotionalCents = decimalToScaled(
    context.contract.minimum_notional,
    2,
    "ceil",
  );
  const takerRateUnits = decimalToScaled(
    context.account.taker_commission_rate,
    8,
    "ceil",
  );
  if (equityCents === null || equityCents <= 0) blockers.push("positive_equity_not_proven");
  if (availableCents === null || availableCents <= 0) blockers.push("positive_available_balance_not_proven");
  if (entryPriceCents === null || entryPriceCents <= 0) blockers.push("cent_exact_executable_price_not_proven");
  if (stopPriceCents === null || stopPriceCents <= 0) blockers.push("stop_price_not_cent_exact");
  if (targetPriceCents === null || targetPriceCents <= 0) blockers.push("target_price_not_cent_exact");
  if (tickCents === null || tickCents <= 0) blockers.push("cent_exact_tick_not_supported");
  if (venueStepUnits === null || venueStepUnits <= 0) blockers.push("venue_quantity_step_invalid");
  if (venueMinimumQuantityUnits === null || venueMinimumQuantityUnits <= 0) blockers.push("venue_minimum_quantity_invalid");
  if (venueMinimumNotionalCents === null || venueMinimumNotionalCents <= 0) blockers.push("venue_minimum_notional_invalid");
  if (takerRateUnits === null) blockers.push("venue_taker_fee_invalid");

  if (input.direction !== "LONG" && input.direction !== "SHORT") {
    blockers.push("entry_direction_invalid");
  }
  if (
    stopPriceCents !== null && targetPriceCents !== null && entryPriceCents !== null
  ) {
    if (
      (input.direction === "LONG" && stopPriceCents >= entryPriceCents) ||
      (input.direction === "SHORT" && stopPriceCents <= entryPriceCents)
    ) {
      blockers.push("stop_wrong_side_of_executable_price");
    }
    if (
      (input.direction === "LONG" && targetPriceCents <= entryPriceCents) ||
      (input.direction === "SHORT" && targetPriceCents >= entryPriceCents)
    ) {
      blockers.push("target_wrong_side_of_executable_price");
    }
  }
  if (tickCents !== null && tickCents > 0) {
    if (stopPriceCents !== null && stopPriceCents % tickCents !== 0) blockers.push("stop_price_off_tick");
    if (targetPriceCents !== null && targetPriceCents % tickCents !== 0) blockers.push("target_price_off_tick");
  }

  const contextLeverage = context.account.leverage;
  if (
    contextLeverage === null ||
    !Number.isInteger(contextLeverage) ||
    contextLeverage < 1 ||
    contextLeverage > input.policy.maxLeverage
  ) {
    blockers.push("configured_leverage_outside_policy");
  }
  if (
    input.requestedLeverage !== undefined &&
    input.requestedLeverage !== contextLeverage
  ) {
    blockers.push("requested_leverage_requires_unsupported_account_mutation");
  }
  const riskBps = input.requestedRiskBps ?? input.policy.maxTradeRiskBps;
  if (!Number.isInteger(riskBps) || riskBps < 1 || riskBps > input.policy.maxTradeRiskBps) {
    blockers.push("requested_risk_outside_policy");
  }

  const observedDay = new Date(observedAtMs).toISOString().slice(0, 10);
  if (
    input.daily.day !== observedDay ||
    !Number.isSafeInteger(input.daily.startEquityCents) ||
    input.daily.startEquityCents <= 0 ||
    !Number.isSafeInteger(input.daily.highWaterEquityCents) ||
    input.daily.highWaterEquityCents < input.daily.startEquityCents ||
    (input.daily.activeFloorCents !== null && (
      !Number.isSafeInteger(input.daily.activeFloorCents) ||
      input.daily.activeFloorCents <= 0
    )) ||
    input.daily.lockReached !== (input.daily.activeFloorCents !== null)
  ) {
    blockers.push("daily_state_invalid_or_wrong_epoch");
  }
  checkFreshness(
    input.daily.updatedUtc,
    observedAtMs,
    dailyMaxAgeMs,
    "daily_state",
    blockers,
  );
  if (equityCents !== null && input.daily.highWaterEquityCents < equityCents) {
    blockers.push("daily_state_not_reconciled_to_current_equity");
  }

  let request: BinanceUsdmProtectedEntryRequest | null = null;
  let usablePotCents: number | null = null;
  let dailyStartPotCents: number | null = null;
  let dailyTargetProfitCents: number | null = null;
  let dailyLossBoundaryCents: number | null = null;
  let riskBudgetCents: number | null = null;
  let plannedLossCents: number | null = null;
  let projectedProtectedEquityCents: number | null = null;
  let notionalCents: number | null = null;
  let marginRequiredCents: number | null = null;
  let stopDistanceBps: number | null = null;
  let totalLossDistanceBps: number | null = null;
  let venueRoundTripCostBps: number | null = null;
  let appliedRoundTripCostBps: number | null = null;
  let effectiveStepUnits: number | null = null;
  let effectiveMinimumNotionalCents: number | null = null;
  let activeFloorCents = input.daily.activeFloorCents;

  if (
    equityCents !== null && equityCents > 0 &&
    availableCents !== null && availableCents > 0 &&
    entryPriceCents !== null && entryPriceCents > 0 &&
    stopPriceCents !== null && stopPriceCents > 0 &&
    targetPriceCents !== null && targetPriceCents > 0 &&
    venueStepUnits !== null && venueStepUnits > 0 &&
    venueMinimumQuantityUnits !== null && venueMinimumQuantityUnits > 0 &&
    venueMinimumNotionalCents !== null && venueMinimumNotionalCents > 0 &&
    takerRateUnits !== null &&
    contextLeverage !== null && Number.isInteger(contextLeverage) && contextLeverage > 0 &&
    Number.isInteger(riskBps) && riskBps > 0 &&
    !blockers.includes("daily_state_invalid_or_wrong_epoch")
  ) {
    usablePotCents = Math.min(
      equityCents,
      input.policy.usableBalanceLimitCents ?? equityCents,
    );
    dailyStartPotCents = Math.min(
      input.daily.startEquityCents,
      input.policy.usableBalanceLimitCents ?? input.daily.startEquityCents,
    );
    dailyTargetProfitCents = floorBps(dailyStartPotCents, input.policy.dailyLockTargetBps);
    const dailyTargetEquityCents = input.daily.startEquityCents + dailyTargetProfitCents;
    if (equityCents >= dailyTargetEquityCents) {
      activeFloorCents = Math.max(activeFloorCents ?? 0, dailyTargetEquityCents);
    }
    dailyLossBoundaryCents = input.daily.startEquityCents -
      floorBps(dailyStartPotCents, input.policy.maxDailyLossBps);
    if (equityCents <= dailyLossBoundaryCents) blockers.push("daily_loss_boundary_reached");
    if (activeFloorCents !== null && equityCents < activeFloorCents) {
      blockers.push("active_daily_floor_not_currently_protected");
    }

    stopDistanceBps = ceilRatio(
      Math.abs(entryPriceCents - stopPriceCents),
      10_000,
      entryPriceCents,
    );
    venueRoundTripCostBps = ceilRatio(takerRateUnits, 20_000, 100_000_000);
    appliedRoundTripCostBps = Math.max(
      input.policy.estimatedRoundTripCostBps,
      venueRoundTripCostBps,
    );
    totalLossDistanceBps = stopDistanceBps +
      appliedRoundTripCostBps +
      input.policy.stressedExitCostBps;
    riskBudgetCents = floorBps(usablePotCents, riskBps);
    const notionalByRisk = floorRatio(
      riskBudgetCents,
      10_000,
      totalLossDistanceBps,
    );
    const marginBudgetCents = Math.min(usablePotCents, availableCents);
    const notionalByMargin = marginBudgetCents * contextLeverage;
    const requestedNotionalCents = Math.min(notionalByRisk, notionalByMargin);
    effectiveStepUnits = leastCommonMultiple(
      input.policy.quantityStepUnits,
      venueStepUnits,
    );
    const rawQuantityUnits = floorRatio(
      requestedNotionalCents,
      QUANTITY_SCALE,
      entryPriceCents,
    );
    const quantityUnits = Math.floor(rawQuantityUnits / effectiveStepUnits) * effectiveStepUnits;
    notionalCents = ceilRatio(entryPriceCents, quantityUnits, QUANTITY_SCALE);
    marginRequiredCents = ceilDiv(notionalCents, contextLeverage);
    plannedLossCents = ceilRatio(notionalCents, totalLossDistanceBps, 10_000);
    projectedProtectedEquityCents = equityCents - plannedLossCents;
    effectiveMinimumNotionalCents = Math.max(
      input.policy.minimumNotionalCents,
      venueMinimumNotionalCents,
    );

    if (quantityUnits < venueMinimumQuantityUnits || notionalCents < effectiveMinimumNotionalCents) {
      blockers.push("risk_and_margin_produce_no_venue_valid_quantity");
    }
    if (marginRequiredCents > marginBudgetCents) blockers.push("available_margin_exceeded");
    if (plannedLossCents > riskBudgetCents) blockers.push("planned_loss_exceeds_trade_risk_budget");
    if (plannedLossCents > floorBps(usablePotCents, input.policy.maxOpenRiskBps)) {
      blockers.push("projected_open_risk_exceeds_policy");
    }
    if (projectedProtectedEquityCents <= dailyLossBoundaryCents) {
      blockers.push("projected_protected_equity_reaches_daily_loss_boundary");
    }
    if (
      activeFloorCents !== null &&
      projectedProtectedEquityCents < activeFloorCents
    ) {
      blockers.push("projected_protected_equity_violates_active_floor");
    }

    if (blockers.length === 0) {
      try {
        request = validateBinanceUsdmProtectedEntry({
          intentId: input.intentId,
          symbol: context.symbol,
          direction: input.direction,
          quantity: quantityString(quantityUnits),
          stopPrice: centsString(stopPriceCents),
          targetPrice: centsString(targetPriceCents),
        });
      } catch {
        blockers.push("canonical_protected_entry_request_invalid");
      }
    }
  }

  const uniqueBlockers = [...new Set(blockers)].sort();
  return deepFreeze({
    schema_version: "glitch.crypto.binance-usdm-protected-entry-plan.v1",
    venue: "binance-usdm",
    environment: "testnet",
    status: uniqueBlockers.length === 0 && request !== null ? "ready" : "blocked",
    mutation_authority: false,
    engine_binding_authority: false,
    observed_utc: new Date(observedAtMs).toISOString(),
    context_observed_utc: context.observed_utc,
    request,
    risk: {
      equity_cents: equityCents,
      available_balance_cents: availableCents,
      usable_pot_cents: usablePotCents,
      daily_start_pot_cents: dailyStartPotCents,
      daily_target_profit_cents: dailyTargetProfitCents,
      daily_loss_boundary_cents: dailyLossBoundaryCents,
      active_floor_cents: activeFloorCents,
      risk_budget_cents: riskBudgetCents,
      planned_loss_cents: plannedLossCents,
      projected_protected_equity_cents: projectedProtectedEquityCents,
      notional_cents: notionalCents,
      margin_required_cents: marginRequiredCents,
      stop_distance_bps: stopDistanceBps,
      total_loss_distance_bps: totalLossDistanceBps,
      venue_round_trip_cost_bps: venueRoundTripCostBps,
      applied_round_trip_cost_bps: appliedRoundTripCostBps,
      leverage: contextLeverage,
    },
    precision: {
      tick_size: context.contract.tick_size,
      venue_quantity_step: context.contract.market_quantity_step,
      effective_quantity_step: effectiveStepUnits === null
        ? null
        : quantityString(effectiveStepUnits),
      venue_minimum_quantity: context.contract.market_minimum_quantity,
      effective_minimum_notional_cents: effectiveMinimumNotionalCents,
    },
    blockers: uniqueBlockers,
  });
}

function checkFreshness(
  value: string,
  observedAtMs: number,
  maximumAgeMs: number,
  prefix: string,
  blockers: string[],
): void {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) blockers.push(`${prefix}_time_invalid`);
  else if (time > observedAtMs) blockers.push(`${prefix}_time_in_future`);
  else if (observedAtMs - time > maximumAgeMs) blockers.push(`${prefix}_stale`);
}

function decimalToScaled(
  value: unknown,
  digits: number,
  rounding: "exact" | "floor" | "ceil",
): number | null {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
  const [whole = "0", fraction = ""] = value.split(".");
  const kept = fraction.slice(0, digits).padEnd(digits, "0");
  const discarded = fraction.slice(digits);
  if (rounding === "exact" && /[1-9]/.test(discarded)) return null;
  let scaled = BigInt(whole) * (10n ** BigInt(digits)) + BigInt(kept || "0");
  if (rounding === "ceil" && /[1-9]/.test(discarded)) scaled += 1n;
  return scaled <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(scaled) : null;
}

function floorBps(value: number, bps: number): number {
  return floorRatio(value, bps, 10_000);
}

function ceilDiv(numerator: number, denominator: number): number {
  return Math.ceil(numerator / denominator);
}

function floorRatio(left: number, right: number, denominator: number): number {
  return safeBigIntNumber(
    (BigInt(left) * BigInt(right)) / BigInt(denominator),
    "floor ratio",
  );
}

function ceilRatio(left: number, right: number, denominator: number): number {
  const numerator = BigInt(left) * BigInt(right);
  const divisor = BigInt(denominator);
  return safeBigIntNumber(
    (numerator + divisor - 1n) / divisor,
    "ceiling ratio",
  );
}

function safeBigIntNumber(value: bigint, name: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${name} exceeds safe integer range`);
  }
  return Number(value);
}

function leastCommonMultiple(left: number, right: number): number {
  const result = (left / greatestCommonDivisor(left, right)) * right;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new Error("effective quantity step exceeds safe integer range");
  }
  return result;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = left;
  let b = right;
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function quantityString(units: number): string {
  const whole = Math.floor(units / QUANTITY_SCALE);
  const fraction = String(units % QUANTITY_SCALE).padStart(8, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function centsString(cents: number): string {
  const whole = Math.floor(cents / 100);
  const fraction = String(cents % 100).padStart(2, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function integer(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
