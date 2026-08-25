import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { GlitchDatabase } from "../src/storage/database.js";
import {
  deriveBinanceUsdmMutationIds,
  deriveBinanceUsdmProtectionRevisionIds,
  validateBinanceUsdmOwnedProtectionClose,
  type BinanceUsdmOwnedProtection,
  type BinanceUsdmOwnedProtectionCloseRequest,
  type BinanceUsdmProtectedEntryRequest,
  type BinanceUsdmProtectionRevisionRequest,
} from "../src/venue/binance-usdm/mutation-contract.js";
import {
  applyBinanceUsdmOwnedProtectionCloseResult,
  applyBinanceUsdmProtectedEntryResult,
  applyBinanceUsdmProtectionRevisionResult,
  BinanceUsdmOwnedProtectionRepository,
  compileBinanceUsdmOwnedProtectionBinding,
  initialBinanceUsdmOwnedProtectionState,
  stageBinanceUsdmOwnedProtectionClose,
  stageBinanceUsdmProtectedEntry,
  stageBinanceUsdmProtectionRevision,
} from "../src/venue/binance-usdm/owned-protection-state.js";
import type {
  BinanceUsdmAlgoOrderEvidence,
  BinanceUsdmProtectedEntryResult,
} from "../src/venue/binance-usdm/protection-coordinator.js";
import type {
  BinanceUsdmOwnedProtectionCloseResult,
  BinanceUsdmProtectionRevisionResult,
} from "../src/venue/binance-usdm/protection-revision.js";
import type { BinanceUsdmStreamSupervisorStatus } from "../src/venue/binance-usdm/stream-supervisor.js";

const NOW = 1_700_000_000_000;
const RECORDED = "2023-11-14T22:13:20.000Z";
const positionIntentId = "123e4567-e89b-42d3-a456-426614174000";
const revisionIntentId = "223e4567-e89b-42d3-a456-426614174000";
const closeIntentId = "323e4567-e89b-42d3-a456-426614174000";
const entryIds = deriveBinanceUsdmMutationIds(positionIntentId);
const revisionIds = deriveBinanceUsdmProtectionRevisionIds(revisionIntentId);

test("entry, revision, and close requests can be staged durably before transport", () => {
  const stagedEntry = stageBinanceUsdmProtectedEntry(
    initialBinanceUsdmOwnedProtectionState(),
    entryRequest(),
    RECORDED,
  );
  assert.equal(stagedEntry.pending?.result_state, "intent_persisted");
  assert.deepEqual(
    stageBinanceUsdmProtectedEntry(stagedEntry, entryRequest(), RECORDED),
    stagedEntry,
  );
  assert.throws(
    () => stageBinanceUsdmProtectedEntry(
      stagedEntry,
      { ...entryRequest(), intentId: "423e4567-e89b-42d3-a456-426614174000" },
      RECORDED,
    ),
    /conflicts with pending reconciliation/,
  );

  const opened = applyBinanceUsdmProtectedEntryResult(
    stagedEntry,
    entryRequest(),
    entryResult(),
    RECORDED,
  );
  const stagedRevision = stageBinanceUsdmProtectionRevision(
    opened,
    revisionRequest(),
    RECORDED,
  );
  assert.equal(stagedRevision.pending?.kind, "protection_revision");
  const revised = applyBinanceUsdmProtectionRevisionResult(
    stagedRevision,
    revisionRequest(),
    revisionResult("revision_protected"),
    RECORDED,
  );
  const stagedClose = stageBinanceUsdmOwnedProtectionClose(
    revised,
    closeRequest(),
    RECORDED,
  );
  assert.equal(stagedClose.pending?.kind, "owned_position_close");
  assert.deepEqual(stagedClose.pending?.request, closeRequest());
});

test("durable ownership advances only through proof-complete entry, revision, and close", () => {
  const opened = openState();
  assert.equal(opened.current?.quantity, "0.01");
  assert.equal(opened.pending, null);

  const cleanupPending = applyBinanceUsdmProtectionRevisionResult(
    opened,
    revisionRequest(),
    revisionResult("revision_protected_cleanup_pending"),
    RECORDED,
  );
  assert.equal(cleanupPending.current?.quantity, "0.006");
  assert.equal(cleanupPending.current?.stopClientAlgoId, revisionIds.stopClientAlgoId);
  assert.equal(cleanupPending.pending?.kind, "protection_revision");

  const revised = applyBinanceUsdmProtectionRevisionResult(
    cleanupPending,
    revisionRequest(),
    revisionResult("revision_protected"),
    RECORDED,
  );
  assert.equal(revised.pending, null);
  assert.equal(revised.current?.targetPrice, "61500");

  const closePending = applyBinanceUsdmOwnedProtectionCloseResult(
    revised,
    closeRequest(),
    closeResult("close_visibility_pending"),
    RECORDED,
  );
  assert.equal(closePending.current?.quantity, "0.006");
  assert.equal(closePending.pending?.kind, "owned_position_close");
  assert.throws(
    () => applyBinanceUsdmOwnedProtectionCloseResult(
      closePending,
      { ...closeRequest(), closeIntentId: "423e4567-e89b-42d3-a456-426614174000" },
      closeResult("close_visibility_pending"),
      RECORDED,
    ),
    /conflicts with pending reconciliation/,
  );

  const closed = applyBinanceUsdmOwnedProtectionCloseResult(
    closePending,
    closeRequest(),
    closeResult("closed"),
    RECORDED,
  );
  assert.equal(closed.current, null);
  assert.equal(closed.pending, null);
  assert.equal(closed.transition_sequence, 5);
});

test("ambiguous transition retains the complete canonical restart request", () => {
  const opened = openState();
  const pending = applyBinanceUsdmProtectionRevisionResult(
    opened,
    revisionRequest(),
    revisionResult("reduction_visibility_pending"),
    RECORDED,
  );
  assert.deepEqual(pending.pending?.request, revisionRequest());
  assert.equal(pending.current?.quantity, "0.01");
  assert.throws(
    () => applyBinanceUsdmProtectionRevisionResult(
      pending,
      revisionRequest(),
      revisionResult("reduction_rejected"),
      RECORDED,
    ),
    /cannot later be treated as rejected/,
  );

  const reconciled = applyBinanceUsdmProtectionRevisionResult(
    pending,
    revisionRequest(),
    revisionResult("revision_protected"),
    RECORDED,
  );
  assert.equal(reconciled.current?.quantity, "0.006");
  assert.equal(reconciled.pending, null);
});

test("fabricated terminal evidence cannot create, replace, or clear ownership", () => {
  const badEntry = entryResult();
  badEntry.target = { ...badEntry.target!, client_algo_id: "wrong-target" };
  assert.throws(
    () => applyBinanceUsdmProtectedEntryResult(
      initialBinanceUsdmOwnedProtectionState(),
      entryRequest(),
      badEntry,
      RECORDED,
    ),
    /target proof is incomplete/,
  );

  const falseEmergency = entryResult();
  falseEmergency.state = "emergency_flatten_confirmed";
  falseEmergency.reason = "fixture_false_emergency";
  falseEmergency.entry = null;
  falseEmergency.stop = null;
  falseEmergency.target = null;
  falseEmergency.emergency_close = null;
  assert.throws(
    () => applyBinanceUsdmProtectedEntryResult(
      initialBinanceUsdmOwnedProtectionState(),
      entryRequest(),
      falseEmergency,
      RECORDED,
    ),
    /entry proof is incomplete/,
  );

  const opened = openState();
  const badRevision = revisionResult("revision_protected");
  badRevision.replacement_stop = null;
  assert.throws(
    () => applyBinanceUsdmProtectionRevisionResult(
      opened,
      revisionRequest(),
      badRevision,
      RECORDED,
    ),
    /stop proof is incomplete/,
  );

  const revised = applyBinanceUsdmProtectionRevisionResult(
    opened,
    revisionRequest(),
    revisionResult("revision_protected"),
    RECORDED,
  );
  const badClose = closeResult("closed");
  badClose.current_stop_cleanup = null;
  assert.throws(
    () => applyBinanceUsdmOwnedProtectionCloseResult(
      revised,
      closeRequest(),
      badClose,
      RECORDED,
    ),
    /cleanup proof is incomplete/,
  );
});

test("owned-protection state survives restart and rejects stale writers and corruption", () => {
  const path = join(tmpdir(), `glitch-crypto-owned-${randomUUID()}.sqlite`);
  try {
    let database = new GlitchDatabase(path);
    let repository = new BinanceUsdmOwnedProtectionRepository(database);
    const initial = repository.load();
    assert.equal(initial.storage_version, 0);
    const saved = repository.save(initial.storage_version, openState());
    assert.equal(saved.storage_version, 1);
    assert.equal(saved.state.current?.stopClientAlgoId, entryIds.stopClientAlgoId);
    assert.throws(
      () => repository.save(initial.storage_version, saved.state),
      /version conflict/,
    );
    database.close();

    database = new GlitchDatabase(path);
    repository = new BinanceUsdmOwnedProtectionRepository(database);
    const restarted = repository.load();
    assert.equal(restarted.storage_version, 1);
    assert.deepEqual(restarted.state, saved.state);
    assert.equal(Object.isFrozen(restarted.state.current), true);
    database.close();

    const tamper = new DatabaseSync(path);
    tamper.prepare(
      "UPDATE runtime_state SET state_json = ? WHERE state_key = ?",
    ).run("null", "binance-usdm.owned-protection");
    tamper.close();

    database = new GlitchDatabase(path);
    repository = new BinanceUsdmOwnedProtectionRepository(database);
    assert.throws(() => repository.load(), /integrity mismatch/);
    database.close();
  } finally {
    rmSync(path, { force: true });
    rmSync(path + "-wal", { force: true });
    rmSync(path + "-shm", { force: true });
  }
});

test("fresh exact native position and protection compile a non-authorizing ready binding", () => {
  const state = openState();
  const binding = compileBinanceUsdmOwnedProtectionBinding({
    state,
    streams: streamsWithPosition("0.010"),
    protection: protectionFor(state.current!),
    observedAtMs: NOW,
  });
  assert.equal(binding.status, "ready");
  assert.equal(binding.management_preconditions_satisfied, true);
  assert.equal(binding.mutation_authority, false);
  assert.equal(binding.engine_binding_authority, false);
  assert.equal(binding.native_position?.direction, "LONG");
  assert.equal(binding.native_position?.quantity, "0.01");
  assert.equal(Object.isFrozen(binding), true);
  assert.equal(Object.isFrozen(binding.current), true);
});

test("quantity, protection identity, pending reconciliation, and unowned exposure fail closed", () => {
  const state = openState();
  const quantityMismatch = compileBinanceUsdmOwnedProtectionBinding({
    state,
    streams: streamsWithPosition("0.009"),
    protection: protectionFor(state.current!),
    observedAtMs: NOW,
  });
  assert.ok(quantityMismatch.blockers.includes("owned_native_position_quantity_mismatch"));

  const wrongTarget = protectionFor(state.current!);
  wrongTarget.target = { ...wrongTarget.target!, client_algo_id: "wrong-target" };
  const protectionMismatch = compileBinanceUsdmOwnedProtectionBinding({
    state,
    streams: streamsWithPosition("0.010"),
    protection: wrongTarget,
    observedAtMs: NOW,
  });
  assert.ok(protectionMismatch.blockers.includes("exact_owned_target_not_proven"));

  const pending = applyBinanceUsdmOwnedProtectionCloseResult(
    state,
    originalCloseRequest(),
    originalCloseResult("close_visibility_pending"),
    RECORDED,
  );
  const pendingBinding = compileBinanceUsdmOwnedProtectionBinding({
    state: pending,
    streams: streamsWithPosition("0.010"),
    protection: protectionFor(state.current!),
    observedAtMs: NOW,
  });
  assert.ok(pendingBinding.blockers.includes("owned_protection_reconciliation_pending"));

  const unowned = compileBinanceUsdmOwnedProtectionBinding({
    state: initialBinanceUsdmOwnedProtectionState(),
    streams: streamsWithPosition("0.010"),
    protection: { observed_at_ms: null, stop: null, target: null },
    observedAtMs: NOW,
  });
  assert.equal(unowned.status, "blocked");
  assert.ok(unowned.blockers.includes("unowned_native_exposure_present"));
});

test("direction, symbol, stream, order, and freshness contradictions fail closed", () => {
  const state = openState();
  const cases: Array<{
    streams: BinanceUsdmStreamSupervisorStatus;
    protection: ReturnType<typeof protectionFor>;
    blocker: string;
  }> = [];

  const wrongDirection = streamsWithPosition("-0.010");
  cases.push({
    streams: wrongDirection,
    protection: protectionFor(state.current!),
    blocker: "owned_native_position_direction_mismatch",
  });

  const wrongSymbol = streamsWithPosition("0.010");
  wrongSymbol.symbol = "ETHUSDT";
  cases.push({
    streams: wrongSymbol,
    protection: protectionFor(state.current!),
    blocker: "owned_position_stream_symbol_mismatch",
  });

  const stopped = streamsWithPosition("0.010");
  stopped.private.state = "backoff";
  cases.push({
    streams: stopped,
    protection: protectionFor(state.current!),
    blocker: "private_stream_not_running",
  });

  const activeOrder = streamsWithPosition("0.010");
  activeOrder.private.account.orders.push({
    symbol: "BTCUSDT",
    order_id: 9,
    client_order_id: "unowned-order",
    side: "BUY",
    position_side: "BOTH",
    order_type: "LIMIT",
    status: "NEW",
    time_in_force: "GTC",
    original_quantity: "0.001",
    filled_quantity: "0",
    average_price: "0",
    stop_price: "0",
    reduce_only: false,
    close_position: false,
    execution_type: "NEW",
    trade_id: null,
    update_time: NOW - 100,
  });
  cases.push({
    streams: activeOrder,
    protection: protectionFor(state.current!),
    blocker: "unowned_active_ordinary_orders_present",
  });

  const stalePrivate = streamsWithPosition("0.010");
  stalePrivate.private.account.last_reconciliation_time = NOW - 60_001;
  cases.push({
    streams: stalePrivate,
    protection: protectionFor(state.current!),
    blocker: "private_reconciliation_stale",
  });

  const staleProtection = protectionFor(state.current!);
  staleProtection.observed_at_ms = NOW - 5_001;
  cases.push({
    streams: streamsWithPosition("0.010"),
    protection: staleProtection,
    blocker: "owned_protection_stale",
  });

  for (const fixture of cases) {
    const binding = compileBinanceUsdmOwnedProtectionBinding({
      state,
      streams: fixture.streams,
      protection: fixture.protection,
      observedAtMs: NOW,
    });
    assert.equal(binding.status, "blocked");
    assert.ok(binding.blockers.includes(fixture.blocker), fixture.blocker);
  }
});

test("fresh reconciled flat venue truth compiles flat but never management-ready", () => {
  const binding = compileBinanceUsdmOwnedProtectionBinding({
    state: initialBinanceUsdmOwnedProtectionState(),
    streams: streamsWithPosition("0"),
    protection: { observed_at_ms: null, stop: null, target: null },
    observedAtMs: NOW,
  });
  assert.equal(binding.status, "flat");
  assert.equal(binding.management_preconditions_satisfied, false);
  assert.deepEqual(binding.blockers, []);
});

function entryRequest(): BinanceUsdmProtectedEntryRequest {
  return {
    intentId: positionIntentId,
    symbol: "BTCUSDT",
    direction: "LONG",
    quantity: "0.010",
    stopPrice: "59000",
    targetPrice: "61000",
  };
}

function entryResult(): BinanceUsdmProtectedEntryResult {
  return {
    schema_version: "glitch.crypto.binance-usdm-protected-entry-result.v1",
    intent_id: positionIntentId,
    state: "open_protected",
    reason: "native_stop_and_target_proven",
    ids: entryIds,
    entry: ordinaryFill(entryIds.entryClientOrderId, "BUY", "0.01", false),
    stop: algoOrder(entryIds.stopClientAlgoId, "STOP_MARKET", "0.01", "59000"),
    target: algoOrder(entryIds.targetClientAlgoId, "TAKE_PROFIT_MARKET", "0.01", "61000"),
    emergency_close: null,
  };
}

function openState() {
  return applyBinanceUsdmProtectedEntryResult(
    initialBinanceUsdmOwnedProtectionState(),
    entryRequest(),
    entryResult(),
    RECORDED,
  );
}

function originalProtection(): BinanceUsdmOwnedProtection {
  return {
    positionIntentId,
    symbol: "BTCUSDT",
    direction: "LONG",
    quantity: "0.01",
    stopPrice: "59000",
    targetPrice: "61000",
    stopClientAlgoId: entryIds.stopClientAlgoId,
    targetClientAlgoId: entryIds.targetClientAlgoId,
  };
}

function revisedProtection(): BinanceUsdmOwnedProtection {
  return {
    positionIntentId,
    symbol: "BTCUSDT",
    direction: "LONG",
    quantity: "0.006",
    stopPrice: "59500",
    targetPrice: "61500",
    stopClientAlgoId: revisionIds.stopClientAlgoId,
    targetClientAlgoId: revisionIds.targetClientAlgoId,
  };
}

function revisionRequest(): BinanceUsdmProtectionRevisionRequest {
  return {
    revisionIntentId,
    current: originalProtection(),
    reductionQuantity: "0.004",
    nextStopPrice: "59500",
    nextTargetPrice: "61500",
  };
}

function revisionResult(
  state: BinanceUsdmProtectionRevisionResult["state"],
): BinanceUsdmProtectionRevisionResult {
  const proven = state === "revision_protected" || state === "revision_protected_cleanup_pending";
  return {
    schema_version: "glitch.crypto.binance-usdm-protection-revision-result.v1",
    revision_intent_id: revisionIntentId,
    position_intent_id: positionIntentId,
    state,
    reason: `fixture_${state}`,
    current: originalProtection(),
    next: {
      quantity: "0.006",
      stop_price: "59500",
      target_price: "61500",
      ids: revisionIds,
    },
    current_stop: null,
    current_target: null,
    reduction: proven ? ordinaryFill(revisionIds.reductionClientOrderId, "SELL", "0.004", true) : null,
    replacement_stop: proven ? algoOrder(revisionIds.stopClientAlgoId, "STOP_MARKET", "0.006", "59500") : null,
    replacement_target: proven ? algoOrder(revisionIds.targetClientAlgoId, "TAKE_PROFIT_MARKET", "0.006", "61500") : null,
    current_target_cleanup: state === "revision_protected"
      ? cleanup(entryIds.targetClientAlgoId, "canceled")
      : state === "revision_protected_cleanup_pending"
        ? cleanup(entryIds.targetClientAlgoId, "active")
        : null,
    current_stop_cleanup: state === "revision_protected"
      ? cleanup(entryIds.stopClientAlgoId, "canceled")
      : state === "revision_protected_cleanup_pending"
        ? cleanup(entryIds.stopClientAlgoId, "canceled")
        : null,
  };
}

function closeRequest(): BinanceUsdmOwnedProtectionCloseRequest {
  return { closeIntentId, current: revisedProtection() };
}

function originalCloseRequest(): BinanceUsdmOwnedProtectionCloseRequest {
  return { closeIntentId, current: originalProtection() };
}

function closeResult(
  state: BinanceUsdmOwnedProtectionCloseResult["state"],
): BinanceUsdmOwnedProtectionCloseResult {
  return closeResultFor(state, revisedProtection());
}

function originalCloseResult(
  state: BinanceUsdmOwnedProtectionCloseResult["state"],
): BinanceUsdmOwnedProtectionCloseResult {
  return closeResultFor(state, originalProtection());
}

function closeResultFor(
  state: BinanceUsdmOwnedProtectionCloseResult["state"],
  current: BinanceUsdmOwnedProtection,
): BinanceUsdmOwnedProtectionCloseResult {
  const request = { closeIntentId, current };
  const closeClientOrderId = validateBinanceUsdmOwnedProtectionClose(request).closeClientOrderId;
  const closed = state === "closed" || state === "closed_cleanup_pending";
  return {
    schema_version: "glitch.crypto.binance-usdm-owned-protection-close-result.v1",
    close_intent_id: closeIntentId,
    position_intent_id: positionIntentId,
    state,
    reason: `fixture_${state}`,
    current,
    close_client_order_id: closeClientOrderId,
    current_stop: null,
    current_target: null,
    close: closed ? ordinaryFill(closeClientOrderId, "SELL", current.quantity, true) : null,
    current_target_cleanup: state === "closed"
      ? cleanup(current.targetClientAlgoId, "canceled")
      : null,
    current_stop_cleanup: state === "closed"
      ? cleanup(current.stopClientAlgoId, "canceled")
      : null,
  };
}

function ordinaryFill(
  clientOrderId: string,
  side: string,
  quantity: string,
  reduceOnly: boolean,
) {
  return {
    client_order_id: clientOrderId,
    order_id: "42",
    symbol: "BTCUSDT",
    side,
    status: "FILLED",
    executed_quantity: quantity,
    average_price: "60000",
    reduce_only: reduceOnly,
  };
}

function algoOrder(
  clientAlgoId: string,
  type: "STOP_MARKET" | "TAKE_PROFIT_MARKET",
  quantity: string,
  triggerPrice: string,
): BinanceUsdmAlgoOrderEvidence {
  return {
    client_algo_id: clientAlgoId,
    algo_id: clientAlgoId + "-venue",
    symbol: "BTCUSDT",
    side: "SELL",
    order_type: type,
    status: "NEW",
    quantity,
    trigger_price: triggerPrice,
    reduce_only: true,
  };
}

function cleanup(clientAlgoId: string, disposition: "canceled" | "active") {
  return {
    client_algo_id: clientAlgoId,
    disposition,
    venue_status: disposition === "canceled" ? "CANCELED" : "NEW",
  };
}

function protectionFor(current: BinanceUsdmOwnedProtection) {
  return {
    observed_at_ms: NOW - 100,
    stop: algoOrder(
      current.stopClientAlgoId,
      "STOP_MARKET",
      current.quantity,
      current.stopPrice,
    ),
    target: algoOrder(
      current.targetClientAlgoId,
      "TAKE_PROFIT_MARKET",
      current.quantity,
      current.targetPrice,
    ),
  };
}

function streamsWithPosition(quantity: string): BinanceUsdmStreamSupervisorStatus {
  return {
    schema_version: "glitch.crypto.binance-usdm-stream-status.v1",
    desired_running: true,
    mutation_authority: false,
    symbol: "BTCUSDT",
    public: {
      state: "running",
      epoch: 1,
      reconnect_attempt: 0,
      order_book: {
        schema_version: "glitch.crypto.binance-usdm-order-book.v1",
        status: "ready",
        symbol: "BTCUSDT",
        update_id: 1,
        event_time: NOW - 100,
        transaction_time: NOW - 101,
        best_bid: ["59999", "1"],
        best_ask: ["60001", "1"],
        bids: [["59999", "1"]],
        asks: [["60001", "1"]],
        buffered_events: 0,
        gap_reason: null,
      },
    },
    private: {
      enabled: true,
      state: "running",
      epoch: 1,
      reconnect_attempt: 0,
      buffered_events: 0,
      account: {
        schema_version: "glitch.crypto.binance-usdm-private-state.v2",
        stream_expired: false,
        last_event_time: NOW - 200,
        last_transaction_time: NOW - 201,
        last_reconciliation_time: NOW - 500,
        balances: [],
        positions: [{
          symbol: "BTCUSDT",
          position_side: "BOTH",
          quantity,
          entry_price: quantity === "0" ? "0" : "60000",
          break_even_price: quantity === "0" ? null : "60005",
          realized_pnl: null,
          unrealized_pnl: "0",
          margin_type: "isolated",
          isolated_wallet: "100",
        }],
        orders: [],
        applied_event_count: 1,
      },
    },
  };
}
