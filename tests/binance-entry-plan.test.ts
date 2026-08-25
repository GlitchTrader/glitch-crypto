import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RISK_POLICY } from "../src/domain/policy.js";
import type { DailyStateRecord, RiskPolicy } from "../src/domain/types.js";
import {
  compileBinanceUsdmProtectedEntryPlan,
} from "../src/venue/binance-usdm/entry-plan.js";
import type { BinanceUsdmExecutionContext } from "../src/venue/binance-usdm/execution-context.js";

const NOW = 1_700_000_000_000;
const DAY = "2023-11-14";
const INTENT_ID = "123e4567-e89b-42d3-a456-426614174000";

test("protected-entry risk scales conservatively from 100 to 10000 USDT", () => {
  const plans = [100, 1_000, 10_000].map((balance) => plan(balance));
  for (const result of plans) {
    assert.equal(result.status, "ready");
    assert.ok(result.request);
    assert.ok(result.risk.planned_loss_cents! <= result.risk.risk_budget_cents!);
    assert.equal(quantityUnits(result.request!.quantity) % 100_000, 0);
    assert.equal(result.mutation_authority, false);
    assert.equal(result.engine_binding_authority, false);
  }
  const quantities = plans.map((result) => quantityUnits(result.request!.quantity));
  assert.ok(quantities[0]! < quantities[1]!);
  assert.ok(quantities[1]! < quantities[2]!);
  assert.ok(quantities[2]! >= quantities[1]! * 9);
});

test("usable limit caps sizing without changing venue equity", () => {
  const baseline = plan(1_000);
  const capped = plan(10_000, {
    ...DEFAULT_RISK_POLICY,
    usableBalanceLimitCents: 100_000,
  });
  assert.equal(capped.risk.equity_cents, 1_000_000);
  assert.equal(capped.risk.usable_pot_cents, 100_000);
  assert.equal(capped.request?.quantity, baseline.request?.quantity);
});

test("daily target changes reporting but never entry geometry", () => {
  const first = plan(1_000);
  const higherTarget = plan(1_000, {
    ...DEFAULT_RISK_POLICY,
    dailyLockTargetBps: 100,
  });
  assert.equal(first.request?.quantity, higherTarget.request?.quantity);
  assert.equal(first.request?.stopPrice, higherTarget.request?.stopPrice);
  assert.equal(first.request?.targetPrice, higherTarget.request?.targetPrice);
  assert.ok(
    first.risk.daily_target_profit_cents !==
      higherTarget.risk.daily_target_profit_cents,
  );
});

test("an earned floor and daily loss boundary block new protected risk", () => {
  const ready = plan(1_000);
  const projected = ready.risk.projected_protected_equity_cents!;
  const floorBlocked = compile({
    context: context(1_000),
    daily: daily(1_000, projected + 1),
  });
  assert.equal(floorBlocked.status, "blocked");
  assert.ok(floorBlocked.blockers.includes("projected_protected_equity_violates_active_floor"));

  const lossBlocked = compile({
    context: context(980),
    daily: daily(1_000),
  });
  assert.equal(lossBlocked.status, "blocked");
  assert.ok(lossBlocked.blockers.includes("daily_loss_boundary_reached"));
});

test("current equity activates the daily lock before persistence can lag", () => {
  const state = daily(1_000);
  state.highWaterEquityCents = 100_500;
  const result = compile({ context: context(1_005), daily: state });
  assert.equal(result.risk.active_floor_cents, 100_500);
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.includes("projected_protected_equity_violates_active_floor"));
});

test("the applied cost buffer never undercuts the authenticated taker fee", () => {
  const current = context(1_000);
  const expensive: BinanceUsdmExecutionContext = {
    ...current,
    account: { ...current.account, taker_commission_rate: "0.001" },
  };
  const result = compile({ context: expensive });
  assert.equal(result.risk.venue_round_trip_cost_bps, 20);
  assert.equal(result.risk.applied_round_trip_cost_bps, 20);
  assert.equal(result.risk.total_loss_distance_bps, result.risk.stop_distance_bps! + 25);
});

test("stale context, off-tick geometry, wrong side, and leverage mismatch fail closed", () => {
  const current = context(1_000);
  const stale: BinanceUsdmExecutionContext = {
    ...current,
    observed_utc: new Date(NOW - 1_001).toISOString(),
  };
  const stalePlan = compile({ context: stale });
  assert.ok(stalePlan.blockers.includes("execution_context_stale"));

  const staleDaily = daily(1_000);
  staleDaily.updatedUtc = new Date(NOW - 1_001).toISOString();
  const staleDailyPlan = compile({ daily: staleDaily });
  assert.ok(staleDailyPlan.blockers.includes("daily_state_stale"));

  const offTick = compile({ stopPrice: "59800.05" });
  assert.ok(offTick.blockers.includes("stop_price_off_tick"));

  const wrongSide = compile({ stopPrice: "60100", targetPrice: "59900" });
  assert.ok(wrongSide.blockers.includes("stop_wrong_side_of_executable_price"));
  assert.ok(wrongSide.blockers.includes("target_wrong_side_of_executable_price"));

  const leverage = compile({ requestedLeverage: 2 });
  assert.ok(leverage.blockers.includes("requested_leverage_requires_unsupported_account_mutation"));
  assert.equal(leverage.request, null);
});

test("venue step, minimum, and available margin remain hard constraints", () => {
  const current = context(1_000);
  const noMargin: BinanceUsdmExecutionContext = {
    ...current,
    account: { ...current.account, available_balance: "10" },
  };
  const blocked = compile({ context: noMargin });
  assert.equal(blocked.status, "blocked");
  assert.ok(blocked.blockers.includes("risk_and_margin_produce_no_venue_valid_quantity"));

  const incompatiblePolicyStep = plan(1_000, {
    ...DEFAULT_RISK_POLICY,
    quantityStepUnits: 150_000,
  });
  assert.equal(incompatiblePolicyStep.status, "ready");
  assert.equal(incompatiblePolicyStep.precision.effective_quantity_step, "0.003");
  assert.equal(quantityUnits(incompatiblePolicyStep.request!.quantity) % 300_000, 0);
});

test("the same facts compile the same deeply immutable plan", () => {
  const first = plan(1_000);
  const second = plan(1_000);
  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.risk), true);
  assert.equal(Object.isFrozen(first.request), true);
});

function plan(balance: number, policy: RiskPolicy = DEFAULT_RISK_POLICY) {
  return compile({ context: context(balance), daily: daily(balance), policy });
}

function compile(
  patch: Partial<Parameters<typeof compileBinanceUsdmProtectedEntryPlan>[0]> = {},
) {
  return compileBinanceUsdmProtectedEntryPlan({
    intentId: INTENT_ID,
    direction: "LONG",
    stopPrice: "59800",
    targetPrice: "60300",
    requestedRiskBps: 50,
    context: context(1_000),
    policy: DEFAULT_RISK_POLICY,
    daily: daily(1_000),
    observedAtMs: NOW,
    ...patch,
  });
}

function daily(balance: number, activeFloorCents: number | null = null): DailyStateRecord {
  const cents = balance * 100;
  return {
    day: DAY,
    startEquityCents: cents,
    highWaterEquityCents: Math.max(cents, activeFloorCents ?? 0),
    lockReached: activeFloorCents !== null,
    activeFloorCents,
    updatedUtc: new Date(NOW - 500).toISOString(),
  };
}

function context(balance: number): BinanceUsdmExecutionContext {
  const value = balance.toFixed(2);
  return {
    schema_version: "glitch.crypto.binance-usdm-execution-context.v3",
    venue: "binance-usdm",
    environment: "testnet",
    symbol: "BTCUSDT",
    status: "ready",
    mutation_authority: false,
    engine_binding_authority: false,
    preconditions_satisfied_for_bounded_testnet_entry_exercise: true,
    observed_utc: new Date(NOW - 100).toISOString(),
    preflight_observed_utc: new Date(NOW - 500).toISOString(),
    freshness: {
      preflight_max_age_ms: 300_000,
      depth_max_age_ms: 5_000,
      market_max_age_ms: 5_000,
      private_reconciliation_max_age_ms: 60_000,
      future_tolerance_ms: 5_000,
    },
    account: {
      wallet_balance: value,
      available_balance: value,
      maker_commission_rate: "0.0002",
      taker_commission_rate: "0.0005",
      leverage: 3,
      maximum_leverage: 3,
      last_reconciliation_time: NOW - 500,
      active_position_count: 0,
      active_order_count: 0,
    },
    market: {
      mark_price: "60000.10",
      mark_event_time: NOW - 200,
      last_trade_price: "60000.00",
      last_trade_event_time: NOW - 250,
      best_bid: "60000.00",
      best_ask: "60000.20",
      depth_event_time: NOW - 200,
      depth_update_id: 10,
    },
    contract: {
      tick_size: "0.10",
      market_quantity_step: "0.001",
      market_minimum_quantity: "0.001",
      minimum_notional: "5.00",
    },
    capabilities: {
      protected_entry: true,
      owned_position_full_close: true,
      protection_revision: true,
      restart_reconciliation: true,
      partial_reduction: true,
      stop_replacement: true,
      target_replacement: true,
      native_algo_amendment: false,
    },
    blockers: [],
  };
}

function quantityUnits(value: string): number {
  const [whole = "0", fraction = ""] = value.split(".");
  return Number(whole) * 100_000_000 + Number(fraction.padEnd(8, "0"));
}
