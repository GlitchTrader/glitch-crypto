import {
  decimalEquals,
  objectRecord,
  positiveDecimal,
  stringValue,
  validateBinanceUsdmProtectedEntry,
  type BinanceUsdmAlgoOrderType,
  type BinanceUsdmProtectedEntryRequest,
  type ValidatedBinanceUsdmProtectedEntry,
} from "./mutation-contract.js";
import {
  BinanceUsdmMutationClient,
  type BinanceUsdmLookupResult,
  type BinanceUsdmMutationResult,
} from "./mutation-client.js";

export type BinanceUsdmProtectedEntryState =
  | "rejected_before_exposure"
  | "entry_visibility_pending"
  | "emergency_flatten_pending"
  | "emergency_flatten_confirmed"
  | "open_protected_target_pending"
  | "open_protected";

export interface BinanceUsdmOrdinaryOrderEvidence {
  client_order_id: string;
  order_id: string;
  symbol: string;
  side: string;
  status: string;
  executed_quantity: string;
  average_price: string;
  reduce_only: boolean;
}

export interface BinanceUsdmAlgoOrderEvidence {
  client_algo_id: string;
  algo_id: string;
  symbol: string;
  side: string;
  order_type: BinanceUsdmAlgoOrderType;
  status: string;
  quantity: string;
  trigger_price: string;
  reduce_only: true;
}

export interface BinanceUsdmProtectedEntryResult {
  schema_version: "glitch.crypto.binance-usdm-protected-entry-result.v1";
  intent_id: string;
  state: BinanceUsdmProtectedEntryState;
  reason: string;
  ids: ValidatedBinanceUsdmProtectedEntry["ids"];
  entry: BinanceUsdmOrdinaryOrderEvidence | null;
  stop: BinanceUsdmAlgoOrderEvidence | null;
  target: BinanceUsdmAlgoOrderEvidence | null;
  emergency_close: BinanceUsdmOrdinaryOrderEvidence | null;
}

export class BinanceUsdmProtectionCoordinator {
  constructor(private readonly client: BinanceUsdmMutationClient) {}

  async createProtectedEntry(
    request: BinanceUsdmProtectedEntryRequest,
  ): Promise<BinanceUsdmProtectedEntryResult> {
    const plan = validateBinanceUsdmProtectedEntry(request);
    const entrySubmission = await this.client.placeMarketEntry({
      symbol: plan.symbol,
      side: plan.entrySide,
      quantity: plan.quantity,
      clientOrderId: plan.ids.entryClientOrderId,
    });
    if (entrySubmission.disposition === "rejected") {
      return result(plan, "rejected_before_exposure", "entry_rejected", null, null, null, null);
    }

    const entry = await this.resolveOrdinaryFill(
      entrySubmission,
      plan.symbol,
      plan.entrySide,
      plan.ids.entryClientOrderId,
      false,
      null,
    );
    if (entry === null) {
      return result(plan, "entry_visibility_pending", "entry_outcome_requires_reconciliation", null, null, null, null);
    }
    if (entry.status !== "FILLED") {
      return this.emergencyFlatten(
        plan,
        entry,
        null,
        "partial_entry_requires_emergency_flatten",
      );
    }

    const stopSubmission = await this.client.placeReduceOnlyAlgo({
      symbol: plan.symbol,
      side: plan.exitSide,
      quantity: entry.executed_quantity,
      triggerPrice: plan.stopPrice,
      type: "STOP_MARKET",
      clientAlgoId: plan.ids.stopClientAlgoId,
    });
    const stop = stopSubmission.disposition === "rejected"
      ? null
      : await this.resolveAlgo(
          plan,
          stopSubmission,
          "STOP_MARKET",
          plan.ids.stopClientAlgoId,
          entry.executed_quantity,
          plan.stopPrice,
        );
    if (stop === null) {
      return this.emergencyFlatten(
        plan,
        entry,
        null,
        stopSubmission.disposition === "rejected"
          ? "native_stop_rejected"
          : "native_stop_not_proven",
      );
    }

    const targetSubmission = await this.client.placeReduceOnlyAlgo({
      symbol: plan.symbol,
      side: plan.exitSide,
      quantity: entry.executed_quantity,
      triggerPrice: plan.targetPrice,
      type: "TAKE_PROFIT_MARKET",
      clientAlgoId: plan.ids.targetClientAlgoId,
    });
    const target = targetSubmission.disposition === "rejected"
      ? null
      : await this.resolveAlgo(
          plan,
          targetSubmission,
          "TAKE_PROFIT_MARKET",
          plan.ids.targetClientAlgoId,
          entry.executed_quantity,
          plan.targetPrice,
        );
    if (target === null) {
      return result(
        plan,
        "open_protected_target_pending",
        "native_stop_proven_target_requires_reconciliation",
        entry,
        stop,
        null,
        null,
      );
    }

    return result(
      plan,
      "open_protected",
      "native_stop_and_target_proven",
      entry,
      stop,
      target,
      null,
    );
  }

  async reconcileProtectedEntry(
    request: BinanceUsdmProtectedEntryRequest,
  ): Promise<BinanceUsdmProtectedEntryResult> {
    const plan = validateBinanceUsdmProtectedEntry(request);
    const entry = await this.lookupOrdinaryFill(
      plan.symbol,
      plan.entrySide,
      plan.ids.entryClientOrderId,
      false,
      null,
    );
    if (entry === null) {
      return result(plan, "entry_visibility_pending", "restart_entry_not_proven", null, null, null, null);
    }

    if (entry.status !== "FILLED") {
      const close = await this.lookupOrdinaryFill(
        plan.symbol,
        plan.exitSide,
        plan.ids.emergencyCloseClientOrderId,
        true,
        entry.executed_quantity,
      );
      return close === null
        ? result(
            plan,
            "emergency_flatten_pending",
            "restart_partial_entry_requires_emergency_flatten",
            entry,
            null,
            null,
            null,
          )
        : result(
            plan,
            "emergency_flatten_confirmed",
            "restart_partial_entry_close_proven",
            entry,
            null,
            null,
            close,
          );
    }

    const stop = await this.lookupAlgo(
      plan,
      "STOP_MARKET",
      plan.ids.stopClientAlgoId,
      entry.executed_quantity,
      plan.stopPrice,
    );
    if (stop === null) {
      const close = await this.lookupOrdinaryFill(
        plan.symbol,
        plan.exitSide,
        plan.ids.emergencyCloseClientOrderId,
        true,
        entry.executed_quantity,
      );
      return close === null
        ? result(
            plan,
            "emergency_flatten_pending",
            "restart_native_stop_absent_emergency_flatten_required",
            entry,
            null,
            null,
            null,
          )
        : result(
            plan,
            "emergency_flatten_confirmed",
            "restart_native_stop_absent_close_proven",
            entry,
            null,
            null,
            close,
          );
    }

    const target = await this.lookupAlgo(
      plan,
      "TAKE_PROFIT_MARKET",
      plan.ids.targetClientAlgoId,
      entry.executed_quantity,
      plan.targetPrice,
    );
    return target === null
      ? result(
          plan,
          "open_protected_target_pending",
          "restart_native_stop_proven_target_not_proven",
          entry,
          stop,
          null,
          null,
        )
      : result(
          plan,
          "open_protected",
          "restart_native_stop_and_target_proven",
          entry,
          stop,
          target,
          null,
        );
  }

  private async resolveOrdinaryFill(
    submission: BinanceUsdmMutationResult,
    symbol: string,
    side: string,
    clientOrderId: string,
    reduceOnly: boolean,
    expectedQuantity: string | null,
  ): Promise<BinanceUsdmOrdinaryOrderEvidence | null> {
    const direct = proveOrdinaryFill(
      submission.payload,
      symbol,
      side,
      clientOrderId,
      reduceOnly,
      expectedQuantity,
    );
    if (direct !== null) {
      return direct;
    }
    const lookup = await this.client.queryOrder(symbol, clientOrderId);
    return lookup.disposition === "found"
      ? proveOrdinaryFill(
          lookup.payload,
          symbol,
          side,
          clientOrderId,
          reduceOnly,
          expectedQuantity,
        )
      : null;
  }

  private async resolveAlgo(
    plan: ValidatedBinanceUsdmProtectedEntry,
    _submission: BinanceUsdmMutationResult,
    type: BinanceUsdmAlgoOrderType,
    clientAlgoId: string,
    quantity: string,
    triggerPrice: string,
  ): Promise<BinanceUsdmAlgoOrderEvidence | null> {
    return this.lookupAlgo(plan, type, clientAlgoId, quantity, triggerPrice);
  }

  private async lookupOrdinaryFill(
    symbol: string,
    side: string,
    clientOrderId: string,
    reduceOnly: boolean,
    expectedQuantity: string | null,
  ): Promise<BinanceUsdmOrdinaryOrderEvidence | null> {
    const lookup = await this.client.queryOrder(symbol, clientOrderId);
    return lookup.disposition === "found"
      ? proveOrdinaryFill(
          lookup.payload,
          symbol,
          side,
          clientOrderId,
          reduceOnly,
          expectedQuantity,
        )
      : null;
  }

  private async lookupAlgo(
    plan: ValidatedBinanceUsdmProtectedEntry,
    type: BinanceUsdmAlgoOrderType,
    clientAlgoId: string,
    quantity: string,
    triggerPrice: string,
  ): Promise<BinanceUsdmAlgoOrderEvidence | null> {
    const lookup = await this.client.queryAlgoOrder(clientAlgoId);
    return lookup.disposition === "found"
      ? proveAlgoOrder(
          lookup,
          plan.symbol,
          plan.exitSide,
          type,
          clientAlgoId,
          quantity,
          triggerPrice,
        )
      : null;
  }

  private async emergencyFlatten(
    plan: ValidatedBinanceUsdmProtectedEntry,
    entry: BinanceUsdmOrdinaryOrderEvidence,
    stop: BinanceUsdmAlgoOrderEvidence | null,
    reason: string,
  ): Promise<BinanceUsdmProtectedEntryResult> {
    const submission = await this.client.placeEmergencyClose({
      symbol: plan.symbol,
      side: plan.exitSide,
      quantity: entry.executed_quantity,
      clientOrderId: plan.ids.emergencyCloseClientOrderId,
    });
    const close = submission.disposition === "rejected"
      ? null
      : await this.resolveOrdinaryFill(
          submission,
          plan.symbol,
          plan.exitSide,
          plan.ids.emergencyCloseClientOrderId,
          true,
          entry.executed_quantity,
        );
    return close === null
      ? result(
          plan,
          "emergency_flatten_pending",
          reason + "_close_requires_reconciliation",
          entry,
          stop,
          null,
          null,
        )
      : result(
          plan,
          "emergency_flatten_confirmed",
          reason + "_close_proven",
          entry,
          stop,
          null,
          close,
        );
  }
}

function proveOrdinaryFill(
  payload: unknown,
  symbol: string,
  side: string,
  clientOrderId: string,
  reduceOnly: boolean,
  expectedQuantity: string | null,
): BinanceUsdmOrdinaryOrderEvidence | null {
  const record = objectRecord(payload);
  if (record === null
      || record.clientOrderId !== clientOrderId
      || record.symbol !== symbol
      || record.side !== side
      || (record.status !== "FILLED" && record.status !== "PARTIALLY_FILLED")
      || booleanValue(record.reduceOnly) !== reduceOnly) {
    return null;
  }
  const executedQuantity = positiveDecimal(record.executedQty);
  const averagePrice = positiveDecimal(record.avgPrice);
  const orderId = stringValue(record.orderId);
  if (executedQuantity === null || averagePrice === null || orderId === null) {
    return null;
  }
  if (expectedQuantity !== null && !decimalEquals(executedQuantity, expectedQuantity)) {
    return null;
  }
  return {
    client_order_id: clientOrderId,
    order_id: orderId,
    symbol,
    side,
    status: record.status,
    executed_quantity: executedQuantity,
    average_price: averagePrice,
    reduce_only: reduceOnly,
  };
}

function proveAlgoOrder(
  lookup: BinanceUsdmLookupResult,
  symbol: string,
  side: string,
  type: BinanceUsdmAlgoOrderType,
  clientAlgoId: string,
  quantity: string,
  triggerPrice: string,
): BinanceUsdmAlgoOrderEvidence | null {
  const record = objectRecord(lookup.payload);
  const status = record?.algoStatus;
  const active = status === "NEW" || status === "WORKING";
  const algoId = stringValue(record?.algoId);
  if (record === null
      || !active
      || algoId === null
      || record.clientAlgoId !== clientAlgoId
      || record.symbol !== symbol
      || record.side !== side
      || record.orderType !== type
      || !decimalEquals(record.quantity, quantity)
      || !decimalEquals(record.triggerPrice, triggerPrice)
      || booleanValue(record.reduceOnly) !== true) {
    return null;
  }
  return {
    client_algo_id: clientAlgoId,
    algo_id: algoId,
    symbol,
    side,
    order_type: type,
    status,
    quantity,
    trigger_price: triggerPrice,
    reduce_only: true,
  };
}

function booleanValue(value: unknown): boolean | null {
  if (value === true || value === "true") {
    return true;
  }
  if (value === false || value === "false") {
    return false;
  }
  return null;
}

function result(
  plan: ValidatedBinanceUsdmProtectedEntry,
  state: BinanceUsdmProtectedEntryState,
  reason: string,
  entry: BinanceUsdmOrdinaryOrderEvidence | null,
  stop: BinanceUsdmAlgoOrderEvidence | null,
  target: BinanceUsdmAlgoOrderEvidence | null,
  emergencyClose: BinanceUsdmOrdinaryOrderEvidence | null,
): BinanceUsdmProtectedEntryResult {
  return {
    schema_version: "glitch.crypto.binance-usdm-protected-entry-result.v1",
    intent_id: plan.intentId,
    state,
    reason,
    ids: plan.ids,
    entry,
    stop,
    target,
    emergency_close: emergencyClose,
  };
}
