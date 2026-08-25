import test from "node:test";
import assert from "node:assert/strict";
import { bodyHash } from "../src/domain/canonical-json.js";
import type { BinanceUsdmProtectedEntryPlan } from "../src/venue/binance-usdm/entry-plan.js";
import type { BinanceUsdmProtectionManagementPlan } from "../src/venue/binance-usdm/management-plan.js";
import {
  deriveBinanceUsdmMutationIds,
  type BinanceUsdmOwnedProtectionCloseRequest,
  type BinanceUsdmProtectedEntryRequest,
  type BinanceUsdmProtectionRevisionRequest,
} from "../src/venue/binance-usdm/mutation-contract.js";
import type { BinanceUsdmOwnedProtectionBinding } from "../src/venue/binance-usdm/owned-protection-state.js";
import type { BinanceUsdmProtectedEntryResult } from "../src/venue/binance-usdm/protection-coordinator.js";
import type {
  BinanceUsdmOwnedProtectionCloseResult,
  BinanceUsdmProtectionRevisionResult,
} from "../src/venue/binance-usdm/protection-revision.js";
import { BinanceUsdmTestnetPermitIssuer } from "../src/venue/binance-usdm/testnet-authority.js";
import { BinanceUsdmTestnetExecutionEffectsAdapter } from "../src/venue/binance-usdm/testnet-effects.js";

const NOW = Date.parse("2026-08-25T05:20:00.000Z");
const OPERATOR_TOKEN = "operator-token-1234567890";
const MODEL_TOKEN = "model-token-1234567890123";
const POSITION_INTENT = "123e4567-e89b-42d3-a456-426614174000";
const REVISION_INTENT = "223e4567-e89b-42d3-a456-426614174000";
const CLOSE_INTENT = "323e4567-e89b-42d3-a456-426614174000";
const PERMIT_IDS = [
  "423e4567-e89b-42d3-a456-426614174000",
  "523e4567-e89b-42d3-a456-426614174000",
  "623e4567-e89b-42d3-a456-426614174000",
];

test("operator authority derives every permit field from the exact fresh proof", () => {
  let index = 0;
  const issuer = new BinanceUsdmTestnetPermitIssuer({
    operatorToken: OPERATOR_TOKEN,
    now: () => NOW,
    permitIdFactory: () => PERMIT_IDS[index++]!,
  });
  const entry = entryPlan();
  const management = managementPlan();
  const owned = binding();

  const entryPermit = issuer.issueProtectedEntry(`Bearer ${OPERATOR_TOKEN}`, entry);
  const revisionPermit = issuer.issueProtectionRevision(`Bearer ${OPERATOR_TOKEN}`, management);
  const closePermit = issuer.issueOwnedPositionClose(`Bearer ${OPERATOR_TOKEN}`, owned, CLOSE_INTENT);

  assert.deepEqual(
    [entryPermit.action, revisionPermit.action, closePermit.action],
    ["protected_entry", "protection_revision", "owned_position_close"],
  );
  assert.equal(entryPermit.intent_id, POSITION_INTENT);
  assert.equal(revisionPermit.intent_id, REVISION_INTENT);
  assert.equal(closePermit.intent_id, CLOSE_INTENT);
  assert.equal(entryPermit.maximum_quantity, "0.1");
  assert.equal(revisionPermit.maximum_quantity, "0.1");
  assert.equal(closePermit.maximum_quantity, "0.1");
  assert.equal(entryPermit.proof_body_hash, bodyHash(entry));
  assert.equal(revisionPermit.proof_body_hash, bodyHash(management));
  assert.equal(closePermit.proof_body_hash, bodyHash(owned));
  assert.equal(Date.parse(entryPermit.expires_utc) - Date.parse(entryPermit.issued_utc), 30_000);
  assert.equal(Object.isFrozen(entryPermit), true);
  const serialized = JSON.stringify([entryPermit, revisionPermit, closePermit]);
  assert.equal(serialized.includes(OPERATOR_TOKEN), false);
  assert.equal(serialized.includes(MODEL_TOKEN), false);
});

test("model, missing, stale, blocked, wrong-symbol, and malformed identity fail before issuance", () => {
  const issuer = permitIssuer();
  for (const authorization of [`Bearer ${MODEL_TOKEN}`, "", "Bearer wrong-operator-token-value"]) {
    assert.throws(
      () => issuer.issueProtectedEntry(authorization, entryPlan()),
      /operator authorization required/,
    );
  }

  const stale = entryPlan();
  stale.observed_utc = new Date(NOW - 1_001).toISOString();
  assert.throws(
    () => issuer.issueProtectedEntry(`Bearer ${OPERATOR_TOKEN}`, stale),
    /stale or future-dated/,
  );

  const blocked = entryPlan();
  blocked.status = "blocked";
  blocked.blockers = ["proof_blocked"];
  blocked.request = null;
  assert.throws(
    () => issuer.issueProtectedEntry(`Bearer ${OPERATOR_TOKEN}`, blocked),
    /ready protected-entry proof/,
  );

  const wrongSymbol = managementPlan();
  if (wrongSymbol.request) {
    wrongSymbol.request = {
      ...wrongSymbol.request,
      current: { ...wrongSymbol.request.current, symbol: "ETHUSDT" },
    };
  }
  assert.throws(
    () => issuer.issueProtectionRevision(`Bearer ${OPERATOR_TOKEN}`, wrongSymbol),
    /ready protection-management proof/,
  );

  assert.throws(
    () => issuer.issueOwnedPositionClose(`Bearer ${OPERATOR_TOKEN}`, binding(), "not-a-uuid"),
    /intent ID/,
  );
});

test("permit lifetime and generated identity are bounded before an artifact exists", () => {
  assert.throws(
    () => new BinanceUsdmTestnetPermitIssuer({
      operatorToken: OPERATOR_TOKEN,
      lifetimeMs: 300_001,
    }),
    /permit lifetime/,
  );
  const issuer = new BinanceUsdmTestnetPermitIssuer({
    operatorToken: OPERATOR_TOKEN,
    now: () => NOW,
    permitIdFactory: () => "not-a-uuid",
  });
  assert.throws(
    () => issuer.issueProtectedEntry(`Bearer ${OPERATOR_TOKEN}`, entryPlan()),
    /permit identity is invalid/,
  );
});

test("effect adapter delegates each mutation and GET-only recovery call exactly once", async () => {
  const calls: string[] = [];
  const entryRequest = entryPlan().request!;
  const revisionRequest = managementPlan().request!;
  const closeRequest: BinanceUsdmOwnedProtectionCloseRequest = {
    closeIntentId: CLOSE_INTENT,
    current: binding().current!,
  };
  const entryResult = { kind: "entry" } as unknown as BinanceUsdmProtectedEntryResult;
  const entryRecovery = { kind: "entry_recovery" } as unknown as BinanceUsdmProtectedEntryResult;
  const revisionResult = { kind: "revision" } as unknown as BinanceUsdmProtectionRevisionResult;
  const revisionRecovery = { kind: "revision_recovery" } as unknown as BinanceUsdmProtectionRevisionResult;
  const closeResult = { kind: "close" } as unknown as BinanceUsdmOwnedProtectionCloseResult;
  const closeRecovery = { kind: "close_recovery" } as unknown as BinanceUsdmOwnedProtectionCloseResult;
  const adapter = new BinanceUsdmTestnetExecutionEffectsAdapter(
    {
      createProtectedEntry: async (request: BinanceUsdmProtectedEntryRequest) => {
        calls.push("create_entry");
        assert.equal(request, entryRequest);
        return entryResult;
      },
      reconcileProtectedEntry: async (request: BinanceUsdmProtectedEntryRequest) => {
        calls.push("reconcile_entry");
        assert.equal(request, entryRequest);
        return entryRecovery;
      },
    },
    {
      revise: async (request: BinanceUsdmProtectionRevisionRequest) => {
        calls.push("revise");
        assert.equal(request, revisionRequest);
        return revisionResult;
      },
      reconcile: async (request: BinanceUsdmProtectionRevisionRequest) => {
        calls.push("reconcile_revision");
        assert.equal(request, revisionRequest);
        return revisionRecovery;
      },
      closeOwnedProtection: async (request: BinanceUsdmOwnedProtectionCloseRequest) => {
        calls.push("close");
        assert.equal(request, closeRequest);
        return closeResult;
      },
      reconcileOwnedProtectionClose: async (request: BinanceUsdmOwnedProtectionCloseRequest) => {
        calls.push("reconcile_close");
        assert.equal(request, closeRequest);
        return closeRecovery;
      },
    },
  );

  assert.equal(await adapter.createProtectedEntry(entryRequest), entryResult);
  assert.equal(await adapter.reconcileProtectedEntry(entryRequest), entryRecovery);
  assert.equal(await adapter.reviseProtection(revisionRequest), revisionResult);
  assert.equal(await adapter.reconcileProtectionRevision(revisionRequest), revisionRecovery);
  assert.equal(await adapter.closeOwnedProtection(closeRequest), closeResult);
  assert.equal(await adapter.reconcileOwnedProtectionClose(closeRequest), closeRecovery);
  assert.deepEqual(calls, [
    "create_entry",
    "reconcile_entry",
    "revise",
    "reconcile_revision",
    "close",
    "reconcile_close",
  ]);
});

function permitIssuer(): BinanceUsdmTestnetPermitIssuer {
  return new BinanceUsdmTestnetPermitIssuer({
    operatorToken: OPERATOR_TOKEN,
    now: () => NOW,
    permitIdFactory: () => PERMIT_IDS[0]!,
  });
}

function entryPlan(): Mutable<BinanceUsdmProtectedEntryPlan> {
  return {
    schema_version: "glitch.crypto.binance-usdm-protected-entry-plan.v1",
    venue: "binance-usdm",
    environment: "testnet",
    status: "ready",
    mutation_authority: false,
    engine_binding_authority: false,
    observed_utc: new Date(NOW - 100).toISOString(),
    context_observed_utc: new Date(NOW - 200).toISOString(),
    request: {
      intentId: POSITION_INTENT,
      symbol: "BTCUSDT",
      direction: "LONG",
      quantity: "0.1",
      stopPrice: "99",
      targetPrice: "105",
    },
    risk: {
      equity_cents: 100_000,
      available_balance_cents: 100_000,
      usable_pot_cents: 100_000,
      daily_start_pot_cents: 100_000,
      daily_target_profit_cents: 500,
      daily_loss_boundary_cents: 98_000,
      active_floor_cents: null,
      risk_budget_cents: 500,
      planned_loss_cents: 100,
      projected_protected_equity_cents: 99_900,
      notional_cents: 1_000,
      margin_required_cents: 334,
      stop_distance_bps: 100,
      total_loss_distance_bps: 115,
      venue_round_trip_cost_bps: 10,
      applied_round_trip_cost_bps: 10,
      leverage: 3,
    },
    precision: {
      tick_size: "0.1",
      venue_quantity_step: "0.001",
      effective_quantity_step: "0.001",
      venue_minimum_quantity: "0.001",
      effective_minimum_notional_cents: 500,
    },
    blockers: [],
  };
}

function managementPlan(): Mutable<BinanceUsdmProtectionManagementPlan> {
  const owned = binding();
  return {
    schema_version: "glitch.crypto.binance-usdm-protection-management-plan.v1",
    venue: "binance-usdm",
    environment: "testnet",
    status: "ready",
    mutation_authority: false,
    engine_binding_authority: false,
    observed_utc: new Date(NOW - 100).toISOString(),
    binding_observed_utc: owned.observed_utc,
    evidence_observed_utc: new Date(NOW - 100).toISOString(),
    binding_state_body_hash: owned.state_body_hash,
    binding_transition_sequence: owned.transition_sequence,
    request: {
      revisionIntentId: REVISION_INTENT,
      current: owned.current!,
      reductionQuantity: "0.05",
      nextStopPrice: "101",
      nextTargetPrice: "106",
    },
    account: {
      wallet_balance_cents: 100_000,
      unrealized_pnl_cents: 50,
      equity_cents: 100_050,
      projected_equity_cents: 100_048,
      leverage: 3,
    },
    market: {
      mark_price: "105",
      best_bid: "104.9",
      best_ask: "105.1",
      reduction_executable_price: "104.9",
    },
    risk: {
      usable_pot_cents: 100_048,
      daily_start_pot_cents: 99_500,
      daily_target_profit_cents: 497,
      daily_loss_boundary_cents: 94_525,
      active_floor_cents: 99_997,
      current_protected_equity_cents: 100_008,
      projected_protected_equity_cents: 100_037,
      current_open_risk_cents: 42,
      projected_open_risk_cents: 11,
      maximum_open_risk_cents: 2_000,
      reduction_realized_pnl_cents: 24,
      reduction_cost_cents: 1,
      venue_round_trip_cost_bps: 10,
      applied_exit_cost_bps: 15,
    },
    precision: {
      tick_size: "0.1",
      venue_quantity_step: "0.001",
      effective_quantity_step: "0.001",
      venue_minimum_quantity: "0.001",
      venue_minimum_notional_cents: 500,
      effective_minimum_notional_cents: 500,
      requested_reduction_bps: 5_000,
      derived_reduction_quantity: "0.05",
      remaining_quantity: "0.05",
    },
    blockers: [],
  };
}

function binding(): Mutable<BinanceUsdmOwnedProtectionBinding> {
  const ids = deriveBinanceUsdmMutationIds(POSITION_INTENT);
  const current = {
    positionIntentId: POSITION_INTENT,
    symbol: "BTCUSDT",
    direction: "LONG" as const,
    quantity: "0.1",
    stopPrice: "100",
    targetPrice: "110",
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
      direction: "LONG",
      quantity: "0.1",
      entry_price: "100",
      break_even_price: "100.1",
      unrealized_pnl: "0.5",
    },
    protection: {
      observed_at_ms: NOW - 100,
      stop: {
        client_algo_id: ids.stopClientAlgoId,
        algo_id: "stop-venue",
        symbol: "BTCUSDT",
        side: "SELL",
        order_type: "STOP_MARKET",
        status: "NEW",
        quantity: "0.1",
        trigger_price: "100",
        reduce_only: true,
      },
      target: {
        client_algo_id: ids.targetClientAlgoId,
        algo_id: "target-venue",
        symbol: "BTCUSDT",
        side: "SELL",
        order_type: "TAKE_PROFIT_MARKET",
        status: "NEW",
        quantity: "0.1",
        trigger_price: "110",
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

type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly string[]
    ? string[]
    : T[K];
};
