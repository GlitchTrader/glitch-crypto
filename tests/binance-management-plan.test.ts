import test from "node:test";
import assert from "node:assert/strict";
import type { RiskPolicy } from "../src/domain/types.js";
import {
  compileBinanceUsdmProtectionManagementPlan,
  type CompileBinanceUsdmProtectionManagementPlanInput,
} from "../src/venue/binance-usdm/management-plan.js";
import { deriveBinanceUsdmMutationIds } from "../src/venue/binance-usdm/mutation-contract.js";
import type { BinanceUsdmOwnedProtectionBinding } from "../src/venue/binance-usdm/owned-protection-state.js";
import type { BinanceUsdmShadowEvidence } from "../src/venue/binance-usdm/shadow-client.js";

const NOW = Date.parse("2026-08-25T05:00:00.000Z");
const POSITION_INTENT = "123e4567-e89b-42d3-a456-426614174000";
const REVISION_INTENT = "223e4567-e89b-42d3-a456-426614174000";

test("management plan derives an exact protected partial from fresh Testnet truth", () => {
  const plan = compileBinanceUsdmProtectionManagementPlan(readyInput());

  assert.equal(plan.status, "ready");
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.mutation_authority, false);
  assert.equal(plan.engine_binding_authority, false);
  assert.equal(plan.request?.reductionQuantity, "0.05");
  assert.equal(plan.precision.derived_reduction_quantity, "0.05");
  assert.equal(plan.precision.remaining_quantity, "0.05");
  assert.equal(plan.market.reduction_executable_price, "104.90");
  assert.equal(plan.risk.current_protected_equity_cents, 100_008);
  assert.equal(plan.risk.projected_protected_equity_cents, 100_037);
  assert.equal(plan.risk.reduction_realized_pnl_cents, 24);
  assert.equal(plan.risk.reduction_cost_cents, 1);
  assert.equal(plan.risk.projected_open_risk_cents, 11);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.request), true);
  assert.equal(JSON.stringify(plan).includes("secret"), false);
});

test("target-only revision preserves downside proof and daily objective does not choose geometry", () => {
  const first = readyInput();
  first.requestedReductionBps = null;
  first.nextStopPrice = "101.00";
  first.nextTargetPrice = "112.00";
  first.daily.activeFloorCents = null;
  first.daily.lockReached = false;
  const second = structuredClone(first);
  second.policy.dailyLockTargetBps = 75;

  const plan50 = compileBinanceUsdmProtectionManagementPlan(first);
  const plan75 = compileBinanceUsdmProtectionManagementPlan(second);

  assert.equal(plan50.status, "ready");
  assert.equal(plan75.status, "ready");
  assert.deepEqual(plan50.request, plan75.request);
  assert.equal(plan50.request?.reductionQuantity, null);
  assert.equal(plan50.risk.projected_protected_equity_cents, plan50.risk.current_protected_equity_cents);
  assert.ok(plan50.risk.daily_target_profit_cents !== plan75.risk.daily_target_profit_cents);
});

test("a revision cannot weaken total protected equity even while still above the daily floor", () => {
  const input = readyInput();
  input.requestedReductionBps = null;
  input.nextStopPrice = "100.00";

  const plan = compileBinanceUsdmProtectionManagementPlan(input);

  assert.equal(plan.status, "blocked");
  assert.equal(plan.request, null);
  assert.ok(plan.blockers.includes("revision_would_weaken_protected_equity"));
  assert.ok((plan.risk.projected_protected_equity_cents ?? 0) > (plan.risk.active_floor_cents ?? 0));
});

test("tick, safe-side, reduction, and surviving-position minimums fail closed", () => {
  const wrongSide = readyInput();
  wrongSide.nextStopPrice = "105.10";
  assert.ok(
    compileBinanceUsdmProtectionManagementPlan(wrongSide).blockers.includes("next_stop_wrong_side_of_mark"),
  );

  const offTick = readyInput();
  offTick.nextStopPrice = "103.05";
  assert.ok(
    compileBinanceUsdmProtectionManagementPlan(offTick).blockers.includes("next_stop_price_off_tick"),
  );

  const zeroPartial = readyInput();
  zeroPartial.requestedReductionBps = 1;
  assert.ok(
    compileBinanceUsdmProtectionManagementPlan(zeroPartial).blockers.includes("requested_reduction_rounds_to_zero"),
  );

  const dust = readyInput();
  dust.requestedReductionBps = 9_900;
  assert.ok(
    compileBinanceUsdmProtectionManagementPlan(dust).blockers.includes("remaining_notional_below_effective_minimum"),
  );

  const invalidBps = readyInput();
  invalidBps.requestedReductionBps = 10_000;
  assert.ok(
    compileBinanceUsdmProtectionManagementPlan(invalidBps).blockers.includes("requested_reduction_bps_invalid"),
  );
});

test("stale, production, public-only, contradictory, and unsafe evidence cannot produce a request", () => {
  const cases: Array<{ blocker: string; mutate: (input: CompileBinanceUsdmProtectionManagementPlanInput) => void }> = [
    {
      blocker: "management_evidence_stale",
      mutate: (input) => { input.evidence.observed_utc = new Date(NOW - 5_001).toISOString(); },
    },
    {
      blocker: "authenticated_testnet_management_evidence_invalid",
      mutate: (input) => { input.evidence.base_url_origin = "https://fapi.binance.com"; },
    },
    {
      blocker: "authenticated_testnet_management_evidence_invalid",
      mutate: (input) => { input.evidence.credential_mode = "public_only"; },
    },
    {
      blocker: "owned_snapshot_position_quantity_mismatch",
      mutate: (input) => {
        const position = (input.evidence.private?.positions as Array<Record<string, unknown>>)[0]!;
        position.positionAmt = "0.200";
      },
    },
    {
      blocker: "isolated_margin_not_proven",
      mutate: (input) => {
        const config = (input.evidence.private?.symbol_configuration as Array<Record<string, unknown>>)[0]!;
        config.marginType = "CROSSED";
      },
    },
    {
      blocker: "unowned_active_ordinary_orders_present",
      mutate: (input) => { if (input.evidence.private) input.evidence.private.open_orders = [{ orderId: 1 }]; },
    },
  ];

  for (const item of cases) {
    const input = readyInput();
    item.mutate(input);
    const plan = compileBinanceUsdmProtectionManagementPlan(input);
    assert.equal(plan.status, "blocked", item.blocker);
    assert.equal(plan.request, null, item.blocker);
    assert.ok(plan.blockers.includes(item.blocker), item.blocker);
  }
});

test("malformed private snapshots and non-ready ownership bind fail closed", () => {
  const malformed = readyInput();
  if (malformed.evidence.private) malformed.evidence.private.positions = {};
  const malformedPlan = compileBinanceUsdmProtectionManagementPlan(malformed);
  assert.equal(malformedPlan.status, "blocked");
  assert.ok(malformedPlan.blockers.includes("management_position_snapshot_invalid"));
  assert.ok(malformedPlan.blockers.includes("single_owned_native_position_not_proven"));

  const unbound = readyInput();
  unbound.binding = {
    ...unbound.binding,
    status: "blocked",
    management_preconditions_satisfied: false,
    blockers: ["exact_owned_stop_not_proven"],
  };
  const unboundPlan = compileBinanceUsdmProtectionManagementPlan(unbound);
  assert.equal(unboundPlan.status, "blocked");
  assert.ok(unboundPlan.blockers.includes("owned_protection_binding_not_ready"));
});

test("SHORT partial uses the executable ask and authenticated fees set the cost floor", () => {
  const input = readyInput("SHORT");
  const commission = input.evidence.private?.commission_rate as Record<string, unknown>;
  commission.takerCommissionRate = "0.001";

  const plan = compileBinanceUsdmProtectionManagementPlan(input);

  assert.equal(plan.status, "ready", JSON.stringify(plan.blockers));
  assert.equal(plan.market.reduction_executable_price, "105.10");
  assert.equal(plan.risk.venue_round_trip_cost_bps, 20);
  assert.equal(plan.risk.applied_exit_cost_bps, 25);
  assert.equal(plan.request?.current.direction, "SHORT");
  assert.equal(plan.request?.reductionQuantity, "0.05");
});

function readyInput(
  direction: "LONG" | "SHORT" = "LONG",
): CompileBinanceUsdmProtectionManagementPlanInput {
  return {
    revisionIntentId: REVISION_INTENT,
    binding: readyBinding(direction),
    evidence: readyEvidence(direction),
    policy: policy(),
    daily: {
      day: "2026-08-25",
      startEquityCents: 99_500,
      highWaterEquityCents: 100_050,
      lockReached: true,
      activeFloorCents: 99_997,
      updatedUtc: new Date(NOW - 100).toISOString(),
    },
    nextStopPrice: direction === "LONG" ? "103.00" : "107.00",
    nextTargetPrice: direction === "LONG" ? "108.00" : "102.00",
    requestedReductionBps: 5_000,
    observedAtMs: NOW,
  };
}

function policy(): RiskPolicy {
  return {
    schemaVersion: "glitch.crypto.risk-policy.v1",
    dailyLockTargetBps: 50,
    usableBalanceLimitCents: null,
    maxLeverage: 3,
    maxTradeRiskBps: 50,
    maxOpenRiskBps: 200,
    maxDailyLossBps: 500,
    estimatedRoundTripCostBps: 10,
    stressedExitCostBps: 5,
    quantityStepUnits: 100_000,
    minimumNotionalCents: 500,
  };
}

function readyBinding(direction: "LONG" | "SHORT"): BinanceUsdmOwnedProtectionBinding {
  const ids = deriveBinanceUsdmMutationIds(POSITION_INTENT);
  const quantity = "0.1";
  const stopPrice = direction === "LONG" ? "101" : "109";
  const targetPrice = direction === "LONG" ? "110" : "100";
  const side = direction === "LONG" ? "SELL" : "BUY";
  const current = {
    positionIntentId: POSITION_INTENT,
    symbol: "BTCUSDT",
    direction,
    quantity,
    stopPrice,
    targetPrice,
    stopClientAlgoId: ids.stopClientAlgoId,
    targetClientAlgoId: ids.targetClientAlgoId,
  };
  return {
    schema_version: "glitch.crypto.binance-usdm-owned-protection-binding.v1",
    venue: "binance-usdm",
    environment: "testnet",
    status: "ready",
    mutation_authority: false,
    engine_binding_authority: false,
    management_preconditions_satisfied: true,
    observed_utc: new Date(NOW - 100).toISOString(),
    state_body_hash: "a".repeat(64),
    transition_sequence: 2,
    current,
    pending: null,
    native_position: {
      symbol: "BTCUSDT",
      direction,
      quantity,
      entry_price: direction === "LONG" ? "100" : "110",
      break_even_price: direction === "LONG" ? "100.1" : "109.9",
      unrealized_pnl: "0.5",
    },
    protection: {
      observed_at_ms: NOW - 100,
      stop: {
        client_algo_id: ids.stopClientAlgoId,
        algo_id: "stop-venue-id",
        symbol: "BTCUSDT",
        side,
        order_type: "STOP_MARKET",
        status: "NEW",
        quantity,
        trigger_price: stopPrice,
        reduce_only: true,
      },
      target: {
        client_algo_id: ids.targetClientAlgoId,
        algo_id: "target-venue-id",
        symbol: "BTCUSDT",
        side,
        order_type: "TAKE_PROFIT_MARKET",
        status: "NEW",
        quantity,
        trigger_price: targetPrice,
        reduce_only: true,
      },
    },
    freshness: {
      private_reconciliation_max_age_ms: 60_000,
      protection_max_age_ms: 5_000,
      future_tolerance_ms: 5_000,
    },
    blockers: [],
  };
}

function readyEvidence(direction: "LONG" | "SHORT"): BinanceUsdmShadowEvidence {
  const short = direction === "SHORT";
  return {
    schema_version: "glitch.crypto.binance-usdm-shadow-evidence.v1",
    venue: "binance-usdm",
    symbol: "BTCUSDT",
    base_url_origin: "https://demo-fapi.binance.com",
    mutation_authority: false,
    credential_mode: "read_only_authenticated",
    observed_utc: new Date(NOW - 100).toISOString(),
    public: {
      server_time: NOW - 200,
      exchange_information: {},
      symbol_rules: {
        schema_version: "glitch.crypto.binance-usdm-symbol-rules.v1",
        venue: "binance-usdm",
        symbol: "BTCUSDT",
        status: "TRADING",
        contract_type: "PERPETUAL",
        base_asset: "BTC",
        quote_asset: "USDT",
        margin_asset: "USDT",
        price_precision: 1,
        quantity_precision: 3,
        tick_size: "0.10",
        minimum_price: "0.10",
        maximum_price: "1000000.00",
        quantity_step: "0.001",
        minimum_quantity: "0.001",
        maximum_quantity: "1000.000",
        market_quantity_step: "0.001",
        market_minimum_quantity: "0.001",
        market_maximum_quantity: "100.000",
        minimum_notional: "5.00000000",
        supported_order_types: ["LIMIT", "MARKET", "STOP_MARKET", "TAKE_PROFIT_MARKET"],
        supported_time_in_force: ["GTC", "IOC", "FOK", "GTX"],
      },
      book_ticker: {
        symbol: "BTCUSDT",
        bidPrice: "104.90",
        askPrice: "105.10",
      },
      depth: {},
      premium_index: {
        symbol: "BTCUSDT",
        markPrice: "105.00",
      },
    },
    private: {
      balances: [{
        asset: "USDT",
        balance: "1000.00",
        availableBalance: "995.00",
      }],
      positions: [{
        symbol: "BTCUSDT",
        positionAmt: short ? "-0.100" : "0.100",
        positionSide: "BOTH",
        entryPrice: short ? "110.00" : "100.00",
        breakEvenPrice: short ? "109.90" : "100.10",
        unRealizedProfit: "0.50",
      }],
      open_orders: [],
      commission_rate: {
        symbol: "BTCUSDT",
        makerCommissionRate: "0.0002",
        takerCommissionRate: "0.0005",
      },
      position_mode: { dualSidePosition: false },
      multi_asset_mode: { multiAssetsMargin: false },
      symbol_configuration: [{
        symbol: "BTCUSDT",
        marginType: "ISOLATED",
        leverage: 3,
        isAutoAddMargin: false,
      }],
      account_configuration: { canTrade: true },
    },
  };
}
