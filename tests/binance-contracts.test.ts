import test from "node:test";
import assert from "node:assert/strict";
import {
  decimalStringToUnits,
  parseBinanceUsdmSymbolRules,
} from "../src/venue/binance-usdm/contracts.js";

const exchangeInfo = {
  symbols: [{
    symbol: "BTCUSDT",
    status: "TRADING",
    contractType: "PERPETUAL",
    baseAsset: "BTC",
    quoteAsset: "USDT",
    marginAsset: "USDT",
    pricePrecision: 1,
    quantityPrecision: 3,
    orderTypes: ["LIMIT", "MARKET", "STOP_MARKET", "TAKE_PROFIT_MARKET"],
    timeInForce: ["GTC", "IOC", "FOK", "GTX"],
    filters: [
      { filterType: "PRICE_FILTER", minPrice: "0.10", maxPrice: "1000000.00", tickSize: "0.10" },
      { filterType: "LOT_SIZE", minQty: "0.001", maxQty: "1000.000", stepSize: "0.001" },
      { filterType: "MARKET_LOT_SIZE", minQty: "0.001", maxQty: "100.000", stepSize: "0.001" },
      { filterType: "MIN_NOTIONAL", notional: "5.00000000" },
    ],
  }],
};

test("exchange information becomes an exact BTC perpetual precision contract", () => {
  const rules = parseBinanceUsdmSymbolRules(exchangeInfo, "BTCUSDT");
  assert.equal(rules.tick_size, "0.10");
  assert.equal(rules.quantity_step, "0.001");
  assert.equal(rules.minimum_notional, "5.00000000");
  assert.equal(rules.contract_type, "PERPETUAL");
  assert.equal(decimalStringToUnits(rules.quantity_step), 1_000);
});

test("symbol parsing fails closed for non-trading or absent contracts", () => {
  assert.throws(() => parseBinanceUsdmSymbolRules(exchangeInfo, "ETHUSDT"));
  assert.throws(() => parseBinanceUsdmSymbolRules({ symbols: [{ ...exchangeInfo.symbols[0], status: "CLOSE" }] }, "BTCUSDT"));
});
