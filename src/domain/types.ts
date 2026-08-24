export type GatewayMode = "disabled" | "shadow" | "armed";
export type PositionSide = "LONG" | "SHORT";
export type IntentAction =
  | "ENTER_LONG"
  | "ENTER_SHORT"
  | "HOLD"
  | "NOTHING"
  | "MOVE_STOP"
  | "MOVE_TARGET"
  | "REDUCE"
  | "EXIT";

export interface RiskPolicy {
  schemaVersion: "glitch.crypto.risk-policy.v1";
  dailyLockTargetBps: number;
  usableBalanceLimitCents: number | null;
  maxLeverage: number;
  maxTradeRiskBps: number;
  maxOpenRiskBps: number;
  maxDailyLossBps: number;
  estimatedRoundTripCostBps: number;
  stressedExitCostBps: number;
  quantityStepUnits: number;
  minimumNotionalCents: number;
}

export interface PublicRiskPolicy {
  schema_version: "glitch.crypto.risk-policy.v1";
  daily_lock_target_pct: number;
  usable_balance_limit_usd: number | null;
  max_leverage: number;
  max_trade_risk_pct: number;
  max_open_risk_pct: number;
  max_daily_loss_pct: number;
  estimated_round_trip_cost_pct: number;
  stressed_exit_cost_pct: number;
  quantity_step: string;
  minimum_notional_usd: number;
}

export interface AccountRecord {
  alias: string;
  balanceCents: number;
  markPriceCents: number;
  updatedUtc: string;
}

export interface PositionRecord {
  trancheId: string;
  intentId: string;
  instrument: string;
  side: PositionSide;
  quantityUnits: number;
  entryPriceCents: number;
  stopPriceCents: number;
  targetPriceCents: number;
  leverage: number;
  entryFeeCents: number;
  entryOrderId: string;
  stopOrderId: string;
  targetOrderId: string;
  openedUtc: string;
  updatedUtc: string;
}

export interface DailyStateRecord {
  day: string;
  startEquityCents: number;
  highWaterEquityCents: number;
  lockReached: boolean;
  activeFloorCents: number | null;
  updatedUtc: string;
}

export interface EntryIntent {
  schema_version: "glitch.crypto.intent.v1";
  intent_id: string;
  packet_id: string;
  account: string;
  instrument: string;
  action: "ENTER_LONG" | "ENTER_SHORT";
  stop_price: number;
  target_price: number;
  requested_risk_pct?: number;
  requested_leverage?: number;
  reason: string;
  model?: {
    provider?: string;
    model_id?: string;
    prompt_version?: string;
    skill_versions?: Record<string, string>;
  };
}

export type ManagementIntent =
  | {
      schema_version: "glitch.crypto.intent.v1";
      intent_id: string;
      packet_id: string;
      account: string;
      instrument: string;
      action: "MOVE_STOP";
      tranche_id: string;
      stop_price: number;
      reason: string;
      model?: EntryIntent["model"];
    }
  | {
      schema_version: "glitch.crypto.intent.v1";
      intent_id: string;
      packet_id: string;
      account: string;
      instrument: string;
      action: "MOVE_TARGET";
      tranche_id: string;
      target_price: number;
      reason: string;
      model?: EntryIntent["model"];
    }
  | {
      schema_version: "glitch.crypto.intent.v1";
      intent_id: string;
      packet_id: string;
      account: string;
      instrument: string;
      action: "REDUCE";
      tranche_id: string;
      reduce_fraction_pct: number;
      reason: string;
      model?: EntryIntent["model"];
    }
  | {
      schema_version: "glitch.crypto.intent.v1";
      intent_id: string;
      packet_id: string;
      account: string;
      instrument: string;
      action: "EXIT";
      tranche_id: string;
      reason: string;
      model?: EntryIntent["model"];
    };

export type ObservationIntent =
  | {
      schema_version: "glitch.crypto.intent.v1";
      intent_id: string;
      packet_id: string;
      account: string;
      instrument: string;
      action: "HOLD";
      tranche_id: string;
      reason: string;
      model?: EntryIntent["model"];
    }
  | {
      schema_version: "glitch.crypto.intent.v1";
      intent_id: string;
      packet_id: string;
      account: string;
      instrument: string;
      action: "NOTHING";
      reason: string;
      model?: EntryIntent["model"];
    };

export type TradingIntent = EntryIntent | ManagementIntent | ObservationIntent;

export interface IntentReceipt {
  schema_version: "glitch.crypto.intent-receipt.v1";
  intent_id: string;
  body_hash: string;
  state:
    | "rejected"
    | "observed"
    | "open_protected"
    | "managed"
    | "reduced_protected"
    | "closed"
    | "conflict";
  accepted: boolean;
  replayed: boolean;
  reason: string;
  recorded_utc: string;
  data?: Record<string, unknown>;
}

export interface SizingResult {
  quantityUnits: number;
  notionalCents: number;
  marginRequiredCents: number;
  riskBudgetCents: number;
  plannedLossCents: number;
  stopDistanceBps: number;
  totalLossDistanceBps: number;
  leverage: number;
}

export interface RiskSnapshot {
  day: string;
  equityCents: number;
  dailyStartEquityCents: number;
  usablePotCents: number;
  dailyStartPotCents: number;
  dailyTargetProfitCents: number;
  dailyTargetEquityCents: number;
  highWaterEquityCents: number;
  activeFloorCents: number | null;
  dailyLossBoundaryCents: number;
  openRiskCents: number;
  protectedEquityCents: number;
  lockReached: boolean;
  newExposureAllowed: boolean;
  reasons: string[];
}

export interface TradeRecord {
  tradeId: string;
  trancheId: string;
  intentId: string;
  instrument: string;
  side: PositionSide;
  quantityUnits: number;
  entryPriceCents: number;
  exitPriceCents: number;
  grossPnlCents: number;
  entryFeeCents: number;
  exitFeeCents: number;
  netPnlCents: number;
  exitReason: string;
  openedUtc: string;
  closedUtc: string;
}
