import {
  objectRecord,
  stringValue,
  validateBinanceUsdmOwnedProtectionClose,
  validateBinanceUsdmProtectionRevision,
  type BinanceUsdmOwnedProtectionCloseRequest,
  type BinanceUsdmProtectionRevisionRequest,
  type ValidatedBinanceUsdmOwnedProtectionClose,
  type ValidatedBinanceUsdmProtectionRevision,
} from "./mutation-contract.js";
import {
  BinanceUsdmMutationClient,
  type BinanceUsdmMutationResult,
} from "./mutation-client.js";
import {
  cleanupComplete,
  cleanupEvidence,
  proveAlgoCancellation,
  proveAlgoOrder,
  proveOrdinaryFill,
  type BinanceUsdmAlgoCleanupEvidence,
  type BinanceUsdmAlgoOrderEvidence,
  type BinanceUsdmOrdinaryOrderEvidence,
} from "./protection-coordinator.js";

export type BinanceUsdmProtectionRevisionState =
  | "current_protection_not_proven"
  | "reduction_rejected"
  | "reduction_visibility_pending"
  | "replacement_stop_pending"
  | "replacement_target_pending"
  | "revision_protected_cleanup_pending"
  | "revision_protected";

export interface BinanceUsdmProtectionRevisionResult {
  schema_version: "glitch.crypto.binance-usdm-protection-revision-result.v1";
  revision_intent_id: string;
  position_intent_id: string;
  state: BinanceUsdmProtectionRevisionState;
  reason: string;
  current: ValidatedBinanceUsdmProtectionRevision["current"];
  next: {
    quantity: string;
    stop_price: string;
    target_price: string;
    ids: ValidatedBinanceUsdmProtectionRevision["ids"];
  };
  current_stop: BinanceUsdmAlgoOrderEvidence | null;
  current_target: BinanceUsdmAlgoOrderEvidence | null;
  reduction: BinanceUsdmOrdinaryOrderEvidence | null;
  replacement_stop: BinanceUsdmAlgoOrderEvidence | null;
  replacement_target: BinanceUsdmAlgoOrderEvidence | null;
  current_target_cleanup: BinanceUsdmAlgoCleanupEvidence | null;
  current_stop_cleanup: BinanceUsdmAlgoCleanupEvidence | null;
}

export type BinanceUsdmOwnedProtectionCloseState =
  | "owned_protection_not_proven"
  | "close_visibility_pending"
  | "closed_cleanup_pending"
  | "closed";

export interface BinanceUsdmOwnedProtectionCloseResult {
  schema_version: "glitch.crypto.binance-usdm-owned-protection-close-result.v1";
  close_intent_id: string;
  position_intent_id: string;
  state: BinanceUsdmOwnedProtectionCloseState;
  reason: string;
  current: ValidatedBinanceUsdmOwnedProtectionClose["current"];
  close_client_order_id: string;
  current_stop: BinanceUsdmAlgoOrderEvidence | null;
  current_target: BinanceUsdmAlgoOrderEvidence | null;
  close: BinanceUsdmOrdinaryOrderEvidence | null;
  current_target_cleanup: BinanceUsdmAlgoCleanupEvidence | null;
  current_stop_cleanup: BinanceUsdmAlgoCleanupEvidence | null;
}

export class BinanceUsdmProtectionRevisionCoordinator {
  constructor(private readonly client: BinanceUsdmMutationClient) {}

  async revise(
    request: BinanceUsdmProtectionRevisionRequest,
  ): Promise<BinanceUsdmProtectionRevisionResult> {
    const plan = validateBinanceUsdmProtectionRevision(request);
    const currentStop = await this.lookupProtection(
      plan,
      "STOP_MARKET",
      plan.current.stopClientAlgoId,
      plan.current.quantity,
      plan.current.stopPrice,
    );
    const currentTarget = await this.lookupProtection(
      plan,
      "TAKE_PROFIT_MARKET",
      plan.current.targetClientAlgoId,
      plan.current.quantity,
      plan.current.targetPrice,
    );
    if (currentStop === null || currentTarget === null) {
      return revisionResult(
        plan,
        "current_protection_not_proven",
        "exact_current_stop_and_target_required_before_revision",
        currentStop,
        currentTarget,
      );
    }

    let reduction: BinanceUsdmOrdinaryOrderEvidence | null = null;
    if (plan.reductionQuantity !== null) {
      const submission = await this.client.placeReduceOnlyMarket({
        symbol: plan.current.symbol,
        side: plan.exitSide,
        quantity: plan.reductionQuantity,
        clientOrderId: plan.ids.reductionClientOrderId,
      });
      if (submission.disposition === "rejected") {
        return revisionResult(
          plan,
          "reduction_rejected",
          "reduce_only_partial_rejected_current_protection_retained",
          currentStop,
          currentTarget,
        );
      }
      reduction = await this.resolveReduction(plan, submission);
      if (reduction === null) {
        return revisionResult(
          plan,
          "reduction_visibility_pending",
          "reduce_only_partial_requires_position_reconciliation",
          currentStop,
          currentTarget,
        );
      }
    }

    const replacementStopSubmission = await this.client.placeReduceOnlyAlgo({
      symbol: plan.current.symbol,
      side: plan.exitSide,
      quantity: plan.remainingQuantity,
      triggerPrice: plan.nextStopPrice,
      type: "STOP_MARKET",
      clientAlgoId: plan.ids.stopClientAlgoId,
    });
    const replacementStop = replacementStopSubmission.disposition === "rejected"
      ? null
      : await this.lookupProtection(
          plan,
          "STOP_MARKET",
          plan.ids.stopClientAlgoId,
          plan.remainingQuantity,
          plan.nextStopPrice,
        );
    if (replacementStop === null) {
      return revisionResult(
        plan,
        "replacement_stop_pending",
        "replacement_stop_not_proven_current_protection_retained",
        currentStop,
        currentTarget,
        reduction,
      );
    }

    const replacementTargetSubmission = await this.client.placeReduceOnlyAlgo({
      symbol: plan.current.symbol,
      side: plan.exitSide,
      quantity: plan.remainingQuantity,
      triggerPrice: plan.nextTargetPrice,
      type: "TAKE_PROFIT_MARKET",
      clientAlgoId: plan.ids.targetClientAlgoId,
    });
    const replacementTarget = replacementTargetSubmission.disposition === "rejected"
      ? null
      : await this.lookupProtection(
          plan,
          "TAKE_PROFIT_MARKET",
          plan.ids.targetClientAlgoId,
          plan.remainingQuantity,
          plan.nextTargetPrice,
        );
    if (replacementTarget === null) {
      return revisionResult(
        plan,
        "replacement_target_pending",
        "replacement_stop_proven_target_pending_current_protection_retained",
        currentStop,
        currentTarget,
        reduction,
        replacementStop,
      );
    }

    const currentTargetCleanup = await this.cancelOwnedAlgo(
      plan.current.targetClientAlgoId,
    );
    const currentStopCleanup = await this.cancelOwnedAlgo(
      plan.current.stopClientAlgoId,
    );
    const complete = cleanupComplete(currentTargetCleanup) &&
      cleanupComplete(currentStopCleanup);
    return revisionResult(
      plan,
      complete ? "revision_protected" : "revision_protected_cleanup_pending",
      complete
        ? "replacement_pair_and_current_cleanup_proven"
        : "replacement_pair_proven_current_cleanup_pending",
      currentStop,
      currentTarget,
      reduction,
      replacementStop,
      replacementTarget,
      currentTargetCleanup,
      currentStopCleanup,
    );
  }

  async reconcile(
    request: BinanceUsdmProtectionRevisionRequest,
  ): Promise<BinanceUsdmProtectionRevisionResult> {
    const plan = validateBinanceUsdmProtectionRevision(request);
    let reduction: BinanceUsdmOrdinaryOrderEvidence | null = null;
    if (plan.reductionQuantity !== null) {
      reduction = await this.lookupReduction(plan);
      if (reduction === null) {
        return revisionResult(
          plan,
          "reduction_visibility_pending",
          "restart_reduce_only_partial_not_proven",
        );
      }
    }

    const replacementStop = await this.lookupProtection(
      plan,
      "STOP_MARKET",
      plan.ids.stopClientAlgoId,
      plan.remainingQuantity,
      plan.nextStopPrice,
    );
    if (replacementStop === null) {
      return revisionResult(
        plan,
        "replacement_stop_pending",
        "restart_replacement_stop_not_proven",
        null,
        null,
        reduction,
      );
    }
    const replacementTarget = await this.lookupProtection(
      plan,
      "TAKE_PROFIT_MARKET",
      plan.ids.targetClientAlgoId,
      plan.remainingQuantity,
      plan.nextTargetPrice,
    );
    if (replacementTarget === null) {
      return revisionResult(
        plan,
        "replacement_target_pending",
        "restart_replacement_stop_proven_target_not_proven",
        null,
        null,
        reduction,
        replacementStop,
      );
    }

    const currentTargetCleanup = await this.inspectAlgoCleanup(
      plan.current.targetClientAlgoId,
    );
    const currentStopCleanup = await this.inspectAlgoCleanup(
      plan.current.stopClientAlgoId,
    );
    const complete = cleanupComplete(currentTargetCleanup) &&
      cleanupComplete(currentStopCleanup);
    return revisionResult(
      plan,
      complete ? "revision_protected" : "revision_protected_cleanup_pending",
      complete
        ? "restart_replacement_pair_and_current_cleanup_proven"
        : "restart_replacement_pair_proven_current_cleanup_pending",
      null,
      null,
      reduction,
      replacementStop,
      replacementTarget,
      currentTargetCleanup,
      currentStopCleanup,
    );
  }

  async closeOwnedProtection(
    request: BinanceUsdmOwnedProtectionCloseRequest,
  ): Promise<BinanceUsdmOwnedProtectionCloseResult> {
    const plan = validateBinanceUsdmOwnedProtectionClose(request);
    const currentStop = await this.lookupOwnedProtection(
      plan,
      "STOP_MARKET",
      plan.current.stopClientAlgoId,
      plan.current.stopPrice,
    );
    const currentTarget = await this.lookupOwnedProtection(
      plan,
      "TAKE_PROFIT_MARKET",
      plan.current.targetClientAlgoId,
      plan.current.targetPrice,
    );
    if (currentStop === null || currentTarget === null) {
      return ownedCloseResult(
        plan,
        "owned_protection_not_proven",
        "exact_current_stop_and_target_required_before_close",
        currentStop,
        currentTarget,
      );
    }

    const submission = await this.client.placeReduceOnlyMarket({
      symbol: plan.current.symbol,
      side: plan.exitSide,
      quantity: plan.current.quantity,
      clientOrderId: plan.closeClientOrderId,
    });
    if (submission.disposition === "rejected") {
      return ownedCloseResult(
        plan,
        "close_visibility_pending",
        "reduce_only_close_rejected_requires_position_reconciliation",
        currentStop,
        currentTarget,
      );
    }
    const close = await this.resolveOwnedClose(plan, submission);
    if (close === null) {
      return ownedCloseResult(
        plan,
        "close_visibility_pending",
        "reduce_only_close_requires_position_reconciliation",
        currentStop,
        currentTarget,
      );
    }

    const currentTargetCleanup = await this.cancelOwnedAlgo(
      plan.current.targetClientAlgoId,
    );
    const currentStopCleanup = await this.cancelOwnedAlgo(
      plan.current.stopClientAlgoId,
    );
    const complete = cleanupComplete(currentTargetCleanup) &&
      cleanupComplete(currentStopCleanup);
    return ownedCloseResult(
      plan,
      complete ? "closed" : "closed_cleanup_pending",
      complete
        ? "reduce_only_close_and_current_cleanup_proven"
        : "reduce_only_close_proven_current_cleanup_pending",
      currentStop,
      currentTarget,
      close,
      currentTargetCleanup,
      currentStopCleanup,
    );
  }

  async reconcileOwnedProtectionClose(
    request: BinanceUsdmOwnedProtectionCloseRequest,
  ): Promise<BinanceUsdmOwnedProtectionCloseResult> {
    const plan = validateBinanceUsdmOwnedProtectionClose(request);
    const close = await this.lookupOwnedClose(plan);
    if (close === null) {
      return ownedCloseResult(
        plan,
        "close_visibility_pending",
        "restart_reduce_only_close_not_proven",
      );
    }
    const currentTargetCleanup = await this.inspectAlgoCleanup(
      plan.current.targetClientAlgoId,
    );
    const currentStopCleanup = await this.inspectAlgoCleanup(
      plan.current.stopClientAlgoId,
    );
    const complete = cleanupComplete(currentTargetCleanup) &&
      cleanupComplete(currentStopCleanup);
    return ownedCloseResult(
      plan,
      complete ? "closed" : "closed_cleanup_pending",
      complete
        ? "restart_close_and_current_cleanup_proven"
        : "restart_close_proven_current_cleanup_pending",
      null,
      null,
      close,
      currentTargetCleanup,
      currentStopCleanup,
    );
  }

  private async resolveReduction(
    plan: ValidatedBinanceUsdmProtectionRevision,
    submission: BinanceUsdmMutationResult,
  ): Promise<BinanceUsdmOrdinaryOrderEvidence | null> {
    const direct = proveOrdinaryFill(
      submission.payload,
      plan.current.symbol,
      plan.exitSide,
      plan.ids.reductionClientOrderId,
      true,
      plan.reductionQuantity,
    );
    if (direct?.status === "FILLED") {
      return direct;
    }
    return this.lookupReduction(plan);
  }

  private async resolveOwnedClose(
    plan: ValidatedBinanceUsdmOwnedProtectionClose,
    submission: BinanceUsdmMutationResult,
  ): Promise<BinanceUsdmOrdinaryOrderEvidence | null> {
    const direct = proveOrdinaryFill(
      submission.payload,
      plan.current.symbol,
      plan.exitSide,
      plan.closeClientOrderId,
      true,
      plan.current.quantity,
    );
    if (direct?.status === "FILLED") {
      return direct;
    }
    return this.lookupOwnedClose(plan);
  }

  private async lookupOwnedClose(
    plan: ValidatedBinanceUsdmOwnedProtectionClose,
  ): Promise<BinanceUsdmOrdinaryOrderEvidence | null> {
    const lookup = await this.client.queryOrder(
      plan.current.symbol,
      plan.closeClientOrderId,
    );
    if (lookup.disposition !== "found") {
      return null;
    }
    const evidence = proveOrdinaryFill(
      lookup.payload,
      plan.current.symbol,
      plan.exitSide,
      plan.closeClientOrderId,
      true,
      plan.current.quantity,
    );
    return evidence?.status === "FILLED" ? evidence : null;
  }

  private async lookupReduction(
    plan: ValidatedBinanceUsdmProtectionRevision,
  ): Promise<BinanceUsdmOrdinaryOrderEvidence | null> {
    if (plan.reductionQuantity === null) {
      return null;
    }
    const lookup = await this.client.queryOrder(
      plan.current.symbol,
      plan.ids.reductionClientOrderId,
    );
    if (lookup.disposition !== "found") {
      return null;
    }
    const evidence = proveOrdinaryFill(
      lookup.payload,
      plan.current.symbol,
      plan.exitSide,
      plan.ids.reductionClientOrderId,
      true,
      plan.reductionQuantity,
    );
    return evidence?.status === "FILLED" ? evidence : null;
  }

  private async lookupProtection(
    plan: ValidatedBinanceUsdmProtectionRevision,
    type: "STOP_MARKET" | "TAKE_PROFIT_MARKET",
    clientAlgoId: string,
    quantity: string,
    triggerPrice: string,
  ): Promise<BinanceUsdmAlgoOrderEvidence | null> {
    const lookup = await this.client.queryAlgoOrder(clientAlgoId);
    return lookup.disposition === "found"
      ? proveAlgoOrder(
          lookup,
          plan.current.symbol,
          plan.exitSide,
          type,
          clientAlgoId,
          quantity,
          triggerPrice,
        )
      : null;
  }

  private async lookupOwnedProtection(
    plan: ValidatedBinanceUsdmOwnedProtectionClose,
    type: "STOP_MARKET" | "TAKE_PROFIT_MARKET",
    clientAlgoId: string,
    triggerPrice: string,
  ): Promise<BinanceUsdmAlgoOrderEvidence | null> {
    const lookup = await this.client.queryAlgoOrder(clientAlgoId);
    return lookup.disposition === "found"
      ? proveAlgoOrder(
          lookup,
          plan.current.symbol,
          plan.exitSide,
          type,
          clientAlgoId,
          plan.current.quantity,
          triggerPrice,
        )
      : null;
  }

  private async cancelOwnedAlgo(
    clientAlgoId: string,
  ): Promise<BinanceUsdmAlgoCleanupEvidence> {
    const cancellation = await this.client.cancelAlgoOrder(clientAlgoId);
    if (proveAlgoCancellation(cancellation.payload, clientAlgoId)) {
      return cleanupEvidence(clientAlgoId, "canceled", "CANCELED");
    }
    const inspected = await this.inspectAlgoCleanup(clientAlgoId);
    return inspected.disposition === "absent"
      ? cleanupEvidence(clientAlgoId, "pending", null)
      : inspected;
  }

  private async inspectAlgoCleanup(
    clientAlgoId: string,
  ): Promise<BinanceUsdmAlgoCleanupEvidence> {
    const lookup = await this.client.queryAlgoOrder(clientAlgoId);
    if (lookup.disposition === "not_found") {
      return cleanupEvidence(clientAlgoId, "absent", null);
    }
    if (lookup.disposition === "unavailable") {
      return cleanupEvidence(clientAlgoId, "unavailable", null);
    }
    const record = objectRecord(lookup.payload);
    if (record?.clientAlgoId !== clientAlgoId) {
      return cleanupEvidence(clientAlgoId, "pending", null);
    }
    const status = stringValue(record.algoStatus);
    if (status === "CANCELED") {
      return cleanupEvidence(clientAlgoId, "canceled", status);
    }
    if (status === "NEW" || status === "WORKING") {
      return cleanupEvidence(clientAlgoId, "active", status);
    }
    return cleanupEvidence(clientAlgoId, "pending", status);
  }
}

function revisionResult(
  plan: ValidatedBinanceUsdmProtectionRevision,
  state: BinanceUsdmProtectionRevisionState,
  reason: string,
  currentStop: BinanceUsdmAlgoOrderEvidence | null = null,
  currentTarget: BinanceUsdmAlgoOrderEvidence | null = null,
  reduction: BinanceUsdmOrdinaryOrderEvidence | null = null,
  replacementStop: BinanceUsdmAlgoOrderEvidence | null = null,
  replacementTarget: BinanceUsdmAlgoOrderEvidence | null = null,
  currentTargetCleanup: BinanceUsdmAlgoCleanupEvidence | null = null,
  currentStopCleanup: BinanceUsdmAlgoCleanupEvidence | null = null,
): BinanceUsdmProtectionRevisionResult {
  return {
    schema_version: "glitch.crypto.binance-usdm-protection-revision-result.v1",
    revision_intent_id: plan.revisionIntentId,
    position_intent_id: plan.current.positionIntentId,
    state,
    reason,
    current: plan.current,
    next: {
      quantity: plan.remainingQuantity,
      stop_price: plan.nextStopPrice,
      target_price: plan.nextTargetPrice,
      ids: plan.ids,
    },
    current_stop: currentStop,
    current_target: currentTarget,
    reduction,
    replacement_stop: replacementStop,
    replacement_target: replacementTarget,
    current_target_cleanup: currentTargetCleanup,
    current_stop_cleanup: currentStopCleanup,
  };
}

function ownedCloseResult(
  plan: ValidatedBinanceUsdmOwnedProtectionClose,
  state: BinanceUsdmOwnedProtectionCloseState,
  reason: string,
  currentStop: BinanceUsdmAlgoOrderEvidence | null = null,
  currentTarget: BinanceUsdmAlgoOrderEvidence | null = null,
  close: BinanceUsdmOrdinaryOrderEvidence | null = null,
  currentTargetCleanup: BinanceUsdmAlgoCleanupEvidence | null = null,
  currentStopCleanup: BinanceUsdmAlgoCleanupEvidence | null = null,
): BinanceUsdmOwnedProtectionCloseResult {
  return {
    schema_version: "glitch.crypto.binance-usdm-owned-protection-close-result.v1",
    close_intent_id: plan.closeIntentId,
    position_intent_id: plan.current.positionIntentId,
    state,
    reason,
    current: plan.current,
    close_client_order_id: plan.closeClientOrderId,
    current_stop: currentStop,
    current_target: currentTarget,
    close,
    current_target_cleanup: currentTargetCleanup,
    current_stop_cleanup: currentStopCleanup,
  };
}
