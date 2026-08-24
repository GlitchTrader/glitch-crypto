import { applyBps, notionalCents, pnlCents, QUANTITY_SCALE, roundDownToStep, utcDay } from "../domain/money.js";
import type {
  AccountRecord,
  DailyStateRecord,
  PositionRecord,
  PositionSide,
  RiskPolicy,
  RiskSnapshot,
  SizingResult,
} from "../domain/types.js";
import { GlitchDatabase, nowUtc } from "../storage/database.js";

export class RiskEngine {
  constructor(private readonly database: GlitchDatabase) {}

  equityCents(account: AccountRecord, positions: PositionRecord[]): number {
    return account.balanceCents + positions.reduce(
      (total, position) =>
        total + pnlCents(position.side, position.entryPriceCents, account.markPriceCents, position.quantityUnits),
      0,
    );
  }

  openRiskCents(
    account: AccountRecord,
    positions: PositionRecord[],
    policy: RiskPolicy,
  ): number {
    return positions.reduce((total, position) => {
      const distance = position.side === "LONG"
        ? Math.max(0, account.markPriceCents - position.stopPriceCents)
        : Math.max(0, position.stopPriceCents - account.markPriceCents);
      const priceRisk = Math.round((distance * position.quantityUnits) / QUANTITY_SCALE);
      const exitCost = applyBps(
        notionalCents(account.markPriceCents, position.quantityUnits),
        policy.stressedExitCostBps,
      );
      return total + priceRisk + exitCost;
    }, 0);
  }

  snapshot(day = utcDay()): RiskSnapshot {
    const policy = this.database.getPolicy();
    const account = this.database.getAccount();
    const positions = this.database.getPositions();
    const equity = this.equityCents(account, positions);
    const openRisk = this.openRiskCents(account, positions, policy);
    const protectedEquity = equity - openRisk;
    let daily = this.database.getDailyState(day);
    if (!daily) {
      daily = {
        day,
        startEquityCents: equity,
        highWaterEquityCents: equity,
        lockReached: false,
        activeFloorCents: null,
        updatedUtc: nowUtc(),
      };
    }

    const dailyStartPot = usablePot(daily.startEquityCents, policy.usableBalanceLimitCents);
    const currentUsablePot = usablePot(equity, policy.usableBalanceLimitCents);
    const dailyTargetProfit = applyBps(dailyStartPot, policy.dailyLockTargetBps);
    const dailyTargetEquity = daily.startEquityCents + dailyTargetProfit;
    const highWater = Math.max(daily.highWaterEquityCents, equity);
    const newlyEarnedFloor = protectedEquity >= dailyTargetEquity ? dailyTargetEquity : null;
    const activeFloor = Math.max(daily.activeFloorCents ?? 0, newlyEarnedFloor ?? 0) || null;
    const lockReached = activeFloor !== null;
    const dailyLossBoundary = daily.startEquityCents - applyBps(dailyStartPot, policy.maxDailyLossBps);
    const maxOpenRisk = applyBps(currentUsablePot, policy.maxOpenRiskBps);

    const reasons: string[] = [];
    if (protectedEquity <= dailyLossBoundary) {
      reasons.push("daily_loss_boundary_reached");
    }
    if (openRisk > maxOpenRisk) {
      reasons.push("maximum_open_risk_exceeded");
    }
    if (activeFloor !== null && protectedEquity < activeFloor) {
      reasons.push("daily_lock_floor_not_protected");
    }
    if (currentUsablePot < policy.minimumNotionalCents) {
      reasons.push("usable_pot_below_minimum_notional");
    }

    const updated: DailyStateRecord = {
      ...daily,
      highWaterEquityCents: highWater,
      lockReached,
      activeFloorCents: activeFloor,
      updatedUtc: nowUtc(),
    };
    this.database.upsertDailyState(updated);

    return {
      day,
      equityCents: equity,
      dailyStartEquityCents: daily.startEquityCents,
      usablePotCents: currentUsablePot,
      dailyStartPotCents: dailyStartPot,
      dailyTargetProfitCents: dailyTargetProfit,
      dailyTargetEquityCents: dailyTargetEquity,
      highWaterEquityCents: highWater,
      activeFloorCents: activeFloor,
      dailyLossBoundaryCents: dailyLossBoundary,
      openRiskCents: openRisk,
      protectedEquityCents: protectedEquity,
      lockReached,
      newExposureAllowed: reasons.length === 0,
      reasons,
    };
  }

  calculateEntrySizing(input: {
    side: PositionSide;
    entryPriceCents: number;
    stopPriceCents: number;
    requestedRiskBps?: number;
    requestedLeverage?: number;
  }): SizingResult {
    const policy = this.database.getPolicy();
    const account = this.database.getAccount();
    const positions = this.database.getPositions();
    const risk = this.snapshot();

    validateStopSide(input.side, input.entryPriceCents, input.stopPriceCents);
    const stopDistanceBps = Math.ceil(
      (Math.abs(input.entryPriceCents - input.stopPriceCents) * 10_000) / input.entryPriceCents,
    );
    const totalLossDistanceBps = stopDistanceBps + policy.estimatedRoundTripCostBps;
    if (totalLossDistanceBps <= 0) {
      throw new Error("total loss distance must be positive");
    }

    const requestedRisk = input.requestedRiskBps ?? policy.maxTradeRiskBps;
    const riskBps = Math.min(requestedRisk, policy.maxTradeRiskBps);
    if (!Number.isInteger(riskBps) || riskBps <= 0) {
      throw new Error("requested risk must resolve to positive basis points");
    }
    const leverage = Math.min(input.requestedLeverage ?? policy.maxLeverage, policy.maxLeverage);
    if (!Number.isInteger(leverage) || leverage < 1) {
      throw new Error("requested leverage must resolve to a positive integer");
    }

    const riskBudgetCents = applyBps(risk.usablePotCents, riskBps);
    const notionalByRisk = Math.floor((riskBudgetCents * 10_000) / totalLossDistanceBps);
    const usedMargin = positions.reduce(
      (total, position) => total + Math.ceil(notionalCents(account.markPriceCents, position.quantityUnits) / position.leverage),
      0,
    );
    const availableMargin = Math.max(0, risk.usablePotCents - usedMargin);
    const notionalByMargin = availableMargin * leverage;
    const requestedNotional = Math.min(notionalByRisk, notionalByMargin);
    const rawQuantity = Math.floor((requestedNotional * QUANTITY_SCALE) / input.entryPriceCents);
    const quantityUnits = roundDownToStep(rawQuantity, policy.quantityStepUnits);
    const actualNotional = notionalCents(input.entryPriceCents, quantityUnits);
    const plannedLoss = applyBps(actualNotional, totalLossDistanceBps);
    const marginRequired = Math.ceil(actualNotional / leverage);

    if (quantityUnits <= 0 || actualNotional < policy.minimumNotionalCents) {
      throw new Error("risk and margin constraints produce no venue-valid quantity");
    }
    const maxOpenRisk = applyBps(risk.usablePotCents, policy.maxOpenRiskBps);
    if (risk.openRiskCents + plannedLoss > maxOpenRisk) {
      throw new Error("projected open risk exceeds policy");
    }
    const projectedProtectedEquity = risk.protectedEquityCents - plannedLoss;
    if (projectedProtectedEquity <= risk.dailyLossBoundaryCents) {
      throw new Error("projected protected equity reaches the daily loss boundary");
    }
    if (risk.activeFloorCents !== null && projectedProtectedEquity < risk.activeFloorCents) {
      throw new Error("projected protected equity would violate the active daily lock floor");
    }

    return {
      quantityUnits,
      notionalCents: actualNotional,
      marginRequiredCents: marginRequired,
      riskBudgetCents,
      plannedLossCents: plannedLoss,
      stopDistanceBps,
      totalLossDistanceBps,
      leverage,
    };
  }
}

export function usablePot(equityCents: number, limitCents: number | null): number {
  return limitCents === null ? equityCents : Math.min(equityCents, limitCents);
}

export function dailyTargetProfitCents(
  startEquityCents: number,
  limitCents: number | null,
  targetBps: number,
): number {
  return applyBps(usablePot(startEquityCents, limitCents), targetBps);
}

export function validateStopSide(
  side: PositionSide,
  entryPriceCents: number,
  stopPriceCents: number,
): void {
  if (side === "LONG" && stopPriceCents >= entryPriceCents) {
    throw new Error("long stop must be below executable price");
  }
  if (side === "SHORT" && stopPriceCents <= entryPriceCents) {
    throw new Error("short stop must be above executable price");
  }
}
