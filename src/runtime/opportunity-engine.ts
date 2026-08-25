import { bodyHash } from "../domain/canonical-json.js";
import type {
  BinanceAggregateTradeEventSummary,
  BinanceMarketEventSummary,
  BinanceMarkPriceEventSummary,
} from "../venue/binance-usdm/market-events.js";
import type { BinanceOrderBookView } from "../venue/binance-usdm/order-book.js";

export type OpportunityAction = "ENTER_LONG" | "ENTER_SHORT" | "NOTHING";
export type OpportunityState = "warming" | "stale" | "ready" | "actionable";

export interface OpportunityEngineConfig {
  minimumTrades: number;
  minimumDirectionalBps: number;
  minimumGrossMoveBps: number;
  minimumConservativeEdgeBps: number;
  estimatedRoundTripCostBps: number;
  maximumMarketAgeMs: number;
}

export interface CryptoOpportunitySnapshot {
  schema_version: "glitch.crypto.opportunity.v1";
  baseline_version: "microstructure-baseline.v1";
  calibrated: false;
  observation_id: string;
  observed_utc: string;
  state: OpportunityState;
  actionable: boolean;
  action: OpportunityAction;
  reason: string;
  market: {
    instrument: "BTCUSDT-PERP";
    mark_price: number | null;
    index_price: number | null;
    best_bid: number | null;
    best_ask: number | null;
    spread_bps: number | null;
    funding_rate: number | null;
    market_age_ms: number | null;
  };
  evidence: {
    trades_15s: number;
    trades_60s: number;
    trade_rate_15s: number;
    buy_notional_15s: number;
    sell_notional_15s: number;
    flow_imbalance_15s: number;
    flow_imbalance_60s: number;
    book_imbalance_top5: number | null;
    microprice_edge_bps: number | null;
    momentum_15s_bps: number | null;
    momentum_60s_bps: number | null;
    range_15s_bps: number | null;
    noise_15s_bps: number | null;
    directional_pressure_bps: number | null;
  };
  economics: {
    expected_gross_move_bps: number | null;
    execution_and_noise_reserve_bps: number | null;
    conservative_edge_bps: number | null;
    minimum_edge_bps: number;
  };
  geometry: {
    invalidation_distance_bps: number | null;
    objective_distance_bps: number | null;
    suggested_stop_price: number | null;
    suggested_target_price: number | null;
  };
}

interface TradeSample {
  eventTime: number;
  price: number;
  quantity: number;
  notional: number;
  signedNotional: number;
}

const MAXIMUM_TRADE_SAMPLES = 20_000;
const RETENTION_MS = 120_000;

export class CryptoOpportunityEngine {
  private readonly trades: TradeSample[] = [];
  private book: BinanceOrderBookView | null = null;
  private mark: BinanceMarkPriceEventSummary | null = null;
  private latestEventTime: number | null = null;

  constructor(private readonly config: OpportunityEngineConfig) {
    requireInteger(config.minimumTrades, 1, 10_000, "minimum trades");
    requireFinite(config.minimumDirectionalBps, 0, 1_000, "minimum directional bps");
    requireFinite(config.minimumGrossMoveBps, 0, 5_000, "minimum gross move bps");
    requireFinite(config.minimumConservativeEdgeBps, 0, 1_000, "minimum conservative edge bps");
    requireFinite(config.estimatedRoundTripCostBps, 0, 1_000, "estimated round-trip cost bps");
    requireInteger(config.maximumMarketAgeMs, 100, 120_000, "maximum market age");
  }

  updateBook(book: BinanceOrderBookView): void {
    this.book = {
      ...book,
      bids: book.bids.map((level) => [...level] as [string, string]),
      asks: book.asks.map((level) => [...level] as [string, string]),
      best_bid: book.best_bid ? [...book.best_bid] as [string, string] : null,
      best_ask: book.best_ask ? [...book.best_ask] as [string, string] : null,
    };
    if (book.event_time !== null) {
      this.latestEventTime = Math.max(this.latestEventTime ?? 0, book.event_time);
    }
  }

  updateMarket(event: BinanceMarketEventSummary): void {
    this.latestEventTime = Math.max(this.latestEventTime ?? 0, event.event_time);
    if (event.event_type === "markPriceUpdate") {
      this.mark = { ...event };
      return;
    }
    this.addTrade(event);
  }

  snapshot(nowMs = Date.now()): CryptoOpportunitySnapshot {
    const anchor = this.latestEventTime ?? nowMs;
    this.prune(anchor);
    const short = this.trades.filter((trade) => trade.eventTime >= anchor - 15_000);
    const long = this.trades.filter((trade) => trade.eventTime >= anchor - 60_000);
    const top = topOfBook(this.book);
    const markPrice = finitePositive(this.mark?.mark_price) ?? lastPrice(long);
    const indexPrice = finitePositive(this.mark?.index_price);
    const fundingRate = finiteNumber(this.mark?.funding_rate);
    const marketAgeMs = this.latestEventTime === null
      ? null
      : Math.max(0, nowMs - this.latestEventTime);
    const spreadBps = top && markPrice
      ? ((top.ask - top.bid) / ((top.ask + top.bid) / 2)) * 10_000
      : null;
    const shortFlow = flow(short);
    const longFlow = flow(long);
    const bookImbalance = orderBookImbalance(this.book, 5);
    const micropriceEdgeBps = top
      ? micropriceEdge(top.bid, top.ask, top.bidQuantity, top.askQuantity)
      : null;
    const momentum15 = momentumBps(short);
    const momentum60 = momentumBps(long);
    const range15 = rangeBps(short);
    const noise15 = localNoiseBps(short, spreadBps);

    const ready =
      this.book?.status === "ready" &&
      markPrice !== null &&
      top !== null &&
      short.length >= this.config.minimumTrades &&
      marketAgeMs !== null &&
      marketAgeMs <= this.config.maximumMarketAgeMs;

    const directionalPressure = ready
      ? weightedPressure({
          momentum15: momentum15 ?? 0,
          momentum60: momentum60 ?? 0,
          flow15: shortFlow.imbalance,
          flow60: longFlow.imbalance,
          bookImbalance: bookImbalance ?? 0,
          micropriceEdgeBps: micropriceEdgeBps ?? 0,
        })
      : null;
    const directionalAction = directionalPressure === null ||
      Math.abs(directionalPressure) < this.config.minimumDirectionalBps
      ? "NOTHING"
      : directionalPressure > 0
        ? "ENTER_LONG"
        : "ENTER_SHORT";
    const expectedGrossMove = directionalPressure === null
      ? null
      : Math.abs(directionalPressure) + Math.max(0, (range15 ?? 0) - (noise15 ?? 0)) * 0.25;
    const reserve = expectedGrossMove === null
      ? null
      : this.config.estimatedRoundTripCostBps +
        Math.max(0, spreadBps ?? 0) +
        Math.max(0, noise15 ?? 0) * 0.75;
    const conservativeEdge = expectedGrossMove === null || reserve === null
      ? null
      : expectedGrossMove - reserve;
    const actionable =
      ready &&
      directionalAction !== "NOTHING" &&
      expectedGrossMove !== null &&
      expectedGrossMove >= this.config.minimumGrossMoveBps &&
      conservativeEdge !== null &&
      conservativeEdge >= this.config.minimumConservativeEdgeBps;

    const state: OpportunityState = this.latestEventTime === null
      ? "warming"
      : marketAgeMs !== null && marketAgeMs > this.config.maximumMarketAgeMs
        ? "stale"
        : actionable
          ? "actionable"
          : ready
            ? "ready"
            : "warming";
    const action: OpportunityAction = actionable ? directionalAction : "NOTHING";
    const invalidationDistance = action === "NOTHING"
      ? null
      : clamp(
          Math.max((noise15 ?? 0) * 1.5, (spreadBps ?? 0) * 3, 8),
          8,
          60,
        );
    const objectiveDistance = invalidationDistance === null || expectedGrossMove === null
      ? null
      : clamp(
          Math.max(expectedGrossMove, invalidationDistance * 1.5),
          invalidationDistance * 1.25,
          120,
        );
    const stopPrice = markPrice === null || invalidationDistance === null
      ? null
      : action === "ENTER_LONG"
        ? markPrice * (1 - invalidationDistance / 10_000)
        : markPrice * (1 + invalidationDistance / 10_000);
    const targetPrice = markPrice === null || objectiveDistance === null
      ? null
      : action === "ENTER_LONG"
        ? markPrice * (1 + objectiveDistance / 10_000)
        : markPrice * (1 - objectiveDistance / 10_000);

    const core = {
      baseline_version: "microstructure-baseline.v1" as const,
      state,
      actionable,
      action,
      market: {
        mark_price: rounded(markPrice, 2),
        index_price: rounded(indexPrice, 2),
        best_bid: rounded(top?.bid ?? null, 2),
        best_ask: rounded(top?.ask ?? null, 2),
        spread_bps: rounded(spreadBps, 4),
        funding_rate: rounded(fundingRate, 10),
        market_age_ms: marketAgeMs,
      },
      evidence: {
        trades_15s: short.length,
        trades_60s: long.length,
        trade_rate_15s: rounded(short.length / 15, 4) ?? 0,
        buy_notional_15s: rounded(shortFlow.buyNotional, 2) ?? 0,
        sell_notional_15s: rounded(shortFlow.sellNotional, 2) ?? 0,
        flow_imbalance_15s: rounded(shortFlow.imbalance, 6) ?? 0,
        flow_imbalance_60s: rounded(longFlow.imbalance, 6) ?? 0,
        book_imbalance_top5: rounded(bookImbalance, 6),
        microprice_edge_bps: rounded(micropriceEdgeBps, 4),
        momentum_15s_bps: rounded(momentum15, 4),
        momentum_60s_bps: rounded(momentum60, 4),
        range_15s_bps: rounded(range15, 4),
        noise_15s_bps: rounded(noise15, 4),
        directional_pressure_bps: rounded(directionalPressure, 4),
      },
      economics: {
        expected_gross_move_bps: rounded(expectedGrossMove, 4),
        execution_and_noise_reserve_bps: rounded(reserve, 4),
        conservative_edge_bps: rounded(conservativeEdge, 4),
        minimum_edge_bps: this.config.minimumConservativeEdgeBps,
      },
      geometry: {
        invalidation_distance_bps: rounded(invalidationDistance, 4),
        objective_distance_bps: rounded(objectiveDistance, 4),
        suggested_stop_price: rounded(stopPrice, 2),
        suggested_target_price: rounded(targetPrice, 2),
      },
    };

    return {
      schema_version: "glitch.crypto.opportunity.v1",
      baseline_version: "microstructure-baseline.v1",
      calibrated: false,
      observation_id: bodyHash(core),
      observed_utc: new Date(nowMs).toISOString(),
      state,
      actionable,
      action,
      reason: reasonFor({
        state,
        action,
        conservativeEdge,
        expectedGrossMove,
        trades: short.length,
        requiredTrades: this.config.minimumTrades,
      }),
      market: {
        instrument: "BTCUSDT-PERP",
        ...core.market,
      },
      evidence: core.evidence,
      economics: core.economics,
      geometry: core.geometry,
    };
  }

  private addTrade(event: BinanceAggregateTradeEventSummary): void {
    const price = Number(event.price);
    const quantity = Number(event.quantity);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(quantity) || quantity <= 0) {
      return;
    }
    const notional = price * quantity;
    this.trades.push({
      eventTime: event.event_time,
      price,
      quantity,
      notional,
      signedNotional: event.buyer_is_maker ? -notional : notional,
    });
    this.prune(event.event_time);
  }

  private prune(anchor: number): void {
    const cutoff = anchor - RETENTION_MS;
    let remove = 0;
    while (remove < this.trades.length && this.trades[remove]!.eventTime < cutoff) {
      remove += 1;
    }
    if (remove > 0) {
      this.trades.splice(0, remove);
    }
    if (this.trades.length > MAXIMUM_TRADE_SAMPLES) {
      this.trades.splice(0, this.trades.length - MAXIMUM_TRADE_SAMPLES);
    }
  }
}

function topOfBook(book: BinanceOrderBookView | null): {
  bid: number;
  ask: number;
  bidQuantity: number;
  askQuantity: number;
} | null {
  if (book?.status !== "ready" || !book.best_bid || !book.best_ask) {
    return null;
  }
  const bid = Number(book.best_bid[0]);
  const ask = Number(book.best_ask[0]);
  const bidQuantity = Number(book.best_bid[1]);
  const askQuantity = Number(book.best_ask[1]);
  return Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > bid &&
    Number.isFinite(bidQuantity) && bidQuantity >= 0 &&
    Number.isFinite(askQuantity) && askQuantity >= 0
    ? { bid, ask, bidQuantity, askQuantity }
    : null;
}

function flow(trades: readonly TradeSample[]): {
  buyNotional: number;
  sellNotional: number;
  imbalance: number;
} {
  let buyNotional = 0;
  let sellNotional = 0;
  for (const trade of trades) {
    if (trade.signedNotional >= 0) {
      buyNotional += trade.notional;
    } else {
      sellNotional += trade.notional;
    }
  }
  const total = buyNotional + sellNotional;
  return {
    buyNotional,
    sellNotional,
    imbalance: total > 0 ? (buyNotional - sellNotional) / total : 0,
  };
}

function orderBookImbalance(book: BinanceOrderBookView | null, levels: number): number | null {
  if (book?.status !== "ready") {
    return null;
  }
  const bid = sumQuantities(book.bids.slice(0, levels));
  const ask = sumQuantities(book.asks.slice(0, levels));
  const total = bid + ask;
  return total > 0 ? (bid - ask) / total : null;
}

function sumQuantities(levels: readonly (readonly [string, string])[]): number {
  return levels.reduce((total, level) => total + Math.max(0, Number(level[1]) || 0), 0);
}

function micropriceEdge(
  bid: number,
  ask: number,
  bidQuantity: number,
  askQuantity: number,
): number | null {
  const total = bidQuantity + askQuantity;
  if (total <= 0) {
    return null;
  }
  const mid = (bid + ask) / 2;
  const microprice = (ask * bidQuantity + bid * askQuantity) / total;
  return ((microprice - mid) / mid) * 10_000;
}

function momentumBps(trades: readonly TradeSample[]): number | null {
  const first = trades[0]?.price;
  const last = trades.at(-1)?.price;
  return first && last ? ((last - first) / first) * 10_000 : null;
}

function rangeBps(trades: readonly TradeSample[]): number | null {
  if (trades.length < 2) {
    return null;
  }
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (const trade of trades) {
    minimum = Math.min(minimum, trade.price);
    maximum = Math.max(maximum, trade.price);
  }
  const last = trades.at(-1)!.price;
  return ((maximum - minimum) / last) * 10_000;
}

function localNoiseBps(
  trades: readonly TradeSample[],
  spreadBps: number | null,
): number | null {
  if (trades.length < 3) {
    return spreadBps;
  }
  const absoluteReturns: number[] = [];
  for (let index = 1; index < trades.length; index += 1) {
    const previous = trades[index - 1]!.price;
    const current = trades[index]!.price;
    absoluteReturns.push(Math.abs((current - previous) / previous) * 10_000);
  }
  absoluteReturns.sort((left, right) => left - right);
  const median = absoluteReturns[Math.floor(absoluteReturns.length / 2)] ?? 0;
  const range = rangeBps(trades) ?? 0;
  return Math.max(spreadBps ?? 0, median * 2.5, range * 0.18);
}

function weightedPressure(input: {
  momentum15: number;
  momentum60: number;
  flow15: number;
  flow60: number;
  bookImbalance: number;
  micropriceEdgeBps: number;
}): number {
  return input.momentum15 * 0.55 +
    input.momentum60 * 0.2 +
    input.flow15 * 8 +
    input.flow60 * 4 +
    input.bookImbalance * 6 +
    input.micropriceEdgeBps * 0.6;
}

function lastPrice(trades: readonly TradeSample[]): number | null {
  return trades.at(-1)?.price ?? null;
}

function finitePositive(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rounded(value: number | null | undefined, digits: number): number | null {
  return value === null || value === undefined || !Number.isFinite(value)
    ? null
    : Number(value.toFixed(digits));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function reasonFor(input: {
  state: OpportunityState;
  action: OpportunityAction;
  conservativeEdge: number | null;
  expectedGrossMove: number | null;
  trades: number;
  requiredTrades: number;
}): string {
  if (input.state === "warming") {
    return `Warming market evidence: ${input.trades}/${input.requiredTrades} required recent trades.`;
  }
  if (input.state === "stale") {
    return "Market evidence is stale; no new exposure is supported.";
  }
  if (input.action === "NOTHING") {
    return "Current movement does not retain positive conservative edge after noise and execution costs.";
  }
  return `${input.action} baseline: expected gross move ${rounded(input.expectedGrossMove, 2)} bps, conservative edge ${rounded(input.conservativeEdge, 2)} bps after noise and costs.`;
}

function requireInteger(value: number, minimum: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
}

function requireFinite(value: number, minimum: number, maximum: number, name: string): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
}
