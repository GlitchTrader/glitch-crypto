import test from "node:test";
import assert from "node:assert/strict";
import { BinanceUsdmShadowClient, type BinanceUsdmShadowEvidence } from "../src/venue/binance-usdm/shadow-client.js";
import {
  BinanceUsdmTestnetPreflight,
  evaluateBinanceUsdmTestnetPreflight,
} from "../src/venue/binance-usdm/testnet-preflight.js";

test("authenticated Testnet evidence is ready only inside the bounded account envelope", () => {
  const report = evaluateBinanceUsdmTestnetPreflight(readyEvidence(), 3);

  assert.equal(report.status, "ready");
  assert.deepEqual(report.blockers, []);
  assert.equal(report.mutation_authority, false);
  assert.equal(report.account.one_way_mode, true);
  assert.equal(report.account.margin_type, "ISOLATED");
  assert.equal(report.account.leverage, 3);
  assert.equal(report.account.auto_add_margin, false);
  assert.equal(report.contract.required_order_types_present, true);
});

test("preflight reports every unsafe account condition without changing it", () => {
  const evidence = readyEvidence();
  const privateEvidence = evidence.private;
  if (privateEvidence === null) {
    throw new Error("ready fixture must contain private evidence");
  }
  privateEvidence.position_mode = { dualSidePosition: true };
  privateEvidence.multi_asset_mode = { multiAssetsMargin: true };
  privateEvidence.symbol_configuration = [{
    symbol: "BTCUSDT",
    marginType: "CROSSED",
    leverage: 20,
    isAutoAddMargin: true,
  }];
  privateEvidence.account_configuration = { canTrade: false };
  privateEvidence.balances = [{ asset: "USDT", balance: "1000", availableBalance: "0" }];
  privateEvidence.positions = [{ symbol: "BTCUSDT", positionAmt: "0.002" }];
  privateEvidence.open_orders = [{ symbol: "BTCUSDT", orderId: 99 }];

  const report = evaluateBinanceUsdmTestnetPreflight(evidence, 3);

  assert.equal(report.status, "blocked");
  assert.deepEqual(report.blockers, [
    "account_trading_permission_not_proven",
    "auto_add_margin_disabled_not_proven",
    "isolated_margin_not_proven",
    "leverage_exceeds_or_lacks_configured_ceiling",
    "one_way_position_mode_not_proven",
    "positive_available_usdt_balance_not_proven",
    "preexisting_open_orders_present",
    "preexisting_symbol_exposure_present",
    "single_asset_margin_mode_not_proven",
  ]);
});

test("authenticated preflight rejects production before transport", () => {
  let transported = false;
  const client = new BinanceUsdmShadowClient({
    baseUrl: "https://fapi.binance.com",
    apiKey: "test-key",
    apiSecret: "test-secret",
    fetchImpl: (async () => {
      transported = true;
      return new Response("{}");
    }) as typeof fetch,
  });

  assert.throws(() => new BinanceUsdmTestnetPreflight(client));
  assert.equal(transported, false);
});

test("authenticated preflight rejects missing credentials before transport", () => {
  let transported = false;
  const client = new BinanceUsdmShadowClient({
    baseUrl: "https://demo-fapi.binance.com",
    fetchImpl: (async () => {
      transported = true;
      return new Response("{}");
    }) as typeof fetch,
  });

  assert.throws(() => new BinanceUsdmTestnetPreflight(client));
  assert.equal(transported, false);
});

test("public-only evidence never passes authenticated preflight", () => {
  const evidence = readyEvidence();
  evidence.credential_mode = "public_only";
  evidence.private = null;

  const report = evaluateBinanceUsdmTestnetPreflight(evidence);
  assert.equal(report.status, "blocked");
  assert.deepEqual(report.blockers, ["authenticated_testnet_evidence_required"]);
});

test("malformed private snapshots cannot masquerade as flat", () => {
  const evidence = readyEvidence();
  const privateEvidence = evidence.private;
  if (privateEvidence === null) {
    throw new Error("ready fixture must contain private evidence");
  }
  privateEvidence.positions = {};
  privateEvidence.open_orders = [null];

  const report = evaluateBinanceUsdmTestnetPreflight(evidence);
  assert.equal(report.status, "blocked");
  assert.equal(report.blockers.includes("position_snapshot_contract_invalid"), true);
  assert.equal(report.blockers.includes("open_order_snapshot_contract_invalid"), true);
});

function readyEvidence(): BinanceUsdmShadowEvidence {
  return {
    schema_version: "glitch.crypto.binance-usdm-shadow-evidence.v1",
    venue: "binance-usdm",
    symbol: "BTCUSDT",
    base_url_origin: "https://demo-fapi.binance.com",
    mutation_authority: false,
    credential_mode: "read_only_authenticated",
    observed_utc: "2026-08-25T01:30:00.000Z",
    public: {
      server_time: 1_700_000_000_000,
      exchange_information: {},
      symbol_rules: {
        schema_version: "glitch.crypto.binance-usdm-symbol-rules.v1",
        venue: "binance-usdm",
        symbol: "BTCUSDT",
        status: "TRADING",
        contract_type: "PERPETUAL",
        base_asset: "BTC",
        quote_asset: "USDT",
        margin_asset: "USDT",
        price_precision: 1,
        quantity_precision: 3,
        tick_size: "0.10",
        minimum_price: "0.10",
        maximum_price: "1000000.00",
        quantity_step: "0.001",
        minimum_quantity: "0.001",
        maximum_quantity: "1000.000",
        market_quantity_step: "0.001",
        market_minimum_quantity: "0.001",
        market_maximum_quantity: "100.000",
        minimum_notional: "5.00000000",
        supported_order_types: ["LIMIT", "MARKET", "STOP_MARKET", "TAKE_PROFIT_MARKET"],
        supported_time_in_force: ["GTC", "IOC", "FOK", "GTX"],
      },
      book_ticker: {},
      depth: {},
      premium_index: {},
    },
    private: {
      balances: [{
        asset: "USDT",
        balance: "1000",
        availableBalance: "1000",
        crossWalletBalance: "1000",
      }],
      positions: [{ symbol: "BTCUSDT", positionAmt: "0" }],
      open_orders: [],
      commission_rate: {
        symbol: "BTCUSDT",
        makerCommissionRate: "0.0002",
        takerCommissionRate: "0.0005",
      },
      position_mode: { dualSidePosition: false },
      multi_asset_mode: { multiAssetsMargin: false },
      symbol_configuration: [{
        symbol: "BTCUSDT",
        marginType: "ISOLATED",
        leverage: 3,
        isAutoAddMargin: false,
      }],
      account_configuration: { feeTier: 0, canTrade: true },
    },
  };
}
