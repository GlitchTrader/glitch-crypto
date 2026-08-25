import { bodyHash, canonicalJson } from "../../domain/canonical-json.js";
import {
  GlitchDatabase,
  type RuntimeStateRecord,
} from "../../storage/database.js";
import {
  decimalEquals,
  positiveDecimal,
  validateBinanceUsdmOwnedProtection,
  validateBinanceUsdmOwnedProtectionClose,
  validateBinanceUsdmProtectedEntry,
  validateBinanceUsdmProtectionRevision,
  type BinanceUsdmOwnedProtection,
  type BinanceUsdmOwnedProtectionCloseRequest,
  type BinanceUsdmProtectedEntryRequest,
  type BinanceUsdmProtectionRevisionRequest,
  type ValidatedBinanceUsdmProtectedEntry,
  type ValidatedBinanceUsdmProtectionRevision,
} from "./mutation-contract.js";
import type {
  BinanceUsdmAlgoCleanupEvidence,
  BinanceUsdmAlgoOrderEvidence,
  BinanceUsdmOrdinaryOrderEvidence,
  BinanceUsdmProtectedEntryResult,
  BinanceUsdmProtectedEntryState,
} from "./protection-coordinator.js";
import type {
  BinanceUsdmOwnedProtectionCloseResult,
  BinanceUsdmOwnedProtectionCloseState,
  BinanceUsdmProtectionRevisionResult,
  BinanceUsdmProtectionRevisionState,
} from "./protection-revision.js";
import type { BinanceUsdmStreamSupervisorStatus } from "./stream-supervisor.js";

const OWNED_PROTECTION_STATE_KEY = "binance-usdm.owned-protection";
const TERMINAL_ORDER_STATUSES = new Set([
  "FILLED",
  "CANCELED",
  "EXPIRED",
  "EXPIRED_IN_MATCH",
  "REJECTED",
]);

export type BinanceUsdmOwnedProtectionTransitionKind =
  | "protected_entry"
  | "protection_revision"
  | "owned_position_close";

export type BinanceUsdmOwnedProtectionPending =
  | {
      kind: "protected_entry";
      intent_id: string;
      result_state: "intent_persisted" | BinanceUsdmProtectedEntryState;
      reason: string;
      request: BinanceUsdmProtectedEntryRequest;
    }
  | {
      kind: "protection_revision";
      intent_id: string;
      result_state: "intent_persisted" | BinanceUsdmProtectionRevisionState;
      reason: string;
      request: BinanceUsdmProtectionRevisionRequest;
    }
  | {
      kind: "owned_position_close";
      intent_id: string;
      result_state: "intent_persisted" | BinanceUsdmOwnedProtectionCloseState;
      reason: string;
      request: BinanceUsdmOwnedProtectionCloseRequest;
    };

export interface BinanceUsdmOwnedProtectionState {
  schema_version: "glitch.crypto.binance-usdm-owned-protection-state.v1";
  transition_sequence: number;
  current: BinanceUsdmOwnedProtection | null;
  pending: BinanceUsdmOwnedProtectionPending | null;
  last_transition: {
    kind: BinanceUsdmOwnedProtectionTransitionKind;
    intent_id: string;
    result_state: string;
    reason: string;
  } | null;
  updated_utc: string | null;
}

export interface BinanceUsdmOwnedProtectionSnapshot {
  storage_version: number;
  storage_body_hash: string;
  state: BinanceUsdmOwnedProtectionState;
}

export class BinanceUsdmOwnedProtectionRepository {
  constructor(private readonly database: GlitchDatabase) {}

  load(): BinanceUsdmOwnedProtectionSnapshot {
    const stored = this.database.getRuntimeState<BinanceUsdmOwnedProtectionState>(
      OWNED_PROTECTION_STATE_KEY,
    );
    if (stored === null) {
      const state = initialBinanceUsdmOwnedProtectionState();
      return {
        storage_version: 0,
        storage_body_hash: bodyHash(state),
        state,
      };
    }
    return snapshot(stored);
  }

  save(
    expectedStorageVersion: number,
    state: BinanceUsdmOwnedProtectionState,
  ): BinanceUsdmOwnedProtectionSnapshot {
    const valid = validateOwnedProtectionState(state);
    return snapshot(this.database.compareAndSetRuntimeState(
      OWNED_PROTECTION_STATE_KEY,
      expectedStorageVersion,
      valid,
    ));
  }
}

export function initialBinanceUsdmOwnedProtectionState(): BinanceUsdmOwnedProtectionState {
  return deepFreeze({
    schema_version: "glitch.crypto.binance-usdm-owned-protection-state.v1",
    transition_sequence: 0,
    current: null,
    pending: null,
    last_transition: null,
    updated_utc: null,
  });
}

export function stageBinanceUsdmProtectedEntry(
  state: BinanceUsdmOwnedProtectionState,
  request: BinanceUsdmProtectedEntryRequest,
  recordedUtc: string,
): BinanceUsdmOwnedProtectionState {
  const currentState = validateOwnedProtectionState(state);
  const plan = validateBinanceUsdmProtectedEntry(request);
  const canonicalRequest = protectedEntryRequest(plan);
  if (currentState.pending !== null) {
    assertTransitionAvailable(currentState, "protected_entry", canonicalRequest);
    return currentState;
  }
  if (currentState.current !== null) {
    throw new Error("protected entry cannot replace an active owned position");
  }
  return nextState(
    currentState,
    null,
    {
      kind: "protected_entry",
      intent_id: plan.intentId,
      result_state: "intent_persisted",
      reason: "protected_entry_intent_persisted_before_transport",
      request: canonicalRequest,
    },
    "protected_entry",
    plan.intentId,
    "intent_persisted",
    "protected_entry_intent_persisted_before_transport",
    recordedUtc,
  );
}

export function stageBinanceUsdmProtectionRevision(
  state: BinanceUsdmOwnedProtectionState,
  request: BinanceUsdmProtectionRevisionRequest,
  recordedUtc: string,
): BinanceUsdmOwnedProtectionState {
  const currentState = validateOwnedProtectionState(state);
  const plan = validateBinanceUsdmProtectionRevision(request);
  const canonicalRequest = protectionRevisionRequest(plan);
  if (currentState.pending !== null) {
    assertTransitionAvailable(currentState, "protection_revision", canonicalRequest);
    return currentState;
  }
  if (!ownedProtectionEquals(currentState.current, plan.current)) {
    throw new Error("protection revision current pointer does not match durable ownership");
  }
  return nextState(
    currentState,
    plan.current,
    {
      kind: "protection_revision",
      intent_id: plan.revisionIntentId,
      result_state: "intent_persisted",
      reason: "protection_revision_intent_persisted_before_transport",
      request: canonicalRequest,
    },
    "protection_revision",
    plan.revisionIntentId,
    "intent_persisted",
    "protection_revision_intent_persisted_before_transport",
    recordedUtc,
  );
}

export function stageBinanceUsdmOwnedProtectionClose(
  state: BinanceUsdmOwnedProtectionState,
  request: BinanceUsdmOwnedProtectionCloseRequest,
  recordedUtc: string,
): BinanceUsdmOwnedProtectionState {
  const currentState = validateOwnedProtectionState(state);
  const plan = validateBinanceUsdmOwnedProtectionClose(request);
  const canonicalRequest: BinanceUsdmOwnedProtectionCloseRequest = {
    closeIntentId: plan.closeIntentId,
    current: plan.current,
  };
  if (currentState.pending !== null) {
    assertTransitionAvailable(currentState, "owned_position_close", canonicalRequest);
    return currentState;
  }
  if (!ownedProtectionEquals(currentState.current, plan.current)) {
    throw new Error("owned close current pointer does not match durable ownership");
  }
  return nextState(
    currentState,
    plan.current,
    {
      kind: "owned_position_close",
      intent_id: plan.closeIntentId,
      result_state: "intent_persisted",
      reason: "owned_position_close_intent_persisted_before_transport",
      request: canonicalRequest,
    },
    "owned_position_close",
    plan.closeIntentId,
    "intent_persisted",
    "owned_position_close_intent_persisted_before_transport",
    recordedUtc,
  );
}

export function applyBinanceUsdmProtectedEntryResult(
  state: BinanceUsdmOwnedProtectionState,
  request: BinanceUsdmProtectedEntryRequest,
  result: BinanceUsdmProtectedEntryResult,
  recordedUtc: string,
): BinanceUsdmOwnedProtectionState {
  const currentState = validateOwnedProtectionState(state);
  const plan = validateBinanceUsdmProtectedEntry(request);
  const canonicalRequest = protectedEntryRequest(plan);
  assertTransitionAvailable(currentState, "protected_entry", canonicalRequest);
  if (currentState.current !== null) {
    throw new Error("protected entry cannot replace an active owned position");
  }
  assertProtectedEntryResult(plan, result);
  if (
    currentState.pending?.kind === "protected_entry" &&
    result.state === "rejected_before_exposure"
  ) {
    throw new Error("ambiguous protected entry cannot later be treated as rejected");
  }

  if (result.state === "open_protected") {
    assertProtectedEntryProof(plan, result);
    return nextState(
      currentState,
      {
        positionIntentId: plan.intentId,
        symbol: plan.symbol,
        direction: plan.direction,
        quantity: plan.quantity,
        stopPrice: plan.stopPrice,
        targetPrice: plan.targetPrice,
        stopClientAlgoId: plan.ids.stopClientAlgoId,
        targetClientAlgoId: plan.ids.targetClientAlgoId,
      },
      null,
      "protected_entry",
      plan.intentId,
      result.state,
      result.reason,
      recordedUtc,
    );
  }
  if (
    result.state === "rejected_before_exposure" ||
    result.state === "emergency_flatten_confirmed"
  ) {
    if (result.state === "emergency_flatten_confirmed") {
      assertEmergencyFlattenProof(plan, result);
    }
    return nextState(
      currentState,
      null,
      null,
      "protected_entry",
      plan.intentId,
      result.state,
      result.reason,
      recordedUtc,
    );
  }
  return nextState(
    currentState,
    null,
    {
      kind: "protected_entry",
      intent_id: plan.intentId,
      result_state: result.state,
      reason: result.reason,
      request: canonicalRequest,
    },
    "protected_entry",
    plan.intentId,
    result.state,
    result.reason,
    recordedUtc,
  );
}

export function applyBinanceUsdmProtectionRevisionResult(
  state: BinanceUsdmOwnedProtectionState,
  request: BinanceUsdmProtectionRevisionRequest,
  result: BinanceUsdmProtectionRevisionResult,
  recordedUtc: string,
): BinanceUsdmOwnedProtectionState {
  const currentState = validateOwnedProtectionState(state);
  const plan = validateBinanceUsdmProtectionRevision(request);
  const canonicalRequest = protectionRevisionRequest(plan);
  assertTransitionAvailable(currentState, "protection_revision", canonicalRequest);
  if (
    currentState.pending === null &&
    !ownedProtectionEquals(currentState.current, plan.current)
  ) {
    throw new Error("protection revision current pointer does not match durable ownership");
  }
  assertProtectionRevisionResult(plan, result);
  if (
    currentState.pending?.kind === "protection_revision" &&
    result.state === "reduction_rejected"
  ) {
    throw new Error("ambiguous protection revision cannot later be treated as rejected");
  }

  const next = validateBinanceUsdmOwnedProtection({
    positionIntentId: plan.current.positionIntentId,
    symbol: plan.current.symbol,
    direction: plan.current.direction,
    quantity: plan.remainingQuantity,
    stopPrice: plan.nextStopPrice,
    targetPrice: plan.nextTargetPrice,
    stopClientAlgoId: plan.ids.stopClientAlgoId,
    targetClientAlgoId: plan.ids.targetClientAlgoId,
  });
  if (
    result.state === "revision_protected" ||
    result.state === "revision_protected_cleanup_pending"
  ) {
    assertProtectionRevisionProof(plan, result);
  }
  if (result.state === "revision_protected") {
    return nextState(
      currentState,
      next,
      null,
      "protection_revision",
      plan.revisionIntentId,
      result.state,
      result.reason,
      recordedUtc,
    );
  }
  if (result.state === "reduction_rejected") {
    return nextState(
      currentState,
      plan.current,
      null,
      "protection_revision",
      plan.revisionIntentId,
      result.state,
      result.reason,
      recordedUtc,
    );
  }
  return nextState(
    currentState,
    result.state === "revision_protected_cleanup_pending" ? next : currentState.current,
    {
      kind: "protection_revision",
      intent_id: plan.revisionIntentId,
      result_state: result.state,
      reason: result.reason,
      request: canonicalRequest,
    },
    "protection_revision",
    plan.revisionIntentId,
    result.state,
    result.reason,
    recordedUtc,
  );
}

export function applyBinanceUsdmOwnedProtectionCloseResult(
  state: BinanceUsdmOwnedProtectionState,
  request: BinanceUsdmOwnedProtectionCloseRequest,
  result: BinanceUsdmOwnedProtectionCloseResult,
  recordedUtc: string,
): BinanceUsdmOwnedProtectionState {
  const currentState = validateOwnedProtectionState(state);
  const plan = validateBinanceUsdmOwnedProtectionClose(request);
  const canonicalRequest: BinanceUsdmOwnedProtectionCloseRequest = {
    closeIntentId: plan.closeIntentId,
    current: plan.current,
  };
  assertTransitionAvailable(currentState, "owned_position_close", canonicalRequest);
  if (
    currentState.pending === null &&
    !ownedProtectionEquals(currentState.current, plan.current)
  ) {
    throw new Error("owned close current pointer does not match durable ownership");
  }
  assertOwnedProtectionCloseResult(
    plan.closeIntentId,
    plan.closeClientOrderId,
    plan.current,
    result,
  );
  if (result.state === "closed" || result.state === "closed_cleanup_pending") {
    assertOwnedProtectionCloseProof(plan.closeClientOrderId, plan.current, result);
  }
  if (result.state === "closed") {
    return nextState(
      currentState,
      null,
      null,
      "owned_position_close",
      plan.closeIntentId,
      result.state,
      result.reason,
      recordedUtc,
    );
  }
  return nextState(
    currentState,
    currentState.current,
    {
      kind: "owned_position_close",
      intent_id: plan.closeIntentId,
      result_state: result.state,
      reason: result.reason,
      request: canonicalRequest,
    },
    "owned_position_close",
    plan.closeIntentId,
    result.state,
    result.reason,
    recordedUtc,
  );
}

export interface BinanceUsdmOwnedProtectionBindingFreshness {
  private_reconciliation_max_age_ms: number;
  protection_max_age_ms: number;
  future_tolerance_ms: number;
}

export interface CompileBinanceUsdmOwnedProtectionBindingInput {
  state: BinanceUsdmOwnedProtectionState;
  streams: BinanceUsdmStreamSupervisorStatus;
  protection: {
    observed_at_ms: number | null;
    stop: BinanceUsdmAlgoOrderEvidence | null;
    target: BinanceUsdmAlgoOrderEvidence | null;
  };
  observedAtMs: number;
  freshness?: Partial<BinanceUsdmOwnedProtectionBindingFreshness>;
}

export interface BinanceUsdmOwnedProtectionBinding {
  readonly schema_version: "glitch.crypto.binance-usdm-owned-protection-binding.v1";
  readonly venue: "binance-usdm";
  readonly environment: "testnet";
  readonly status: "flat" | "ready" | "blocked";
  readonly mutation_authority: false;
  readonly engine_binding_authority: false;
  readonly management_preconditions_satisfied: boolean;
  readonly observed_utc: string;
  readonly state_body_hash: string;
  readonly transition_sequence: number;
  readonly current: Readonly<BinanceUsdmOwnedProtection> | null;
  readonly pending: Readonly<BinanceUsdmOwnedProtectionPending> | null;
  readonly native_position: Readonly<{
    symbol: string;
    direction: "LONG" | "SHORT";
    quantity: string;
    entry_price: string;
    break_even_price: string | null;
    unrealized_pnl: string | null;
  }> | null;
  readonly protection: Readonly<{
    observed_at_ms: number | null;
    stop: Readonly<BinanceUsdmAlgoOrderEvidence> | null;
    target: Readonly<BinanceUsdmAlgoOrderEvidence> | null;
  }>;
  readonly freshness: Readonly<BinanceUsdmOwnedProtectionBindingFreshness>;
  readonly blockers: readonly string[];
}

const DEFAULT_BINDING_FRESHNESS: BinanceUsdmOwnedProtectionBindingFreshness = {
  private_reconciliation_max_age_ms: 60_000,
  protection_max_age_ms: 5_000,
  future_tolerance_ms: 5_000,
};

export function compileBinanceUsdmOwnedProtectionBinding(
  input: CompileBinanceUsdmOwnedProtectionBindingInput,
): BinanceUsdmOwnedProtectionBinding {
  const state = validateOwnedProtectionState(input.state);
  const observedAtMs = boundedInteger(input.observedAtMs, 1, Number.MAX_SAFE_INTEGER, "binding observation time");
  const freshness = compileBindingFreshness(input.freshness);
  const blockers: string[] = [];
  const stopEvidence = copyAlgoEvidence(input.protection.stop);
  const targetEvidence = copyAlgoEvidence(input.protection.target);
  const privateLane = input.streams.private;
  const account = privateLane.account;

  if (
    input.streams.schema_version !== "glitch.crypto.binance-usdm-stream-status.v1" ||
    account.schema_version !== "glitch.crypto.binance-usdm-private-state.v2"
  ) {
    blockers.push("private_runtime_contract_invalid");
  }
  if (input.streams.mutation_authority !== false) {
    blockers.push("private_runtime_read_only_authority_not_proven");
  }
  if (input.streams.symbol !== "BTCUSDT") {
    blockers.push("unsupported_owned_position_symbol");
  }
  if (!input.streams.desired_running || !privateLane.enabled || privateLane.state !== "running") {
    blockers.push("private_stream_not_running");
  }
  if (privateLane.buffered_events !== 0) {
    blockers.push("private_stream_has_buffered_events");
  }
  if (account.stream_expired) {
    blockers.push("private_stream_expired");
  }
  checkFreshness(
    account.last_reconciliation_time,
    observedAtMs,
    freshness.private_reconciliation_max_age_ms,
    freshness.future_tolerance_ms,
    "private_reconciliation",
    blockers,
  );
  checkFutureOnly(account.last_event_time, observedAtMs, freshness.future_tolerance_ms, "private_event", blockers);
  checkFutureOnly(account.last_transaction_time, observedAtMs, freshness.future_tolerance_ms, "private_transaction", blockers);
  if (state.pending !== null) {
    blockers.push("owned_protection_reconciliation_pending");
  }

  const activeOrders = account.orders.filter((order) => !TERMINAL_ORDER_STATUSES.has(order.status));
  if (activeOrders.length > 0) {
    blockers.push("unowned_active_ordinary_orders_present");
  }

  const activePositions: Array<{
    symbol: string;
    direction: "LONG" | "SHORT";
    quantity: string;
    entry_price: string;
    break_even_price: string | null;
    unrealized_pnl: string | null;
    position_side: string;
  }> = [];
  for (const position of account.positions) {
    const quantity = signedPositionQuantity(position.quantity);
    if (quantity === null) {
      blockers.push("native_position_quantity_invalid");
      continue;
    }
    if (position.position_side !== "BOTH") {
      blockers.push("native_position_mode_mismatch");
    }
    if (quantity !== "0") {
      activePositions.push({
        symbol: position.symbol,
        direction: position.quantity.startsWith("-") ? "SHORT" : "LONG",
        quantity,
        entry_price: position.entry_price,
        break_even_price: position.break_even_price,
        unrealized_pnl: position.unrealized_pnl,
        position_side: position.position_side,
      });
    }
  }

  let nativePosition: BinanceUsdmOwnedProtectionBinding["native_position"] = null;
  const current = state.current;
  if (current === null) {
    if (activePositions.length > 0) {
      blockers.push("unowned_native_exposure_present");
    }
    if (stopEvidence !== null || targetEvidence !== null) {
      blockers.push("unowned_native_protection_evidence_present");
    }
  } else {
    if (input.streams.symbol !== current.symbol) {
      blockers.push("owned_position_stream_symbol_mismatch");
    }
    if (activePositions.length !== 1) {
      blockers.push("owned_native_position_count_mismatch");
    } else {
      const position = activePositions[0]!;
      nativePosition = {
        symbol: position.symbol,
        direction: position.direction,
        quantity: position.quantity,
        entry_price: position.entry_price,
        break_even_price: position.break_even_price,
        unrealized_pnl: position.unrealized_pnl,
      };
      if (position.symbol !== current.symbol) {
        blockers.push("owned_native_position_symbol_mismatch");
      }
      if (position.position_side !== "BOTH") {
        blockers.push("owned_native_position_mode_mismatch");
      }
      if (position.direction !== current.direction) {
        blockers.push("owned_native_position_direction_mismatch");
      }
      if (!decimalEquals(position.quantity, current.quantity)) {
        blockers.push("owned_native_position_quantity_mismatch");
      }
    }
    checkFreshness(
      input.protection.observed_at_ms,
      observedAtMs,
      freshness.protection_max_age_ms,
      freshness.future_tolerance_ms,
      "owned_protection",
      blockers,
    );
    if (!algoEvidenceMatches(stopEvidence, current, "STOP_MARKET")) {
      blockers.push("exact_owned_stop_not_proven");
    }
    if (!algoEvidenceMatches(targetEvidence, current, "TAKE_PROFIT_MARKET")) {
      blockers.push("exact_owned_target_not_proven");
    }
  }

  const uniqueBlockers = [...new Set(blockers)].sort();
  const status = uniqueBlockers.length > 0
    ? "blocked"
    : current === null
      ? "flat"
      : "ready";
  return deepFreeze({
    schema_version: "glitch.crypto.binance-usdm-owned-protection-binding.v1",
    venue: "binance-usdm",
    environment: "testnet",
    status,
    mutation_authority: false,
    engine_binding_authority: false,
    management_preconditions_satisfied: status === "ready",
    observed_utc: new Date(observedAtMs).toISOString(),
    state_body_hash: bodyHash(state),
    transition_sequence: state.transition_sequence,
    current,
    pending: state.pending,
    native_position: nativePosition,
    protection: {
      observed_at_ms: input.protection.observed_at_ms,
      stop: stopEvidence,
      target: targetEvidence,
    },
    freshness,
    blockers: uniqueBlockers,
  });
}

function snapshot(
  stored: RuntimeStateRecord<BinanceUsdmOwnedProtectionState>,
): BinanceUsdmOwnedProtectionSnapshot {
  const state = validateOwnedProtectionState(stored.value);
  if (bodyHash(state) !== stored.bodyHash) {
    throw new Error("owned-protection stored state is not canonical");
  }
  return deepFreeze({
    storage_version: stored.version,
    storage_body_hash: stored.bodyHash,
    state,
  });
}

function protectedEntryRequest(
  plan: ValidatedBinanceUsdmProtectedEntry,
): BinanceUsdmProtectedEntryRequest {
  return {
    intentId: plan.intentId,
    symbol: plan.symbol,
    direction: plan.direction,
    quantity: plan.quantity,
    stopPrice: plan.stopPrice,
    targetPrice: plan.targetPrice,
  };
}

function protectionRevisionRequest(
  plan: ValidatedBinanceUsdmProtectionRevision,
): BinanceUsdmProtectionRevisionRequest {
  return {
    revisionIntentId: plan.revisionIntentId,
    current: plan.current,
    reductionQuantity: plan.reductionQuantity,
    nextStopPrice: plan.nextStopPrice,
    nextTargetPrice: plan.nextTargetPrice,
  };
}

function assertTransitionAvailable(
  state: BinanceUsdmOwnedProtectionState,
  kind: BinanceUsdmOwnedProtectionTransitionKind,
  request: unknown,
): void {
  if (state.pending === null) {
    return;
  }
  if (state.pending.kind !== kind || canonicalJson(state.pending.request) !== canonicalJson(request)) {
    throw new Error("owned-protection transition conflicts with pending reconciliation");
  }
}

function assertProtectedEntryResult(
  plan: ValidatedBinanceUsdmProtectedEntry,
  result: BinanceUsdmProtectedEntryResult,
): void {
  const states = new Set<BinanceUsdmProtectedEntryState>([
    "rejected_before_exposure",
    "entry_visibility_pending",
    "emergency_flatten_pending",
    "emergency_flatten_confirmed",
    "open_protected_target_pending",
    "open_protected",
  ]);
  if (
    result.schema_version !== "glitch.crypto.binance-usdm-protected-entry-result.v1" ||
    result.intent_id !== plan.intentId ||
    !states.has(result.state) ||
    canonicalJson(result.ids) !== canonicalJson(plan.ids) ||
    !nonempty(result.reason)
  ) {
    throw new Error("protected-entry result does not match its canonical request");
  }
}

function assertProtectedEntryProof(
  plan: ValidatedBinanceUsdmProtectedEntry,
  result: BinanceUsdmProtectedEntryResult,
): void {
  if (!ordinaryFillMatches(result.entry, plan.symbol, plan.entrySide, plan.ids.entryClientOrderId, false, plan.quantity)) {
    throw new Error("protected-entry fill proof is incomplete");
  }
  if (!algoProofMatches(result.stop, plan.symbol, plan.exitSide, "STOP_MARKET", plan.ids.stopClientAlgoId, plan.quantity, plan.stopPrice)) {
    throw new Error("protected-entry stop proof is incomplete");
  }
  if (!algoProofMatches(result.target, plan.symbol, plan.exitSide, "TAKE_PROFIT_MARKET", plan.ids.targetClientAlgoId, plan.quantity, plan.targetPrice)) {
    throw new Error("protected-entry target proof is incomplete");
  }
}

function assertEmergencyFlattenProof(
  plan: ValidatedBinanceUsdmProtectedEntry,
  result: BinanceUsdmProtectedEntryResult,
): void {
  const entry = result.entry;
  const executedQuantity = positiveDecimal(entry?.executed_quantity);
  if (
    entry === null ||
    executedQuantity === null ||
    entry.client_order_id !== plan.ids.entryClientOrderId ||
    entry.symbol !== plan.symbol ||
    entry.side !== plan.entrySide ||
    (entry.status !== "FILLED" && entry.status !== "PARTIALLY_FILLED") ||
    entry.reduce_only !== false ||
    (entry.status === "FILLED" && !decimalEquals(executedQuantity, plan.quantity))
  ) {
    throw new Error("emergency-flatten entry proof is incomplete");
  }
  if (!ordinaryFillMatches(
    result.emergency_close,
    plan.symbol,
    plan.exitSide,
    plan.ids.emergencyCloseClientOrderId,
    true,
    executedQuantity,
  )) {
    throw new Error("emergency-flatten close proof is incomplete");
  }
}

function assertProtectionRevisionResult(
  plan: ValidatedBinanceUsdmProtectionRevision,
  result: BinanceUsdmProtectionRevisionResult,
): void {
  const states = new Set<BinanceUsdmProtectionRevisionState>([
    "current_protection_not_proven",
    "reduction_rejected",
    "reduction_visibility_pending",
    "replacement_stop_pending",
    "replacement_target_pending",
    "revision_protected_cleanup_pending",
    "revision_protected",
  ]);
  const expectedNext = {
    quantity: plan.remainingQuantity,
    stop_price: plan.nextStopPrice,
    target_price: plan.nextTargetPrice,
    ids: plan.ids,
  };
  if (
    result.schema_version !== "glitch.crypto.binance-usdm-protection-revision-result.v1" ||
    result.revision_intent_id !== plan.revisionIntentId ||
    result.position_intent_id !== plan.current.positionIntentId ||
    !states.has(result.state) ||
    !ownedProtectionEquals(result.current, plan.current) ||
    canonicalJson(result.next) !== canonicalJson(expectedNext) ||
    !nonempty(result.reason)
  ) {
    throw new Error("protection-revision result does not match its canonical request");
  }
}

function assertProtectionRevisionProof(
  plan: ValidatedBinanceUsdmProtectionRevision,
  result: BinanceUsdmProtectionRevisionResult,
): void {
  if (
    plan.reductionQuantity !== null &&
    !ordinaryFillMatches(
      result.reduction,
      plan.current.symbol,
      plan.exitSide,
      plan.ids.reductionClientOrderId,
      true,
      plan.reductionQuantity,
    )
  ) {
    throw new Error("protection-revision reduction proof is incomplete");
  }
  if (!algoProofMatches(result.replacement_stop, plan.current.symbol, plan.exitSide, "STOP_MARKET", plan.ids.stopClientAlgoId, plan.remainingQuantity, plan.nextStopPrice)) {
    throw new Error("protection-revision stop proof is incomplete");
  }
  if (!algoProofMatches(result.replacement_target, plan.current.symbol, plan.exitSide, "TAKE_PROFIT_MARKET", plan.ids.targetClientAlgoId, plan.remainingQuantity, plan.nextTargetPrice)) {
    throw new Error("protection-revision target proof is incomplete");
  }
  if (
    result.state === "revision_protected" &&
    (!cleanupIsComplete(result.current_target_cleanup) || !cleanupIsComplete(result.current_stop_cleanup))
  ) {
    throw new Error("protection-revision cleanup proof is incomplete");
  }
}

function assertOwnedProtectionCloseResult(
  closeIntentId: string,
  closeClientOrderId: string,
  current: BinanceUsdmOwnedProtection,
  result: BinanceUsdmOwnedProtectionCloseResult,
): void {
  const states = new Set<BinanceUsdmOwnedProtectionCloseState>([
    "owned_protection_not_proven",
    "close_visibility_pending",
    "closed_cleanup_pending",
    "closed",
  ]);
  if (
    result.schema_version !== "glitch.crypto.binance-usdm-owned-protection-close-result.v1" ||
    result.close_intent_id !== closeIntentId ||
    result.position_intent_id !== current.positionIntentId ||
    result.close_client_order_id !== closeClientOrderId ||
    !states.has(result.state) ||
    !ownedProtectionEquals(result.current, current) ||
    !nonempty(result.reason)
  ) {
    throw new Error("owned-position close result does not match its canonical request");
  }
}

function assertOwnedProtectionCloseProof(
  closeClientOrderId: string,
  current: BinanceUsdmOwnedProtection,
  result: BinanceUsdmOwnedProtectionCloseResult,
): void {
  const exitSide = current.direction === "LONG" ? "SELL" : "BUY";
  if (!ordinaryFillMatches(result.close, current.symbol, exitSide, closeClientOrderId, true, current.quantity)) {
    throw new Error("owned-position close proof is incomplete");
  }
  if (
    result.state === "closed" &&
    (!cleanupIsComplete(result.current_target_cleanup) || !cleanupIsComplete(result.current_stop_cleanup))
  ) {
    throw new Error("owned-position close cleanup proof is incomplete");
  }
}

function ordinaryFillMatches(
  evidence: BinanceUsdmOrdinaryOrderEvidence | null,
  symbol: string,
  side: string,
  clientOrderId: string,
  reduceOnly: boolean,
  quantity: string,
): boolean {
  return evidence !== null &&
    evidence.client_order_id === clientOrderId &&
    evidence.symbol === symbol &&
    evidence.side === side &&
    evidence.status === "FILLED" &&
    evidence.reduce_only === reduceOnly &&
    decimalEquals(evidence.executed_quantity, quantity);
}

function algoProofMatches(
  evidence: BinanceUsdmAlgoOrderEvidence | null,
  symbol: string,
  side: string,
  type: "STOP_MARKET" | "TAKE_PROFIT_MARKET",
  clientAlgoId: string,
  quantity: string,
  triggerPrice: string,
): boolean {
  return evidence !== null &&
    evidence.client_algo_id === clientAlgoId &&
    evidence.symbol === symbol &&
    evidence.side === side &&
    evidence.order_type === type &&
    (evidence.status === "NEW" || evidence.status === "WORKING") &&
    evidence.reduce_only === true &&
    decimalEquals(evidence.quantity, quantity) &&
    decimalEquals(evidence.trigger_price, triggerPrice);
}

function cleanupIsComplete(evidence: BinanceUsdmAlgoCleanupEvidence | null): boolean {
  return evidence?.disposition === "canceled" || evidence?.disposition === "absent";
}

function algoEvidenceMatches(
  evidence: BinanceUsdmAlgoOrderEvidence | null,
  current: BinanceUsdmOwnedProtection,
  type: "STOP_MARKET" | "TAKE_PROFIT_MARKET",
): boolean {
  const clientId = type === "STOP_MARKET"
    ? current.stopClientAlgoId
    : current.targetClientAlgoId;
  const triggerPrice = type === "STOP_MARKET"
    ? current.stopPrice
    : current.targetPrice;
  const exitSide = current.direction === "LONG" ? "SELL" : "BUY";
  return algoProofMatches(
    evidence,
    current.symbol,
    exitSide,
    type,
    clientId,
    current.quantity,
    triggerPrice,
  );
}

function copyAlgoEvidence(
  evidence: BinanceUsdmAlgoOrderEvidence | null,
): BinanceUsdmAlgoOrderEvidence | null {
  return evidence === null
    ? null
    : {
        client_algo_id: evidence.client_algo_id,
        algo_id: evidence.algo_id,
        symbol: evidence.symbol,
        side: evidence.side,
        order_type: evidence.order_type,
        status: evidence.status,
        quantity: evidence.quantity,
        trigger_price: evidence.trigger_price,
        reduce_only: evidence.reduce_only,
      };
}

function nextState(
  state: BinanceUsdmOwnedProtectionState,
  current: BinanceUsdmOwnedProtection | null,
  pending: BinanceUsdmOwnedProtectionPending | null,
  kind: BinanceUsdmOwnedProtectionTransitionKind,
  intentId: string,
  resultState: string,
  reason: string,
  recordedUtc: string,
): BinanceUsdmOwnedProtectionState {
  const updatedUtc = isoUtc(recordedUtc);
  return validateOwnedProtectionState({
    schema_version: "glitch.crypto.binance-usdm-owned-protection-state.v1",
    transition_sequence: state.transition_sequence + 1,
    current,
    pending,
    last_transition: {
      kind,
      intent_id: intentId,
      result_state: resultState,
      reason,
    },
    updated_utc: updatedUtc,
  });
}

function validateOwnedProtectionState(
  value: BinanceUsdmOwnedProtectionState,
): BinanceUsdmOwnedProtectionState {
  if (
    value === null ||
    typeof value !== "object" ||
    value.schema_version !== "glitch.crypto.binance-usdm-owned-protection-state.v1" ||
    !Number.isSafeInteger(value.transition_sequence) ||
    value.transition_sequence < 0
  ) {
    throw new Error("owned-protection state contract is invalid");
  }
  const current = value.current === null
    ? null
    : validateBinanceUsdmOwnedProtection(value.current);
  const pending = value.pending === null ? null : canonicalPending(value.pending);
  const updatedUtc = value.updated_utc === null ? null : isoUtc(value.updated_utc);
  let lastTransition: BinanceUsdmOwnedProtectionState["last_transition"] = null;
  if (value.last_transition !== null) {
    const transition = value.last_transition;
    if (
      !new Set<BinanceUsdmOwnedProtectionTransitionKind>([
        "protected_entry",
        "protection_revision",
        "owned_position_close",
      ]).has(transition.kind) ||
      !nonempty(transition.intent_id) ||
      !nonempty(transition.result_state) ||
      !nonempty(transition.reason)
    ) {
      throw new Error("owned-protection last transition is invalid");
    }
    lastTransition = { ...transition };
  }
  if ((value.transition_sequence === 0) !== (lastTransition === null && updatedUtc === null)) {
    throw new Error("owned-protection transition sequence is inconsistent");
  }
  if (pending?.kind === "protected_entry" && current !== null) {
    throw new Error("pending protected entry cannot coexist with a current pointer");
  }
  if (
    (pending?.kind === "protection_revision" || pending?.kind === "owned_position_close") &&
    current === null
  ) {
    throw new Error("pending position management requires a current pointer");
  }
  return deepFreeze({
    schema_version: "glitch.crypto.binance-usdm-owned-protection-state.v1",
    transition_sequence: value.transition_sequence,
    current,
    pending,
    last_transition: lastTransition,
    updated_utc: updatedUtc,
  });
}

function canonicalPending(
  value: BinanceUsdmOwnedProtectionPending,
): BinanceUsdmOwnedProtectionPending {
  if (!nonempty(value.reason)) {
    throw new Error("owned-protection pending reason is invalid");
  }
  if (value.kind === "protected_entry") {
    const plan = validateBinanceUsdmProtectedEntry(value.request);
    if (value.intent_id !== plan.intentId) {
      throw new Error("owned-protection pending entry identity mismatch");
    }
    if (!new Set<string>([
      "intent_persisted",
      "entry_visibility_pending",
      "emergency_flatten_pending",
      "open_protected_target_pending",
    ]).has(value.result_state)) {
      throw new Error("owned-protection pending entry state is terminal or invalid");
    }
    return {
      kind: value.kind,
      intent_id: plan.intentId,
      result_state: value.result_state,
      reason: value.reason,
      request: protectedEntryRequest(plan),
    };
  }
  if (value.kind === "protection_revision") {
    const plan = validateBinanceUsdmProtectionRevision(value.request);
    if (value.intent_id !== plan.revisionIntentId) {
      throw new Error("owned-protection pending revision identity mismatch");
    }
    if (!new Set<string>([
      "intent_persisted",
      "current_protection_not_proven",
      "reduction_visibility_pending",
      "replacement_stop_pending",
      "replacement_target_pending",
      "revision_protected_cleanup_pending",
    ]).has(value.result_state)) {
      throw new Error("owned-protection pending revision state is terminal or invalid");
    }
    return {
      kind: value.kind,
      intent_id: plan.revisionIntentId,
      result_state: value.result_state,
      reason: value.reason,
      request: protectionRevisionRequest(plan),
    };
  }
  if (value.kind === "owned_position_close") {
    const plan = validateBinanceUsdmOwnedProtectionClose(value.request);
    if (value.intent_id !== plan.closeIntentId) {
      throw new Error("owned-protection pending close identity mismatch");
    }
    if (!new Set<string>([
      "intent_persisted",
      "owned_protection_not_proven",
      "close_visibility_pending",
      "closed_cleanup_pending",
    ]).has(value.result_state)) {
      throw new Error("owned-protection pending close state is terminal or invalid");
    }
    return {
      kind: value.kind,
      intent_id: plan.closeIntentId,
      result_state: value.result_state,
      reason: value.reason,
      request: {
        closeIntentId: plan.closeIntentId,
        current: plan.current,
      },
    };
  }
  throw new Error("owned-protection pending kind is invalid");
}

function ownedProtectionEquals(
  left: BinanceUsdmOwnedProtection | null,
  right: BinanceUsdmOwnedProtection,
): boolean {
  return left !== null && canonicalJson(left) === canonicalJson(right);
}

function signedPositionQuantity(value: unknown): string | null {
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    return null;
  }
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  const canonical = trimmed ? `${whole}.${trimmed}` : whole;
  if (canonical === "0") {
    return "0";
  }
  return negative ? canonical : canonical;
}

function compileBindingFreshness(
  patch: Partial<BinanceUsdmOwnedProtectionBindingFreshness> | undefined,
): BinanceUsdmOwnedProtectionBindingFreshness {
  const result = { ...DEFAULT_BINDING_FRESHNESS, ...patch };
  result.private_reconciliation_max_age_ms = boundedInteger(
    result.private_reconciliation_max_age_ms,
    1,
    60 * 60_000,
    "private reconciliation maximum age",
  );
  result.protection_max_age_ms = boundedInteger(
    result.protection_max_age_ms,
    1,
    60_000,
    "protection maximum age",
  );
  result.future_tolerance_ms = boundedInteger(
    result.future_tolerance_ms,
    0,
    60_000,
    "future timestamp tolerance",
  );
  return result;
}

function checkFreshness(
  timestamp: number | null,
  now: number,
  maximumAge: number,
  futureTolerance: number,
  prefix: string,
  blockers: string[],
): void {
  if (!Number.isSafeInteger(timestamp) || (timestamp as number) <= 0) {
    blockers.push(`${prefix}_time_missing_or_invalid`);
  } else if ((timestamp as number) > now + futureTolerance) {
    blockers.push(`${prefix}_time_in_future`);
  } else if (now - (timestamp as number) > maximumAge) {
    blockers.push(`${prefix}_stale`);
  }
}

function checkFutureOnly(
  timestamp: number | null,
  now: number,
  futureTolerance: number,
  prefix: string,
  blockers: string[],
): void {
  if (timestamp !== null && (
    !Number.isSafeInteger(timestamp) ||
    timestamp <= 0 ||
    timestamp > now + futureTolerance
  )) {
    blockers.push(`${prefix}_time_invalid`);
  }
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function isoUtc(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new Error("owned-protection timestamp must be canonical ISO UTC");
  }
  return value;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
