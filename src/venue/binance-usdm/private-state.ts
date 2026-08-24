import { bodyHash } from "../../domain/canonical-json.js";

export interface BinancePrivateBalance {
  asset: string;
  wallet_balance: string;
  cross_wallet_balance: string;
  balance_change: string | null;
}

export interface BinancePrivatePosition {
  symbol: string;
  position_side: string;
  quantity: string;
  entry_price: string;
  break_even_price: string | null;
  realized_pnl: string | null;
  unrealized_pnl: string | null;
  margin_type: string | null;
  isolated_wallet: string | null;
}

export interface BinancePrivateOrder {
  symbol: string;
  order_id: number;
  client_order_id: string;
  side: string;
  position_side: string;
  order_type: string;
  status: string;
  time_in_force: string;
  original_quantity: string;
  filled_quantity: string;
  average_price: string;
  stop_price: string;
  reduce_only: boolean;
  close_position: boolean;
  execution_type: string;
  trade_id: number | null;
  update_time: number;
}

export interface BinancePrivateStateView {
  schema_version: "glitch.crypto.binance-usdm-private-state.v1";
  stream_expired: boolean;
  last_event_time: number | null;
  last_transaction_time: number | null;
  balances: BinancePrivateBalance[];
  positions: BinancePrivatePosition[];
  orders: BinancePrivateOrder[];
  applied_event_count: number;
}

export type BinancePrivateApplyResult = "applied" | "duplicate" | "unsupported";

export class BinanceUsdmPrivateState {
  private readonly balances = new Map<string, BinancePrivateBalance>();
  private readonly positions = new Map<string, BinancePrivatePosition>();
  private readonly orders = new Map<number, BinancePrivateOrder>();
  private readonly eventIds = new Set<string>();
  private streamExpired = false;
  private lastEventTime: number | null = null;
  private lastTransactionTime: number | null = null;

  apply(input: unknown): BinancePrivateApplyResult {
    const event = objectValue(input, "private stream event");
    const eventType = stringValue(event.e, "private stream event type");
    const eventId = bodyHash(event);
    if (this.eventIds.has(eventId)) {
      return "duplicate";
    }

    let applied = false;
    if (eventType === "ACCOUNT_UPDATE") {
      this.applyAccountUpdate(event);
      applied = true;
    } else if (eventType === "ORDER_TRADE_UPDATE") {
      this.applyOrderUpdate(event);
      applied = true;
    } else if (eventType === "listenKeyExpired") {
      this.streamExpired = true;
      applied = true;
    }

    if (!applied) {
      return "unsupported";
    }
    this.eventIds.add(eventId);
    this.lastEventTime = optionalSafeInteger(event.E, "event time") ?? this.lastEventTime;
    this.lastTransactionTime = optionalSafeInteger(event.T, "transaction time") ?? this.lastTransactionTime;
    return "applied";
  }

  reconcile(input: {
    balances?: unknown;
    positions?: unknown;
    openOrders?: unknown;
    observedAt?: number;
  }): BinancePrivateStateView {
    if (input.balances !== undefined) {
      this.balances.clear();
      for (const item of arrayValue(input.balances, "balance snapshot")) {
        const balance = objectValue(item, "balance snapshot item");
        const asset = stringValue(balance.asset, "balance asset");
        this.balances.set(asset, {
          asset,
          wallet_balance: decimalString(balance.balance ?? balance.walletBalance, "wallet balance"),
          cross_wallet_balance: decimalString(
            balance.crossWalletBalance ?? balance.availableBalance ?? balance.balance,
            "cross wallet balance",
          ),
          balance_change: null,
        });
      }
    }

    if (input.positions !== undefined) {
      this.positions.clear();
      for (const item of arrayValue(input.positions, "position snapshot")) {
        const position = objectValue(item, "position snapshot item");
        const symbol = stringValue(position.symbol, "position symbol");
        const side = stringValue(position.positionSide ?? "BOTH", "position side");
        this.positions.set(positionKey(symbol, side), {
          symbol,
          position_side: side,
          quantity: decimalString(position.positionAmt ?? "0", "position quantity", true),
          entry_price: decimalString(position.entryPrice ?? "0", "entry price"),
          break_even_price: optionalDecimalString(position.breakEvenPrice, "break-even price"),
          realized_pnl: null,
          unrealized_pnl: optionalDecimalString(position.unRealizedProfit, "unrealized profit", true),
          margin_type: optionalString(position.marginType),
          isolated_wallet: optionalDecimalString(position.isolatedWallet, "isolated wallet"),
        });
      }
    }

    if (input.openOrders !== undefined) {
      this.orders.clear();
      for (const item of arrayValue(input.openOrders, "open-order snapshot")) {
        const order = objectValue(item, "open-order snapshot item");
        const normalized = normalizeRestOrder(order);
        this.orders.set(normalized.order_id, normalized);
      }
    }

    if (input.observedAt !== undefined) {
      this.lastTransactionTime = safeInteger(input.observedAt, "snapshot observedAt");
    }
    this.streamExpired = false;
    return this.view();
  }

  view(): BinancePrivateStateView {
    return {
      schema_version: "glitch.crypto.binance-usdm-private-state.v1",
      stream_expired: this.streamExpired,
      last_event_time: this.lastEventTime,
      last_transaction_time: this.lastTransactionTime,
      balances: [...this.balances.values()].sort((a, b) => a.asset.localeCompare(b.asset)),
      positions: [...this.positions.values()].sort((a, b) =>
        positionKey(a.symbol, a.position_side).localeCompare(positionKey(b.symbol, b.position_side))),
      orders: [...this.orders.values()].sort((a, b) => a.order_id - b.order_id),
      applied_event_count: this.eventIds.size,
    };
  }

  private applyAccountUpdate(event: Record<string, unknown>): void {
    const account = objectValue(event.a, "account update payload");
    for (const item of arrayValue(account.B ?? [], "account balances")) {
      const balance = objectValue(item, "account balance");
      const asset = stringValue(balance.a, "balance asset");
      this.balances.set(asset, {
        asset,
        wallet_balance: decimalString(balance.wb, "wallet balance"),
        cross_wallet_balance: decimalString(balance.cw, "cross wallet balance"),
        balance_change: optionalDecimalString(balance.bc, "balance change", true),
      });
    }
    for (const item of arrayValue(account.P ?? [], "account positions")) {
      const position = objectValue(item, "account position");
      const symbol = stringValue(position.s, "position symbol");
      const side = stringValue(position.ps ?? "BOTH", "position side");
      this.positions.set(positionKey(symbol, side), {
        symbol,
        position_side: side,
        quantity: decimalString(position.pa, "position quantity", true),
        entry_price: decimalString(position.ep, "entry price"),
        break_even_price: optionalDecimalString(position.bep, "break-even price"),
        realized_pnl: optionalDecimalString(position.cr, "realized pnl", true),
        unrealized_pnl: optionalDecimalString(position.up, "unrealized pnl", true),
        margin_type: optionalString(position.mt),
        isolated_wallet: optionalDecimalString(position.iw, "isolated wallet"),
      });
    }
  }

  private applyOrderUpdate(event: Record<string, unknown>): void {
    const order = objectValue(event.o, "order update payload");
    const normalized: BinancePrivateOrder = {
      symbol: stringValue(order.s, "order symbol"),
      order_id: safeInteger(order.i, "order ID"),
      client_order_id: stringValue(order.c, "client order ID"),
      side: stringValue(order.S, "order side"),
      position_side: stringValue(order.ps ?? "BOTH", "order position side"),
      order_type: stringValue(order.o, "order type"),
      status: stringValue(order.X, "order status"),
      time_in_force: stringValue(order.f, "time in force"),
      original_quantity: decimalString(order.q, "original quantity"),
      filled_quantity: decimalString(order.z, "filled quantity"),
      average_price: decimalString(order.ap ?? "0", "average price"),
      stop_price: decimalString(order.sp ?? "0", "stop price"),
      reduce_only: booleanValue(order.R, "reduce-only"),
      close_position: booleanValue(order.cp, "close-position"),
      execution_type: stringValue(order.x, "execution type"),
      trade_id: optionalSafeInteger(order.t, "trade ID"),
      update_time: safeInteger(event.T ?? event.E, "order update time"),
    };
    this.orders.set(normalized.order_id, normalized);
  }
}

function normalizeRestOrder(order: Record<string, unknown>): BinancePrivateOrder {
  return {
    symbol: stringValue(order.symbol, "order symbol"),
    order_id: safeInteger(order.orderId, "order ID"),
    client_order_id: stringValue(order.clientOrderId, "client order ID"),
    side: stringValue(order.side, "order side"),
    position_side: stringValue(order.positionSide ?? "BOTH", "order position side"),
    order_type: stringValue(order.type, "order type"),
    status: stringValue(order.status, "order status"),
    time_in_force: stringValue(order.timeInForce, "time in force"),
    original_quantity: decimalString(order.origQty, "original quantity"),
    filled_quantity: decimalString(order.executedQty ?? "0", "filled quantity"),
    average_price: decimalString(order.avgPrice ?? "0", "average price"),
    stop_price: decimalString(order.stopPrice ?? "0", "stop price"),
    reduce_only: booleanValue(order.reduceOnly ?? false, "reduce-only"),
    close_position: booleanValue(order.closePosition ?? false, "close-position"),
    execution_type: "REST_RECONCILIATION",
    trade_id: null,
    update_time: safeInteger(order.updateTime ?? order.time ?? 0, "order update time", true),
  };
}

function positionKey(symbol: string, side: string): string {
  return `${symbol}:${side}`;
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array`);
  }
  return value;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be boolean`);
  }
  return value;
}

function safeInteger(value: unknown, name: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || (allowZero ? (value as number) < 0 : (value as number) <= 0)) {
    throw new Error(`${name} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`);
  }
  return value as number;
}

function optionalSafeInteger(value: unknown, name: string): number | null {
  if (value === undefined || value === null || value === 0 || value === -1) {
    return null;
  }
  return safeInteger(value, name);
}

function decimalString(value: unknown, name: string, signed = false): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a decimal string`);
  }
  const pattern = signed ? /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/ : /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
  if (!pattern.test(value)) {
    throw new Error(`${name} must be a valid ${signed ? "signed " : ""}decimal string`);
  }
  return value;
}

function optionalDecimalString(value: unknown, name: string, signed = false): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return decimalString(value, name, signed);
}
