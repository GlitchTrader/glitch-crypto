import test from "node:test";
import assert from "node:assert/strict";
import {
  compileBinanceUsdmExecutionContext,
  type CompileBinanceUsdmExecutionContextInput,
} from "../src/venue/binance-usdm/execution-context.js";
import type { BinanceMarketStreamRecorderStatus } from "../src/venue/binance-usdm/market-stream-recorder.js";
import type { BinanceUsdmStreamSupervisorStatus } from "../src/venue/binance-usdm/stream-supervisor.js";
import type { BinanceUsdmTestnetPreflightReport } from "../src/venue/binance-usdm/testnet-preflight.js";

const NOW = 1_800_000_000_000;

test("coherent fresh Testnet truths compile to immutable non-authorizing readiness", () => {
  const context = compileBinanceUsdmExecutionContext(readyInput());

  assert.equal(context.status, "ready");
  assert.deepEqual(context.blockers, []);
  assert.equal(context.mutation_authority, false);
  assert.equal(context.engine_binding_authority, false);
  assert.equal(
    context.preconditions_satisfied_for_bounded_testnet_entry_exercise,
    true,
  );
  assert.equal(context.account.wallet_balance, "1000.00");
  assert.equal(context.account.available_balance, "950.00");
  assert.equal(context.market.mark_price, "60000.10");
  assert.equal(context.market.best_bid, "60000.00");
  assert.equal(context.contract.market_quantity_step, "0.001");
  assert.equal(context.capabilities.partial_reduction, true);
  assert.equal(context.capabilities.stop_replacement, true);
  assert.equal(context.capabilities.owned_position_full_close, true);
  assert.equal(context.capabilities.native_algo_amendment, false);
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.account), true);
  assert.equal(Object.isFrozen(context.blockers), true);
});

test("terminal native order history is not treated as open exposure", () => {
  const input = readyInput();
  input.streams.private.account.orders.push({
    symbol: "BTCUSDT",
    order_id: 42,
    client_order_id: "glitch-finished-entry",
    side: "BUY",
    position_side: "BOTH",
    order_type: "MARKET",
    status: "FILLED",
    time_in_force: "GTC",
    original_quantity: "0.001",
    filled_quantity: "0.001",
    average_price: "60000.00",
    stop_price: "0",
    reduce_only: false,
    close_position: false,
    execution_type: "TRADE",
    trade_id: 9,
    update_time: NOW - 900,
  });

  const context = compileBinanceUsdmExecutionContext(input);
  assert.equal(context.status, "ready");
  assert.equal(context.account.active_order_count, 0);
});

test("runtime deficiencies produce stable fail-closed blocker codes", () => {
  const cases: Array<{
    blocker: string;
    mutate(input: CompileBinanceUsdmExecutionContextInput): void;
  }> = [
    {
      blocker: "authenticated_testnet_preflight_not_ready",
      mutate: ({ preflight }) => { preflight.status = "blocked"; },
    },
    {
      blocker: "preflight_stale",
      mutate: ({ preflight }) => { preflight.observed_utc = new Date(NOW - 300_001).toISOString(); },
    },
    {
      blocker: "runtime_symbol_mismatch",
      mutate: ({ market }) => { market.symbol = "ETHUSDT"; },
    },
    {
      blocker: "unsupported_execution_symbol",
      mutate: ({ preflight, streams, market }) => {
        preflight.symbol = "ETHUSDT";
        streams.symbol = "ETHUSDT";
        streams.public.order_book.symbol = "ETHUSDT";
        market.symbol = "ETHUSDT";
        if (market.last_mark_price) {
          market.last_mark_price.symbol = "ETHUSDT";
        }
        if (market.last_aggregate_trade) {
          market.last_aggregate_trade.symbol = "ETHUSDT";
        }
      },
    },
    {
      blocker: "stream_supervisor_not_running",
      mutate: ({ streams }) => { streams.desired_running = false; },
    },
    {
      blocker: "public_depth_lane_not_running",
      mutate: ({ streams }) => { streams.public.state = "backoff"; },
    },
    {
      blocker: "public_order_book_not_ready",
      mutate: ({ streams }) => { streams.public.order_book.status = "gapped"; },
    },
    {
      blocker: "depth_stale",
      mutate: ({ streams }) => { streams.public.order_book.event_time = NOW - 5_001; },
    },
    {
      blocker: "public_order_book_crossed",
      mutate: ({ streams }) => { streams.public.order_book.best_bid = ["60002", "1"]; },
    },
    {
      blocker: "public_market_lane_not_running",
      mutate: ({ market }) => { market.state = "backoff"; },
    },
    {
      blocker: "mark_price_stale",
      mutate: ({ market }) => {
        if (market.last_mark_price) {
          market.last_mark_price.event_time = NOW - 5_001;
        }
      },
    },
    {
      blocker: "aggregate_trade_stale",
      mutate: ({ market }) => {
        if (market.last_aggregate_trade) {
          market.last_aggregate_trade.event_time = NOW - 5_001;
        }
      },
    },
    {
      blocker: "private_stream_not_enabled",
      mutate: ({ streams }) => { streams.private.enabled = false; },
    },
    {
      blocker: "private_stream_not_running",
      mutate: ({ streams }) => { streams.private.state = "backoff"; },
    },
    {
      blocker: "private_stream_expired",
      mutate: ({ streams }) => { streams.private.account.stream_expired = true; },
    },
    {
      blocker: "private_reconciliation_stale",
      mutate: ({ streams }) => {
        streams.private.account.last_reconciliation_time = NOW - 60_001;
      },
    },
    {
      blocker: "positive_reconciled_usdt_available_balance_not_proven",
      mutate: ({ streams }) => {
        const balance = streams.private.account.balances[0];
        if (balance) {
          balance.available_balance = null;
        }
      },
    },
    {
      blocker: "preexisting_native_exposure_present",
      mutate: ({ streams }) => {
        const position = streams.private.account.positions[0];
        if (position) {
          position.quantity = "0.001";
        }
      },
    },
    {
      blocker: "preexisting_active_native_orders_present",
      mutate: ({ streams }) => {
        streams.private.account.orders.push(activeOrder());
      },
    },
  ];

  for (const item of cases) {
    const input = readyInput();
    item.mutate(input);
    const context = compileBinanceUsdmExecutionContext(input);
    assert.equal(context.status, "blocked", item.blocker);
    assert.equal(context.blockers.includes(item.blocker), true, item.blocker);
    assert.equal(
      context.preconditions_satisfied_for_bounded_testnet_entry_exercise,
      false,
      item.blocker,
    );
  }
});

test("freshness policy rejects invalid bounds before compilation", () => {
  const input = readyInput();
  input.freshness = { depth_max_age_ms: 0 };
  assert.throws(
    () => compileBinanceUsdmExecutionContext(input),
    /depth maximum age/,
  );
});

function readyInput(): CompileBinanceUsdmExecutionContextInput {
  return {
    preflight: readyPreflight(),
    streams: readyStreams(),
    market: readyMarket(),
    observedAtMs: NOW,
  };
}

function readyPreflight(): BinanceUsdmTestnetPreflightReport {
  return {
    schema_version: "glitch.crypto.binance-usdm-testnet-preflight.v1",
    venue: "binance-usdm",
    environment: "testnet",
    mutation_authority: false,
    status: "ready",
    symbol: "BTCUSDT",
    maximum_leverage: 3,
    observed_utc: new Date(NOW - 1_000).toISOString(),
    account: {
      one_way_mode: true,
      multi_asset_mode: false,
      margin_type: "ISOLATED",
      leverage: 3,
      auto_add_margin: false,
      can_trade: true,
      wallet_balance: "1000.00",
      available_balance: "950.00",
      maker_commission_rate: "0.0002",
      taker_commission_rate: "0.0005",
      open_position_count: 0,
      open_order_count: 0,
    },
    contract: {
      tick_size: "0.10",
      market_quantity_step: "0.001",
      market_minimum_quantity: "0.001",
      minimum_notional: "5.00",
      required_order_types_present: true,
    },
    blockers: [],
  };
}

function readyStreams(): BinanceUsdmStreamSupervisorStatus {
  return {
    schema_version: "glitch.crypto.binance-usdm-stream-status.v1",
    desired_running: true,
    mutation_authority: false,
    symbol: "BTCUSDT",
    public: {
      state: "running",
      epoch: 1,
      reconnect_attempt: 0,
      order_book: {
        schema_version: "glitch.crypto.binance-usdm-order-book.v1",
        status: "ready",
        symbol: "BTCUSDT",
        update_id: 101,
        event_time: NOW - 500,
        transaction_time: NOW - 501,
        best_bid: ["60000.00", "1.00"],
        best_ask: ["60000.20", "1.00"],
        bids: [["60000.00", "1.00"]],
        asks: [["60000.20", "1.00"]],
        buffered_events: 0,
        gap_reason: null,
      },
    },
    private: {
      enabled: true,
      state: "running",
      epoch: 1,
      reconnect_attempt: 0,
      buffered_events: 0,
      account: {
        schema_version: "glitch.crypto.binance-usdm-private-state.v2",
        stream_expired: false,
        last_event_time: NOW - 600,
        last_transaction_time: NOW - 601,
        last_reconciliation_time: NOW - 1_000,
        balances: [{
          asset: "USDT",
          wallet_balance: "1000.00",
          cross_wallet_balance: "1000.00",
          available_balance: "950.00",
          balance_change: null,
        }],
        positions: [{
          symbol: "BTCUSDT",
          position_side: "BOTH",
          quantity: "0",
          entry_price: "0",
          break_even_price: null,
          realized_pnl: null,
          unrealized_pnl: "0",
          margin_type: "isolated",
          isolated_wallet: "0",
        }],
        orders: [],
        applied_event_count: 0,
      },
    },
  };
}

function readyMarket(): BinanceMarketStreamRecorderStatus {
  return {
    schema_version: "glitch.crypto.binance-usdm-market-recorder-status.v2",
    desired_running: true,
    mutation_authority: false,
    symbol: "BTCUSDT",
    state: "running",
    epoch: 1,
    reconnect_attempt: 0,
    aggregate_trade_messages: 1,
    mark_price_messages: 1,
    last_aggregate_trade_id: 55,
    last_aggregate_trade_event_time: NOW - 400,
    last_mark_price_event_time: NOW - 300,
    last_aggregate_trade: {
      event_type: "aggTrade",
      event_time: NOW - 400,
      symbol: "BTCUSDT",
      aggregate_trade_id: 55,
      price: "60000.00",
      quantity: "0.001",
      first_trade_id: 70,
      last_trade_id: 70,
      trade_time: NOW - 401,
      buyer_is_maker: false,
    },
    last_mark_price: {
      event_type: "markPriceUpdate",
      event_time: NOW - 300,
      symbol: "BTCUSDT",
      mark_price: "60000.10",
      index_price: "60000.00",
      estimated_settlement_price: "0",
      funding_rate: "0.0001",
      next_funding_time: NOW + 60_000,
    },
  };
}

function activeOrder() {
  return {
    symbol: "BTCUSDT",
    order_id: 99,
    client_order_id: "glitch-active-stop",
    side: "SELL",
    position_side: "BOTH",
    order_type: "STOP_MARKET",
    status: "NEW",
    time_in_force: "GTC",
    original_quantity: "0.001",
    filled_quantity: "0",
    average_price: "0",
    stop_price: "59000",
    reduce_only: true,
    close_position: false,
    execution_type: "NEW",
    trade_id: null,
    update_time: NOW - 900,
  };
}
