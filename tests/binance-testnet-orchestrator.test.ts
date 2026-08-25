import test from "node:test";
import assert from "node:assert/strict";
import { bodyHash } from "../src/domain/canonical-json.js";
import { GlitchDatabase } from "../src/storage/database.js";
import type { BinanceUsdmProtectedEntryPlan } from "../src/venue/binance-usdm/entry-plan.js";
import {
  deriveBinanceUsdmMutationIds,
  deriveBinanceUsdmProtectionRevisionIds,
  validateBinanceUsdmOwnedProtectionClose,
  type BinanceUsdmOwnedProtection,
  type BinanceUsdmProtectedEntryRequest,
  type BinanceUsdmProtectionRevisionRequest,
} from "../src/venue/binance-usdm/mutation-contract.js";
import {
  applyBinanceUsdmProtectedEntryResult,
  BinanceUsdmOwnedProtectionRepository,
  initialBinanceUsdmOwnedProtectionState,
  stageBinanceUsdmProtectionRevision,
  type BinanceUsdmOwnedProtectionBinding,
  type BinanceUsdmOwnedProtectionSnapshot,
} from "../src/venue/binance-usdm/owned-protection-state.js";
import type { BinanceUsdmProtectedEntryResult } from "../src/venue/binance-usdm/protection-coordinator.js";
import type {
  BinanceUsdmOwnedProtectionCloseResult,
  BinanceUsdmProtectionRevisionResult,
} from "../src/venue/binance-usdm/protection-revision.js";
import {
  BinanceUsdmTestnetExecutionOrchestrator,
  type BinanceUsdmTestnetExecutionEffects,
  type BinanceUsdmTestnetMutationPermit,
} from "../src/venue/binance-usdm/testnet-orchestrator.js";

const NOW = 1_700_000_000_000;
const POSITION_INTENT = "123e4567-e89b-42d3-a456-426614174000";
const CLOSE_INTENT = "223e4567-e89b-42d3-a456-426614174000";
const PERMIT_ID = "323e4567-e89b-42d3-a456-426614174000";
const REVISION_INTENT = "423e4567-e89b-42d3-a456-426614174000";
const ENTRY = entryRequest();
const IDS = deriveBinanceUsdmMutationIds(POSITION_INTENT);

test("protected entry is durably staged before the first effect", async () => {
  const database = new GlitchDatabase(":memory:");
  const repository = new BinanceUsdmOwnedProtectionRepository(database);
  let observedPending = false;
  const effects = fakeEffects({
    createProtectedEntry: async () => {
      const snapshot = repository.load();
      observedPending = snapshot.state.pending?.result_state === "intent_persisted";
      return entryResult();
    },
  });
  const orchestrator = createOrchestrator(repository, effects);
  const outcome = await orchestrator.executeProtectedEntry(
    readyPlan(),
    permit("protected_entry", POSITION_INTENT, "0.01", readyPlan()),
  );
  assert.equal(observedPending, true);
  assert.equal(outcome.result.state, "open_protected");
  assert.equal(outcome.ownership.state.current?.quantity, "0.01");
  assert.equal(outcome.ownership.state.pending, null);
  database.close();
});

test("effect failure leaves exact pending state for GET-only restart recovery", async () => {
  const database = new GlitchDatabase(":memory:");
  const repository = new BinanceUsdmOwnedProtectionRepository(database);
  let submissions = 0;
  const failing = createOrchestrator(repository, fakeEffects({
    createProtectedEntry: async () => {
      submissions += 1;
      throw new Error("simulated_disconnect");
    },
  }));
  await assert.rejects(
    () => failing.executeProtectedEntry(
      readyPlan(),
      permit("protected_entry", POSITION_INTENT, "0.01", readyPlan()),
    ),
    /simulated_disconnect/,
  );
  assert.equal(repository.load().state.pending?.kind, "protected_entry");

  let reconciliations = 0;
  const restarted = createOrchestrator(repository, fakeEffects({
    reconcileProtectedEntry: async (request) => {
      reconciliations += 1;
      assert.deepEqual(request, ENTRY);
      return entryResult();
    },
  }));
  const recovered = await restarted.recoverPending();
  assert.equal(submissions, 1);
  assert.equal(reconciliations, 1);
  assert.equal(recovered.kind, "protected_entry");
  assert.equal(recovered.ownership.state.current?.positionIntentId, POSITION_INTENT);
  assert.equal(recovered.ownership.state.pending, null);
  database.close();
});

test("ready owned binding closes only after durable staging", async () => {
  const database = new GlitchDatabase(":memory:");
  const repository = new BinanceUsdmOwnedProtectionRepository(database);
  const opened = repository.save(0, openState());
  let observedPending = false;
  const effects = fakeEffects({
    closeOwnedProtection: async (request) => {
      observedPending = repository.load().state.pending?.kind === "owned_position_close";
      return closeResult(request.current);
    },
  });
  const binding = readyBinding(opened);
  const outcome = await createOrchestrator(repository, effects).executeOwnedPositionClose(
    binding,
    CLOSE_INTENT,
    permit("owned_position_close", CLOSE_INTENT, "0.01", binding),
  );
  assert.equal(observedPending, true);
  assert.equal(outcome.result.state, "closed");
  assert.equal(outcome.ownership.state.current, null);
  assert.equal(outcome.ownership.state.pending, null);
  database.close();
});

test("failed close and pending revision recover through their exact query ports", async () => {
  const closeDatabase = new GlitchDatabase(":memory:");
  const closeRepository = new BinanceUsdmOwnedProtectionRepository(closeDatabase);
  const opened = closeRepository.save(0, openState());
  const binding = readyBinding(opened);
  await assert.rejects(
    () => createOrchestrator(closeRepository, fakeEffects({
      closeOwnedProtection: async () => { throw new Error("close_disconnect"); },
    })).executeOwnedPositionClose(
      binding,
      CLOSE_INTENT,
      permit("owned_position_close", CLOSE_INTENT, "0.01", binding),
    ),
    /close_disconnect/,
  );
  let closeQueries = 0;
  const closeRecovered = await createOrchestrator(closeRepository, fakeEffects({
    reconcileOwnedProtectionClose: async (request) => {
      closeQueries += 1;
      return closeResult(request.current);
    },
  })).recoverPending();
  assert.equal(closeQueries, 1);
  assert.equal(closeRecovered.kind, "owned_position_close");
  assert.equal(closeRecovered.ownership.state.current, null);
  closeDatabase.close();

  const revisionDatabase = new GlitchDatabase(":memory:");
  const revisionRepository = new BinanceUsdmOwnedProtectionRepository(revisionDatabase);
  const stagedRevision = stageBinanceUsdmProtectionRevision(
    openState(),
    revisionRequest(),
    new Date(NOW - 200).toISOString(),
  );
  revisionRepository.save(0, stagedRevision);
  let revisionQueries = 0;
  const revisionRecovered = await createOrchestrator(revisionRepository, fakeEffects({
    reconcileProtectionRevision: async (request) => {
      revisionQueries += 1;
      assert.deepEqual(request, revisionRequest());
      return revisionResult();
    },
  })).recoverPending();
  assert.equal(revisionQueries, 1);
  assert.equal(revisionRecovered.kind, "protection_revision");
  assert.equal(revisionRecovered.ownership.state.current?.stopPrice, "59900");
  revisionDatabase.close();
});

test("permit, proof freshness, quantity, and durable binding identity fail before effects", async () => {
  const database = new GlitchDatabase(":memory:");
  const repository = new BinanceUsdmOwnedProtectionRepository(database);
  let effectsCalled = 0;
  const effects = fakeEffects({
    createProtectedEntry: async () => {
      effectsCalled += 1;
      return entryResult();
    },
  });
  const orchestrator = createOrchestrator(repository, effects);

  const currentPlan = readyPlan();
  const stale: BinanceUsdmProtectedEntryPlan = {
    ...currentPlan,
    observed_utc: new Date(NOW - 1_001).toISOString(),
  };
  await assert.rejects(
    () => orchestrator.executeProtectedEntry(
      stale,
      permit("protected_entry", POSITION_INTENT, "0.01", stale),
    ),
    /stale or future-dated/,
  );
  await assert.rejects(
    () => orchestrator.executeProtectedEntry(
      readyPlan(),
      { ...permit("protected_entry", POSITION_INTENT, "0.01", readyPlan()), expires_utc: new Date(NOW).toISOString() },
    ),
    /permit is invalid/,
  );
  await assert.rejects(
    () => orchestrator.executeProtectedEntry(
      readyPlan(),
      permit("owned_position_close", POSITION_INTENT, "0.01", readyPlan()),
    ),
    /permit is invalid/,
  );
  await assert.rejects(
    () => orchestrator.executeProtectedEntry(
      readyPlan(),
      permit("protected_entry", POSITION_INTENT, "0.009", readyPlan()),
    ),
    /permit is invalid/,
  );
  await assert.rejects(
    () => orchestrator.executeProtectedEntry(
      readyPlan(),
      {
        ...permit("protected_entry", POSITION_INTENT, "0.01", readyPlan()),
        proof_body_hash: "0".repeat(64),
      },
    ),
    /permit is invalid/,
  );
  assert.equal(effectsCalled, 0);
  assert.equal(repository.load().storage_version, 0);

  const opened = repository.save(0, openState());
  const staleBinding = readyBinding(opened);
  const changed = { ...opened.state, transition_sequence: opened.state.transition_sequence + 1 };
  repository.save(opened.storage_version, changed);
  const closeEffects = fakeEffects({
    closeOwnedProtection: async (request) => {
      effectsCalled += 1;
      return closeResult(request.current);
    },
  });
  await assert.rejects(
    () => createOrchestrator(repository, closeEffects).executeOwnedPositionClose(
      staleBinding,
      CLOSE_INTENT,
      permit("owned_position_close", CLOSE_INTENT, "0.01", staleBinding),
    ),
    /stale relative to durable state/,
  );
  assert.equal(effectsCalled, 0);
  database.close();
});

test("overlapping operations are rejected by the in-process single-writer guard", async () => {
  const database = new GlitchDatabase(":memory:");
  const repository = new BinanceUsdmOwnedProtectionRepository(database);
  let release!: () => void;
  let started!: () => void;
  const didStart = new Promise<void>((resolvePromise) => { started = resolvePromise; });
  const waitForRelease = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  const effects = fakeEffects({
    createProtectedEntry: async () => {
      started();
      await waitForRelease;
      return entryResult();
    },
  });
  const orchestrator = createOrchestrator(repository, effects);
  const first = orchestrator.executeProtectedEntry(
    readyPlan(),
    permit("protected_entry", POSITION_INTENT, "0.01", readyPlan()),
  );
  await didStart;
  await assert.rejects(
    () => orchestrator.recoverPending(),
    /already in progress/,
  );
  release();
  await first;
  database.close();
});

test("recovery with no pending request performs no effect", async () => {
  const database = new GlitchDatabase(":memory:");
  const repository = new BinanceUsdmOwnedProtectionRepository(database);
  const recovered = await createOrchestrator(
    repository,
    fakeEffects({}),
  ).recoverPending();
  assert.equal(recovered.kind, "none");
  assert.equal(recovered.result, null);
  assert.equal(recovered.ownership.storage_version, 0);
  database.close();
});

function createOrchestrator(
  repository: BinanceUsdmOwnedProtectionRepository,
  effects: BinanceUsdmTestnetExecutionEffects,
) {
  return new BinanceUsdmTestnetExecutionOrchestrator(repository, effects, {
    now: () => NOW,
    proofMaxAgeMs: 1_000,
  });
}

function fakeEffects(
  patch: Partial<BinanceUsdmTestnetExecutionEffects>,
): BinanceUsdmTestnetExecutionEffects {
  const unexpected = async (): Promise<never> => {
    throw new Error("unexpected_effect");
  };
  return {
    createProtectedEntry: patch.createProtectedEntry ?? unexpected,
    reconcileProtectedEntry: patch.reconcileProtectedEntry ?? unexpected,
    closeOwnedProtection: patch.closeOwnedProtection ?? unexpected,
    reconcileOwnedProtectionClose: patch.reconcileOwnedProtectionClose ?? unexpected,
    reconcileProtectionRevision: patch.reconcileProtectionRevision ?? unexpected,
  };
}

function readyPlan(): BinanceUsdmProtectedEntryPlan {
  return {
    schema_version: "glitch.crypto.binance-usdm-protected-entry-plan.v1",
    venue: "binance-usdm",
    environment: "testnet",
    status: "ready",
    mutation_authority: false,
    engine_binding_authority: false,
    observed_utc: new Date(NOW - 100).toISOString(),
    context_observed_utc: new Date(NOW - 200).toISOString(),
    request: { ...ENTRY },
    risk: {
      equity_cents: 100_000,
      available_balance_cents: 100_000,
      usable_pot_cents: 100_000,
      daily_start_pot_cents: 100_000,
      daily_target_profit_cents: 500,
      daily_loss_boundary_cents: 98_000,
      active_floor_cents: null,
      risk_budget_cents: 500,
      planned_loss_cents: 300,
      projected_protected_equity_cents: 99_700,
      notional_cents: 60_000,
      margin_required_cents: 20_000,
      stop_distance_bps: 34,
      total_loss_distance_bps: 49,
      venue_round_trip_cost_bps: 10,
      applied_round_trip_cost_bps: 10,
      leverage: 3,
    },
    precision: {
      tick_size: "0.1",
      venue_quantity_step: "0.001",
      effective_quantity_step: "0.001",
      venue_minimum_quantity: "0.001",
      effective_minimum_notional_cents: 1_000,
    },
    blockers: [],
  };
}

function permit(
  action: BinanceUsdmTestnetMutationPermit["action"],
  intentId: string,
  maximumQuantity: string,
  proof: unknown,
): BinanceUsdmTestnetMutationPermit {
  return {
    schema_version: "glitch.crypto.binance-usdm-testnet-mutation-permit.v1",
    permit_id: PERMIT_ID,
    intent_id: intentId,
    environment: "testnet",
    symbol: "BTCUSDT",
    action,
    proof_body_hash: bodyHash(proof),
    maximum_quantity: maximumQuantity,
    issued_utc: new Date(NOW - 100).toISOString(),
    expires_utc: new Date(NOW + 60_000).toISOString(),
  };
}

function entryRequest(): BinanceUsdmProtectedEntryRequest {
  return {
    intentId: POSITION_INTENT,
    symbol: "BTCUSDT",
    direction: "LONG",
    quantity: "0.01",
    stopPrice: "59800",
    targetPrice: "60300",
  };
}

function entryResult(): BinanceUsdmProtectedEntryResult {
  return {
    schema_version: "glitch.crypto.binance-usdm-protected-entry-result.v1",
    intent_id: POSITION_INTENT,
    state: "open_protected",
    reason: "native_stop_and_target_proven",
    ids: IDS,
    entry: {
      client_order_id: IDS.entryClientOrderId,
      order_id: "1",
      symbol: "BTCUSDT",
      side: "BUY",
      status: "FILLED",
      executed_quantity: "0.01",
      average_price: "60000.2",
      reduce_only: false,
    },
    stop: algo(IDS.stopClientAlgoId, "STOP_MARKET", "59800"),
    target: algo(IDS.targetClientAlgoId, "TAKE_PROFIT_MARKET", "60300"),
    emergency_close: null,
  };
}

function openState() {
  return applyBinanceUsdmProtectedEntryResult(
    initialBinanceUsdmOwnedProtectionState(),
    ENTRY,
    entryResult(),
    new Date(NOW - 200).toISOString(),
  );
}

function readyBinding(
  snapshot: BinanceUsdmOwnedProtectionSnapshot,
): BinanceUsdmOwnedProtectionBinding {
  const current = snapshot.state.current!;
  return {
    schema_version: "glitch.crypto.binance-usdm-owned-protection-binding.v1",
    venue: "binance-usdm",
    environment: "testnet",
    status: "ready",
    mutation_authority: false,
    engine_binding_authority: false,
    management_preconditions_satisfied: true,
    observed_utc: new Date(NOW - 100).toISOString(),
    state_body_hash: bodyHash(snapshot.state),
    transition_sequence: snapshot.state.transition_sequence,
    current,
    pending: null,
    native_position: {
      symbol: current.symbol,
      direction: current.direction,
      quantity: current.quantity,
      entry_price: "60000.2",
      break_even_price: "60006.2",
      unrealized_pnl: "0",
    },
    protection: {
      observed_at_ms: NOW - 100,
      stop: algo(current.stopClientAlgoId, "STOP_MARKET", current.stopPrice),
      target: algo(current.targetClientAlgoId, "TAKE_PROFIT_MARKET", current.targetPrice),
    },
    freshness: {
      private_reconciliation_max_age_ms: 60_000,
      protection_max_age_ms: 5_000,
      future_tolerance_ms: 5_000,
    },
    blockers: [],
  };
}

function closeResult(current: BinanceUsdmOwnedProtection): BinanceUsdmOwnedProtectionCloseResult {
  const request = { closeIntentId: CLOSE_INTENT, current };
  const closeId = validateBinanceUsdmOwnedProtectionClose(request).closeClientOrderId;
  return {
    schema_version: "glitch.crypto.binance-usdm-owned-protection-close-result.v1",
    close_intent_id: CLOSE_INTENT,
    position_intent_id: current.positionIntentId,
    state: "closed",
    reason: "reduce_only_close_and_current_cleanup_proven",
    current,
    close_client_order_id: closeId,
    current_stop: null,
    current_target: null,
    close: {
      client_order_id: closeId,
      order_id: "2",
      symbol: current.symbol,
      side: "SELL",
      status: "FILLED",
      executed_quantity: current.quantity,
      average_price: "60010",
      reduce_only: true,
    },
    current_target_cleanup: {
      client_algo_id: current.targetClientAlgoId,
      disposition: "canceled",
      venue_status: "CANCELED",
    },
    current_stop_cleanup: {
      client_algo_id: current.stopClientAlgoId,
      disposition: "canceled",
      venue_status: "CANCELED",
    },
  };
}

function revisionRequest(): BinanceUsdmProtectionRevisionRequest {
  return {
    revisionIntentId: REVISION_INTENT,
    current: openState().current!,
    reductionQuantity: null,
    nextStopPrice: "59900",
    nextTargetPrice: "60400",
  };
}

function revisionResult(): BinanceUsdmProtectionRevisionResult {
  const request = revisionRequest();
  const ids = deriveBinanceUsdmProtectionRevisionIds(REVISION_INTENT);
  return {
    schema_version: "glitch.crypto.binance-usdm-protection-revision-result.v1",
    revision_intent_id: REVISION_INTENT,
    position_intent_id: POSITION_INTENT,
    state: "revision_protected",
    reason: "restart_replacement_pair_and_current_cleanup_proven",
    current: request.current,
    next: {
      quantity: request.current.quantity,
      stop_price: request.nextStopPrice,
      target_price: request.nextTargetPrice,
      ids,
    },
    current_stop: null,
    current_target: null,
    reduction: null,
    replacement_stop: algo(ids.stopClientAlgoId, "STOP_MARKET", request.nextStopPrice),
    replacement_target: algo(ids.targetClientAlgoId, "TAKE_PROFIT_MARKET", request.nextTargetPrice),
    current_target_cleanup: {
      client_algo_id: request.current.targetClientAlgoId,
      disposition: "canceled",
      venue_status: "CANCELED",
    },
    current_stop_cleanup: {
      client_algo_id: request.current.stopClientAlgoId,
      disposition: "canceled",
      venue_status: "CANCELED",
    },
  };
}

function algo(
  clientAlgoId: string,
  type: "STOP_MARKET" | "TAKE_PROFIT_MARKET",
  triggerPrice: string,
) {
  return {
    client_algo_id: clientAlgoId,
    algo_id: clientAlgoId + "-venue",
    symbol: "BTCUSDT",
    side: "SELL",
    order_type: type,
    status: "NEW",
    quantity: "0.01",
    trigger_price: triggerPrice,
    reduce_only: true as const,
  };
}
