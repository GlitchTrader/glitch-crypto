export interface BinanceAggregateTradeEventSummary {
  event_type: "aggTrade";
  event_time: number;
  symbol: string;
  aggregate_trade_id: number;
  price: string;
  quantity: string;
  first_trade_id: number;
  last_trade_id: number;
  trade_time: number;
  buyer_is_maker: boolean;
}

export interface BinanceMarkPriceEventSummary {
  event_type: "markPriceUpdate";
  event_time: number;
  symbol: string;
  mark_price: string;
  index_price: string;
  estimated_settlement_price: string;
  funding_rate: string;
  next_funding_time: number;
}

export type BinanceMarketEventSummary =
  | BinanceAggregateTradeEventSummary
  | BinanceMarkPriceEventSummary;

export function inspectBinanceMarketEvent(
  input: unknown,
  expectedSymbol: string,
): BinanceMarketEventSummary {
  const event = objectValue(input, "Binance market event");
  const eventType = stringValue(event.e, "event type");
  const symbol = stringValue(event.s, "event symbol");
  if (symbol !== expectedSymbol) {
    throw new Error(
      `Binance market event symbol ${symbol} does not match ${expectedSymbol}`,
    );
  }
  const eventTime = positiveSafeInteger(event.E, "event time");

  if (eventType === "aggTrade") {
    const firstTradeId = nonNegativeSafeInteger(event.f, "first trade ID");
    const lastTradeId = nonNegativeSafeInteger(event.l, "last trade ID");
    if (firstTradeId > lastTradeId) {
      throw new Error("first trade ID must not exceed last trade ID");
    }
    return {
      event_type: "aggTrade",
      event_time: eventTime,
      symbol,
      aggregate_trade_id: nonNegativeSafeInteger(
        event.a,
        "aggregate trade ID",
      ),
      price: positiveDecimal(event.p, "trade price"),
      quantity: positiveDecimal(event.q, "trade quantity"),
      first_trade_id: firstTradeId,
      last_trade_id: lastTradeId,
      trade_time: positiveSafeInteger(event.T, "trade time"),
      buyer_is_maker: booleanValue(event.m, "buyer-is-maker"),
    };
  }

  if (eventType === "markPriceUpdate") {
    return {
      event_type: "markPriceUpdate",
      event_time: eventTime,
      symbol,
      mark_price: positiveDecimal(event.p, "mark price"),
      index_price: positiveDecimal(event.i, "index price"),
      estimated_settlement_price: nonNegativeDecimal(
        event.P,
        "estimated settlement price",
      ),
      funding_rate: signedDecimal(event.r, "funding rate"),
      next_funding_time: positiveSafeInteger(
        event.T,
        "next funding time",
      ),
    };
  }

  throw new Error(`unsupported Binance market event type: ${eventType}`);
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function positiveSafeInteger(value: unknown, name: string): number {
  const result = nonNegativeSafeInteger(value, name);
  if (result === 0) {
    throw new Error(`${name} must be positive`);
  }
  return result;
}

function nonNegativeSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value as number;
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be boolean`);
  }
  return value;
}

function positiveDecimal(value: unknown, name: string): string {
  const result = nonNegativeDecimal(value, name);
  if (Number(result) <= 0) {
    throw new Error(`${name} must be positive`);
  }
  return result;
}

function nonNegativeDecimal(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)
  ) {
    throw new Error(`${name} must be a non-negative decimal string`);
  }
  return value;
}

function signedDecimal(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)
  ) {
    throw new Error(`${name} must be a signed decimal string`);
  }
  return value;
}
