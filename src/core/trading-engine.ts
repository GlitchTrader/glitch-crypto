import { randomUUID } from "node:crypto";
import { bodyHash, canonicalJson } from "../domain/canonical-json.js";
import { parseIntent } from "../domain/intents.js";
import {
  applyBps,
  bpsToPct,
  centsToPrice,
  centsToUsd,
  notionalCents,
  pctToBps,
  pnlCents,
  priceToCents,
  quantityToString,
  roundDownToStep,
} from "../domain/money.js";
import { mergePublicPolicy, toPublicPolicy } from "../domain/policy.js";
import type {
  EntryIntent,
  IntentReceipt,
  PositionRecord,
  PositionSide,
  RiskPolicy,
  TradeRecord,
  TradingIntent,
} from "../domain/types.js";
import { GlitchDatabase, nowUtc } from "../storage/database.js";
import type { VenueAdapter } from "../venue/venue.js";
import { RiskEngine, validateStopSide } from "./risk-engine.js";

export class TradingEngine {
  readonly risk: RiskEngine;

  constructor(
    readonly database: GlitchDatabase,
    readonly venue: VenueAdapter,
  ) {
    this.risk = new RiskEngine(database);
    this.risk.snapshot();
  }

  getHealth(): Record<string, unknown> {
    const control = this.database.getControl();
    const account = this.database.getAccount();
    const risk = this.risk.snapshot();
    return {
      schema_version: "glitch.crypto.health.v1",
      status: "ok",
      venue: this.venue.name,
      gateway_mode: control.gatewayMode,
      running: control.running,
      account_alias: account.alias,
      database: "available",
      protection_contract: "native-equivalent-paper-confirmed",
      risk_status: risk.newExposureAllowed ? "ready" : "restricted",
      recorded_utc: nowUtc(),
    };
  }

  getState(): Record<string, unknown> {
    const account = this.database.getAccount();
    const positions = this.database.getPositions();
    const risk = this.risk.snapshot();
    const control = this.database.getControl();
    return {
      schema_version: "glitch.crypto.state.v1",
      venue: this.venue.name,
      control: {
        running: control.running,
        gateway_mode: control.gatewayMode,
      },
      account: {
        alias: account.alias,
        balance_usd: centsToUsd(account.balanceCents),
        equity_usd: centsToUsd(risk.equityCents),
        usable_pot_usd: centsToUsd(risk.usablePotCents),
      },
      market: {
        instrument: "BTCUSDT-PERP",
        mark_price: centsToPrice(account.markPriceCents),
        observed_utc: account.updatedUtc,
      },
      positions: positions.map((position) => publicPosition(position, account.markPriceCents)),
      risk: publicRisk(risk),
      recorded_utc: nowUtc(),
    };
  }

  getPacket(): Record<string, unknown> {
    const state = this.getState();
    const policy = toPublicPolicy(this.database.getPolicy());
    const positions = this.database.getPositions();
    const control = this.database.getControl();
    const risk = this.risk.snapshot();
    const supportedActions = positions.length === 0
      ? ["ENTER_LONG", "ENTER_SHORT", "NOTHING"]
      : ["HOLD", "MOVE_STOP", "MOVE_TARGET", "REDUCE", "EXIT"];
    const packetCore = {
      schema_version: "glitch.crypto.packet.v1",
      generated_utc: nowUtc(),
      state,
      policy,
      execution: {
        venue: this.venue.name,
        supported_actions: supportedActions,
        new_exposure_technically_supported:
          control.running && control.gatewayMode !== "disabled" && risk.newExposureAllowed,
        entry_quantity_owner: "glitch-risk-engine",
        native_protection_required: true,
        ambiguous_transport_is_nonterminal: true,
      },
      recent_trades: this.publicTrades(10),
    };
    return {
      ...packetCore,
      packet_id: bodyHash(packetCore),
    };
  }

  getPolicy() {
    return toPublicPolicy(this.database.getPolicy());
  }

  updatePolicy(patch: Record<string, unknown>) {
    const next = mergePublicPolicy(this.database.getPolicy(), patch);
    this.database.setPolicy(next);
    this.risk.snapshot();
    return toPublicPolicy(next);
  }

  start(): Record<string, unknown> {
    const control = this.database.getControl();
    if (control.gatewayMode === "disabled") {
      throw new Error("gateway mode is disabled");
    }
    this.database.setRunning(true);
    return this.getState();
  }

  stop(): Record<string, unknown> {
    this.database.setRunning(false);
    return this.getState();
  }

  flattenAll(reason = "operator_flatten"): Record<string, unknown> {
    this.database.setRunning(false);
    const positions = this.database.getPositions();
    const mark = this.database.getAccount().markPriceCents;
    const controlIntentId = randomUUID();
    for (const position of positions) {
      this.closeQuantity(position, position.quantityUnits, mark, reason, controlIntentId);
    }
    this.database.appendJournal(
      "flatten_all_completed",
      "warning",
      "All paper exposure was flattened and the runtime was stopped.",
      { reason, closed_positions: positions.length },
    );
    return this.getState();
  }

  updatePaperMark(markPrice: number): Record<string, unknown> {
    const markPriceCents = priceToCents(markPrice);
    this.database.setMarkPrice(markPriceCents);
    const positions = this.database.getPositions();
    for (const position of positions) {
      if (position.side === "LONG" && markPriceCents <= position.stopPriceCents) {
        this.closeQuantity(
          position,
          position.quantityUnits,
          markPriceCents,
          "native_stop",
          randomUUID(),
        );
      } else if (position.side === "SHORT" && markPriceCents >= position.stopPriceCents) {
        this.closeQuantity(
          position,
          position.quantityUnits,
          markPriceCents,
          "native_stop",
          randomUUID(),
        );
      } else if (position.side === "LONG" && markPriceCents >= position.targetPriceCents) {
        this.closeQuantity(
          position,
          position.quantityUnits,
          position.targetPriceCents,
          "native_target",
          randomUUID(),
        );
      } else if (position.side === "SHORT" && markPriceCents <= position.targetPriceCents) {
        this.closeQuantity(
          position,
          position.quantityUnits,
          position.targetPriceCents,
          "native_target",
          randomUUID(),
        );
      }
    }

    const risk = this.risk.snapshot();
    if (
      this.database.getPositions().length > 0 &&
      (risk.protectedEquityCents <= risk.dailyLossBoundaryCents ||
        (risk.activeFloorCents !== null && risk.protectedEquityCents < risk.activeFloorCents))
    ) {
      this.flattenAll(
        risk.protectedEquityCents <= risk.dailyLossBoundaryCents
          ? "hard_daily_loss_boundary"
          : "daily_lock_floor_breach",
      );
    }
    return this.getState();
  }

  submitIntent(input: unknown): IntentReceipt {
    let intent: TradingIntent;
    try {
      intent = parseIntent(input);
    } catch (error) {
      return rejectionReceipt(input, errorMessage(error));
    }

    const hash = bodyHash(intent);
    const existing = this.database.getIntent(intent.intent_id);
    if (existing) {
      if (existing.bodyHash !== hash) {
        return {
          schema_version: "glitch.crypto.intent-receipt.v1",
          intent_id: intent.intent_id,
          body_hash: hash,
          state: "conflict",
          accepted: false,
          replayed: false,
          reason: "intent_body_conflict",
          recorded_utc: nowUtc(),
        };
      }
      if (existing.response) {
        return { ...existing.response, replayed: true };
      }
      return {
        schema_version: "glitch.crypto.intent-receipt.v1",
        intent_id: intent.intent_id,
        body_hash: hash,
        state: "rejected",
        accepted: false,
        replayed: true,
        reason: "intent_is_nonterminal_and_requires_reconciliation",
        recorded_utc: nowUtc(),
      };
    }

    if (!this.database.claimIntent(intent.intent_id, hash, canonicalJson(intent))) {
      return this.submitIntent(intent);
    }

    let receipt: IntentReceipt;
    try {
      receipt = this.executeIntent(intent, hash);
    } catch (error) {
      receipt = {
        schema_version: "glitch.crypto.intent-receipt.v1",
        intent_id: intent.intent_id,
        body_hash: hash,
        state: "rejected",
        accepted: false,
        replayed: false,
        reason: errorMessage(error),
        recorded_utc: nowUtc(),
      };
      this.database.appendJournal(
        "intent_rejected",
        "warning",
        `Intent ${intent.intent_id} was rejected.`,
        { action: intent.action, reason: receipt.reason },
      );
    }
    this.database.finalizeIntent(receipt);
    return receipt;
  }

  getPerformance(): Record<string, unknown> {
    const risk = this.risk.snapshot();
    const trades = this.database.listTrades(1_000);
    const realized = trades.reduce((sum, trade) => sum + trade.netPnlCents, 0);
    const wins = trades.filter((trade) => trade.netPnlCents > 0);
    const losses = trades.filter((trade) => trade.netPnlCents < 0);
    const grossWins = wins.reduce((sum, trade) => sum + trade.netPnlCents, 0);
    const grossLosses = Math.abs(losses.reduce((sum, trade) => sum + trade.netPnlCents, 0));
    return {
      schema_version: "glitch.crypto.performance.v1",
      day: risk.day,
      start_equity_usd: centsToUsd(risk.dailyStartEquityCents),
      equity_usd: centsToUsd(risk.equityCents),
      realized_pnl_usd: centsToUsd(realized),
      daily_return_pct: Number(
        (((risk.equityCents - risk.dailyStartEquityCents) / risk.dailyStartEquityCents) * 100).toFixed(4),
      ),
      daily_lock_target_pct: bpsToPct(this.database.getPolicy().dailyLockTargetBps),
      daily_target_profit_usd: centsToUsd(risk.dailyTargetProfitCents),
      daily_lock_reached: risk.lockReached,
      active_floor_usd: risk.activeFloorCents === null ? null : centsToUsd(risk.activeFloorCents),
      protected_equity_usd: centsToUsd(risk.protectedEquityCents),
      trades: trades.length,
      wins: wins.length,
      losses: losses.length,
      win_rate_pct: trades.length === 0 ? null : Number(((wins.length / trades.length) * 100).toFixed(2)),
      profit_factor: grossLosses === 0 ? (grossWins > 0 ? null : 0) : Number((grossWins / grossLosses).toFixed(4)),
      recorded_utc: nowUtc(),
    };
  }

  publicTrades(limit = 100): Array<Record<string, unknown>> {
    return this.database.listTrades(limit).map(publicTrade);
  }

  journal(limit = 100): Array<Record<string, unknown>> {
    return this.database.listJournal(limit);
  }

  private executeIntent(intent: TradingIntent, hash: string): IntentReceipt {
    this.requireIdentity(intent);
    if (intent.action === "NOTHING" || intent.action === "HOLD") {
      return this.observationReceipt(intent, hash);
    }
    if (intent.action === "ENTER_LONG" || intent.action === "ENTER_SHORT") {
      return this.enter(intent, hash);
    }
    if (!("tranche_id" in intent)) {
      throw new Error("management_intent_requires_tranche_id");
    }
    const position = this.database.getPosition(intent.tranche_id);
    if (!position) {
      throw new Error("unknown_tranche_id");
    }
    if (position.instrument !== intent.instrument) {
      throw new Error("instrument_identity_mismatch");
    }
    switch (intent.action) {
      case "MOVE_STOP":
        return this.moveStop(intent, position, hash);
      case "MOVE_TARGET":
        return this.moveTarget(intent, position, hash);
      case "REDUCE":
        return this.reduce(intent, position, hash);
      case "EXIT":
        this.closeQuantity(
          position,
          position.quantityUnits,
          this.database.getAccount().markPriceCents,
          "managed_exit",
          intent.intent_id,
        );
        return acceptedReceipt(intent, hash, "closed", "position_closed", {
          tranche_id: position.trancheId,
        });
    }
  }

  private enter(intent: EntryIntent, hash: string): IntentReceipt {
    const control = this.database.getControl();
    if (!control.running) {
      throw new Error("runtime_is_stopped");
    }
    if (control.gatewayMode === "disabled") {
      throw new Error("gateway_mode_disabled");
    }
    if (this.database.getPositions().length > 0) {
      throw new Error("initial_scope_allows_one_open_position");
    }
    const risk = this.risk.snapshot();
    if (!risk.newExposureAllowed) {
      throw new Error(`new_exposure_restricted:${risk.reasons.join(",")}`);
    }
    const account = this.database.getAccount();
    const side: PositionSide = intent.action === "ENTER_LONG" ? "LONG" : "SHORT";
    const stopPriceCents = priceToCents(intent.stop_price);
    const targetPriceCents = priceToCents(intent.target_price);
    validateStopSide(side, account.markPriceCents, stopPriceCents);
    validateTargetSide(side, account.markPriceCents, targetPriceCents);
    const requestedRiskBps = intent.requested_risk_pct === undefined
      ? undefined
      : pctToBps(intent.requested_risk_pct);
    const sizing = this.risk.calculateEntrySizing({
      side,
      entryPriceCents: account.markPriceCents,
      stopPriceCents,
      requestedRiskBps,
      requestedLeverage: intent.requested_leverage,
    });
    const native = this.venue.createProtectedEntry({
      intentId: intent.intent_id,
      instrument: intent.instrument,
      side,
      quantityUnits: sizing.quantityUnits,
      entryPriceCents: account.markPriceCents,
      stopPriceCents,
      targetPriceCents,
    });
    if (native.protectionStatus !== "confirmed") {
      throw new Error("native_protection_not_confirmed");
    }
    const policy = this.database.getPolicy();
    const entryFeeCents = applyBps(
      sizing.notionalCents,
      Math.ceil(policy.estimatedRoundTripCostBps / 2),
    );
    const utc = nowUtc();
    const position: PositionRecord = {
      trancheId: `TR-${intent.intent_id}`,
      intentId: intent.intent_id,
      instrument: intent.instrument,
      side,
      quantityUnits: sizing.quantityUnits,
      entryPriceCents: native.fillPriceCents,
      stopPriceCents,
      targetPriceCents,
      leverage: sizing.leverage,
      entryFeeCents,
      entryOrderId: native.entryOrderId,
      stopOrderId: native.stopOrderId,
      targetOrderId: native.targetOrderId,
      openedUtc: utc,
      updatedUtc: utc,
    };
    this.database.transaction(() => {
      const latest = this.database.getAccount();
      this.database.updateAccount(latest.balanceCents - entryFeeCents, latest.markPriceCents);
      this.database.insertPosition(position);
      this.database.appendJournal(
        "position_open_protected",
        "info",
        `Protected ${side.toLowerCase()} paper position opened.`,
        {
          intent_id: intent.intent_id,
          tranche_id: position.trancheId,
          quantity: quantityToString(position.quantityUnits),
          planned_loss_usd: centsToUsd(sizing.plannedLossCents),
          entry_order_id: position.entryOrderId,
          stop_order_id: position.stopOrderId,
          target_order_id: position.targetOrderId,
        },
      );
    });
    this.risk.snapshot();
    return acceptedReceipt(intent, hash, "open_protected", "protected_entry_confirmed", {
      tranche_id: position.trancheId,
      side,
      quantity: quantityToString(position.quantityUnits),
      entry_price: centsToPrice(position.entryPriceCents),
      stop_price: centsToPrice(position.stopPriceCents),
      target_price: centsToPrice(position.targetPriceCents),
      notional_usd: centsToUsd(sizing.notionalCents),
      margin_required_usd: centsToUsd(sizing.marginRequiredCents),
      planned_loss_usd: centsToUsd(sizing.plannedLossCents),
      native_protection: {
        entry_order_id: position.entryOrderId,
        stop_order_id: position.stopOrderId,
        target_order_id: position.targetOrderId,
        status: "confirmed",
      },
    });
  }

  private observationReceipt(
    intent: TradingIntent,
    hash: string,
  ): IntentReceipt {
    if (intent.action === "HOLD" && intent.tranche_id) {
      if (!this.database.getPosition(intent.tranche_id)) {
        throw new Error("unknown_tranche_id");
      }
    }
    this.database.appendJournal(
      intent.action === "NOTHING" ? "flat_observation" : "position_hold",
      "info",
      intent.reason,
      { intent_id: intent.intent_id, action: intent.action, packet_id: intent.packet_id },
    );
    return acceptedReceipt(intent, hash, "observed", "decision_recorded_without_mutation", {});
  }

  private moveStop(
    intent: Extract<TradingIntent, { action: "MOVE_STOP" }>,
    position: PositionRecord,
    hash: string,
  ): IntentReceipt {
    const account = this.database.getAccount();
    const nextStop = priceToCents(intent.stop_price);
    validateStopSide(position.side, account.markPriceCents, nextStop);
    const previous = position.stopPriceCents;
    const updated = { ...position, stopPriceCents: nextStop, updatedUtc: nowUtc() };
    this.database.transaction(() => {
      this.database.updatePosition(updated);
      const snapshot = this.risk.snapshot();
      if (!snapshot.newExposureAllowed && snapshot.reasons.some((reason) =>
        reason === "maximum_open_risk_exceeded" ||
        reason === "daily_lock_floor_not_protected" ||
        reason === "daily_loss_boundary_reached")) {
        throw new Error(`stop_amendment_violates_policy:${snapshot.reasons.join(",")}`);
      }
      this.database.appendJournal("stop_moved", "info", intent.reason, {
        intent_id: intent.intent_id,
        tranche_id: position.trancheId,
        previous_stop: centsToPrice(previous),
        stop_price: intent.stop_price,
        stop_order_id: position.stopOrderId,
      });
    });
    return acceptedReceipt(intent, hash, "managed", "stop_amendment_confirmed", {
      tranche_id: position.trancheId,
      stop_price: intent.stop_price,
      stop_order_id: position.stopOrderId,
    });
  }

  private moveTarget(
    intent: Extract<TradingIntent, { action: "MOVE_TARGET" }>,
    position: PositionRecord,
    hash: string,
  ): IntentReceipt {
    const account = this.database.getAccount();
    const nextTarget = priceToCents(intent.target_price);
    validateTargetSide(position.side, account.markPriceCents, nextTarget);
    const previous = position.targetPriceCents;
    const updated = { ...position, targetPriceCents: nextTarget, updatedUtc: nowUtc() };
    this.database.updatePosition(updated);
    this.database.appendJournal("target_moved", "info", intent.reason, {
      intent_id: intent.intent_id,
      tranche_id: position.trancheId,
      previous_target: centsToPrice(previous),
      target_price: intent.target_price,
      target_order_id: position.targetOrderId,
    });
    return acceptedReceipt(intent, hash, "managed", "target_amendment_confirmed", {
      tranche_id: position.trancheId,
      target_price: intent.target_price,
      target_order_id: position.targetOrderId,
    });
  }

  private reduce(
    intent: Extract<TradingIntent, { action: "REDUCE" }>,
    position: PositionRecord,
    hash: string,
  ): IntentReceipt {
    const policy = this.database.getPolicy();
    const requested = Math.floor((position.quantityUnits * intent.reduce_fraction_pct) / 100);
    const quantity = roundDownToStep(requested, policy.quantityStepUnits);
    if (quantity <= 0 || quantity >= position.quantityUnits) {
      throw new Error("partial_reduction_is_not_venue_valid");
    }
    const remaining = position.quantityUnits - quantity;
    if (remaining < policy.quantityStepUnits) {
      throw new Error("partial_reduction_would_leave_dust");
    }
    this.closeQuantity(
      position,
      quantity,
      this.database.getAccount().markPriceCents,
      "partial_reduce",
      intent.intent_id,
    );
    const surviving = this.database.getPosition(position.trancheId);
    return acceptedReceipt(intent, hash, "reduced_protected", "partial_reduction_confirmed", {
      tranche_id: position.trancheId,
      closed_quantity: quantityToString(quantity),
      remaining_quantity: surviving ? quantityToString(surviving.quantityUnits) : "0",
      native_protection: surviving
        ? {
            stop_order_id: surviving.stopOrderId,
            target_order_id: surviving.targetOrderId,
            status: "confirmed",
          }
        : null,
    });
  }

  private closeQuantity(
    position: PositionRecord,
    quantityUnits: number,
    exitPriceCents: number,
    reason: string,
    causeIntentId: string,
  ): void {
    const policy = this.database.getPolicy();
    const grossPnlCents = pnlCents(
      position.side,
      position.entryPriceCents,
      exitPriceCents,
      quantityUnits,
    );
    const entryFeeAllocated = Math.round(
      (position.entryFeeCents * quantityUnits) / position.quantityUnits,
    );
    const exitFeeCents = applyBps(
      notionalCents(exitPriceCents, quantityUnits),
      Math.ceil(policy.estimatedRoundTripCostBps / 2),
    );
    const netPnlCents = grossPnlCents - entryFeeAllocated - exitFeeCents;
    const closedUtc = nowUtc();
    const trade: TradeRecord = {
      tradeId: randomUUID(),
      trancheId: position.trancheId,
      intentId: causeIntentId,
      instrument: position.instrument,
      side: position.side,
      quantityUnits,
      entryPriceCents: position.entryPriceCents,
      exitPriceCents,
      grossPnlCents,
      entryFeeCents: entryFeeAllocated,
      exitFeeCents,
      netPnlCents,
      exitReason: reason,
      openedUtc: position.openedUtc,
      closedUtc,
    };

    this.database.transaction(() => {
      const account = this.database.getAccount();
      this.database.updateAccount(
        account.balanceCents + grossPnlCents - exitFeeCents,
        account.markPriceCents,
      );
      const remaining = position.quantityUnits - quantityUnits;
      if (remaining === 0) {
        this.database.deletePosition(position.trancheId);
      } else {
        const replacement = this.venue.replacementProtectionIds(
          position.trancheId,
          causeIntentId,
        );
        this.database.updatePosition({
          ...position,
          quantityUnits: remaining,
          entryFeeCents: position.entryFeeCents - entryFeeAllocated,
          stopOrderId: replacement.stopOrderId,
          targetOrderId: replacement.targetOrderId,
          updatedUtc: closedUtc,
        });
      }
      this.database.insertTrade(trade);
      this.database.appendJournal(
        remaining === 0 ? "position_closed" : "position_reduced_protected",
        "info",
        `Paper position ${remaining === 0 ? "closed" : "partially reduced"}.`,
        {
          cause_intent_id: causeIntentId,
          close_order_id: this.venue.closeOrderId(position.trancheId, causeIntentId),
          tranche_id: position.trancheId,
          closed_quantity: quantityToString(quantityUnits),
          remaining_quantity: quantityToString(remaining),
          exit_reason: reason,
          net_pnl_usd: centsToUsd(netPnlCents),
        },
      );
    });
    this.risk.snapshot();
  }

  private requireIdentity(intent: TradingIntent): void {
    const account = this.database.getAccount();
    if (intent.account !== account.alias) {
      throw new Error("account_identity_mismatch");
    }
    if (intent.instrument !== "BTCUSDT-PERP") {
      throw new Error("instrument_identity_mismatch");
    }
  }
}

function acceptedReceipt(
  intent: TradingIntent,
  hash: string,
  state: IntentReceipt["state"],
  reason: string,
  data: Record<string, unknown>,
): IntentReceipt {
  return {
    schema_version: "glitch.crypto.intent-receipt.v1",
    intent_id: intent.intent_id,
    body_hash: hash,
    state,
    accepted: true,
    replayed: false,
    reason,
    recorded_utc: nowUtc(),
    data,
  };
}

function rejectionReceipt(input: unknown, reason: string): IntentReceipt {
  const record = input !== null && typeof input === "object" ? input as Record<string, unknown> : {};
  const id = typeof record.intent_id === "string" ? record.intent_id : "invalid-intent";
  return {
    schema_version: "glitch.crypto.intent-receipt.v1",
    intent_id: id,
    body_hash: bodyHash(input),
    state: "rejected",
    accepted: false,
    replayed: false,
    reason,
    recorded_utc: nowUtc(),
  };
}

function validateTargetSide(
  side: PositionSide,
  executablePriceCents: number,
  targetPriceCents: number,
): void {
  if (side === "LONG" && targetPriceCents <= executablePriceCents) {
    throw new Error("long target must be above executable price");
  }
  if (side === "SHORT" && targetPriceCents >= executablePriceCents) {
    throw new Error("short target must be below executable price");
  }
}

function publicPosition(position: PositionRecord, markPriceCents: number): Record<string, unknown> {
  return {
    tranche_id: position.trancheId,
    intent_id: position.intentId,
    instrument: position.instrument,
    side: position.side,
    quantity: quantityToString(position.quantityUnits),
    entry_price: centsToPrice(position.entryPriceCents),
    mark_price: centsToPrice(markPriceCents),
    stop_price: centsToPrice(position.stopPriceCents),
    target_price: centsToPrice(position.targetPriceCents),
    leverage: position.leverage,
    unrealized_pnl_usd: centsToUsd(
      pnlCents(position.side, position.entryPriceCents, markPriceCents, position.quantityUnits),
    ),
    protection: {
      status: "confirmed",
      entry_order_id: position.entryOrderId,
      stop_order_id: position.stopOrderId,
      target_order_id: position.targetOrderId,
    },
    opened_utc: position.openedUtc,
  };
}

function publicRisk(risk: ReturnType<RiskEngine["snapshot"]>): Record<string, unknown> {
  return {
    day: risk.day,
    equity_usd: centsToUsd(risk.equityCents),
    daily_start_equity_usd: centsToUsd(risk.dailyStartEquityCents),
    usable_pot_usd: centsToUsd(risk.usablePotCents),
    daily_start_pot_usd: centsToUsd(risk.dailyStartPotCents),
    daily_target_profit_usd: centsToUsd(risk.dailyTargetProfitCents),
    daily_target_equity_usd: centsToUsd(risk.dailyTargetEquityCents),
    high_water_equity_usd: centsToUsd(risk.highWaterEquityCents),
    protected_equity_usd: centsToUsd(risk.protectedEquityCents),
    open_risk_usd: centsToUsd(risk.openRiskCents),
    active_floor_usd: risk.activeFloorCents === null ? null : centsToUsd(risk.activeFloorCents),
    daily_loss_boundary_usd: centsToUsd(risk.dailyLossBoundaryCents),
    daily_lock_reached: risk.lockReached,
    new_exposure_allowed: risk.newExposureAllowed,
    restrictions: risk.reasons,
  };
}

function publicTrade(trade: TradeRecord): Record<string, unknown> {
  return {
    trade_id: trade.tradeId,
    tranche_id: trade.trancheId,
    intent_id: trade.intentId,
    instrument: trade.instrument,
    side: trade.side,
    quantity: quantityToString(trade.quantityUnits),
    entry_price: centsToPrice(trade.entryPriceCents),
    exit_price: centsToPrice(trade.exitPriceCents),
    gross_pnl_usd: centsToUsd(trade.grossPnlCents),
    fees_usd: centsToUsd(trade.entryFeeCents + trade.exitFeeCents),
    net_pnl_usd: centsToUsd(trade.netPnlCents),
    exit_reason: trade.exitReason,
    opened_utc: trade.openedUtc,
    closed_utc: trade.closedUtc,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
