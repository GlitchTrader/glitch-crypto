import test from "node:test";
import assert from "node:assert/strict";
import { CryptoOpportunityEngine } from "../src/runtime/opportunity-engine.js";
import type { BinanceOrderBookView } from "../src/venue/binance-usdm/order-book.js";

const BASE_TIME = 1_700_000_000_000;

function book(bidQuantity: string, askQuantity: string): BinanceOrderBookView {
  return {
    schema_version: "glitch.crypto.binance-usdm-order-book.v1",
    status: "ready",
    symbol: "BTCUSDT",
    update_id: 1,
    event_time: BASE_TIME,
    transaction_time: BASE_TIME,
    best_bid: ["60000.0", bidQuantity],
    best_ask: ["60000.1", askQuantity],
    bids: [
      ["60000.0", bidQuantity],
      ["59999.9", bidQuantity],
      ["59999.8", bidQuantity],
      ["59999.7", bidQuantity],
      ["59999.6", bidQuantity],
    ],
    asks: [
      ["60000.1", askQuantity],
      ["60000.2", askQuantity],
      ["60000.3", askQuantity],
      ["60000.4", askQuantity],
      ["60000.5", askQuantity],
    ],
    buffered_events: 0,
    gap_reason: null,
  };
}

function engine(costBps = 2): CryptoOpportunityEngine {
  return new CryptoOpportunityEngine({
    minimumTrades: 10,
    minimumDirectionalBps: 1,
    minimumGrossMoveBps: 3,
    minimumConservativeEdgeBps: 0.5,
    estimatedRoundTripCostBps: costBps,
    maximumMarketAgeMs: 3_000,
  });
}

test("live directional flow outside costs and noise produces an actionable long candidate", () => {
  const value = engine();
  value.updateBook(book("12", "2"));
  value.updateMarket({
    event_type: "markPriceUpdate",
    event_time: BASE_TIME + 14_000,
    symbol: "BTCUSDT",
    mark_price: "60054",
    index_price: "60053",
    estimated_settlement_price: "0",
    funding_rate: "0.0001",
    next_funding_time: BASE_TIME + 3_600_000,
  });
  for (let index = 0; index < 20; index += 1) {
    value.updateMarket({
      event_type: "aggTrade",
      event_time: BASE_TIME + index * 700,
      symbol: "BTCUSDT",
      aggregate_trade_id: index + 1,
      price: String(60_000 + index * 3),
      quantity: "0.05",
      first_trade_id: index + 1,
      last_trade_id: index + 1,
      trade_time: BASE_TIME + index * 700,
      buyer_is_maker: false,
    });
  }

  const snapshot = value.snapshot(BASE_TIME + 14_500);
  assert.equal(snapshot.state, "actionable");
  assert.equal(snapshot.actionable, true);
  assert.equal(snapshot.action, "ENTER_LONG");
  assert.ok((snapshot.economics.conservative_edge_bps ?? 0) > 0);
  assert.ok((snapshot.geometry.suggested_target_price ?? 0) > 60_054);
  assert.ok((snapshot.geometry.suggested_stop_price ?? 0) < 60_054);
});

test("mixed micro-movement consumed by friction remains no trade", () => {
  const value = engine(10);
  value.updateBook(book("5", "5"));
  value.updateMarket({
    event_type: "markPriceUpdate",
    event_time: BASE_TIME + 14_000,
    symbol: "BTCUSDT",
    mark_price: "60000",
    index_price: "60000",
    estimated_settlement_price: "0",
    funding_rate: "0",
    next_funding_time: BASE_TIME + 3_600_000,
  });
  for (let index = 0; index < 20; index += 1) {
    value.updateMarket({
      event_type: "aggTrade",
      event_time: BASE_TIME + index * 700,
      symbol: "BTCUSDT",
      aggregate_trade_id: index + 1,
      price: index % 2 === 0 ? "60000.2" : "59999.8",
      quantity: "0.02",
      first_trade_id: index + 1,
      last_trade_id: index + 1,
      trade_time: BASE_TIME + index * 700,
      buyer_is_maker: index % 2 === 0,
    });
  }

  const snapshot = value.snapshot(BASE_TIME + 14_500);
  assert.equal(snapshot.actionable, false);
  assert.equal(snapshot.action, "NOTHING");
  assert.match(snapshot.reason, /does not retain positive conservative edge/);
});
