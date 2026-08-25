import test from "node:test";
import assert from "node:assert/strict";
import { BinanceUsdmPrivateState } from "../src/venue/binance-usdm/private-state.js";

test("private account and order events are attributable and idempotent", () => {
  const state = new BinanceUsdmPrivateState();
  const accountEvent = {
    e: "ACCOUNT_UPDATE",
    E: 1000,
    T: 999,
    a: {
      B: [{ a: "USDT", wb: "1000.00", cw: "900.00", bc: "5.00" }],
      P: [{ s: "BTCUSDT", ps: "BOTH", pa: "0.010", ep: "60000.0", bep: "60005.0", cr: "0", up: "2.5", mt: "isolated", iw: "200" }],
    },
  };
  assert.equal(state.apply(accountEvent), "applied");
  assert.equal(state.apply(accountEvent), "duplicate");

  assert.equal(state.apply({
    e: "ORDER_TRADE_UPDATE",
    E: 1001,
    T: 1001,
    o: {
      s: "BTCUSDT",
      i: 42,
      c: "glitch-entry-1",
      S: "BUY",
      ps: "BOTH",
      o: "MARKET",
      X: "FILLED",
      f: "GTC",
      q: "0.010",
      z: "0.010",
      ap: "60000.0",
      sp: "0",
      R: false,
      cp: false,
      x: "TRADE",
      t: 9,
    },
  }), "applied");

  const view = state.view();
  assert.equal(view.applied_event_count, 2);
  assert.equal(view.balances[0]?.wallet_balance, "1000.00");
  assert.equal(view.balances[0]?.available_balance, null);
  assert.equal(view.positions[0]?.quantity, "0.010");
  assert.equal(view.orders[0]?.client_order_id, "glitch-entry-1");
});

test("REST reconciliation reconstructs private state after restart", () => {
  const state = new BinanceUsdmPrivateState();
  const view = state.reconcile({
    observedAt: 2000,
    balances: [{
      asset: "USDT",
      balance: "995.00",
      crossWalletBalance: "995.00",
      availableBalance: "990.00",
    }],
    positions: [{ symbol: "BTCUSDT", positionSide: "BOTH", positionAmt: "0", entryPrice: "0", unRealizedProfit: "0", marginType: "isolated", isolatedWallet: "0" }],
    openOrders: [{
      symbol: "BTCUSDT",
      orderId: 7,
      clientOrderId: "glitch-stop-1",
      side: "SELL",
      positionSide: "BOTH",
      type: "STOP_MARKET",
      status: "NEW",
      timeInForce: "GTC",
      origQty: "0.010",
      executedQty: "0",
      avgPrice: "0",
      stopPrice: "59000",
      reduceOnly: true,
      closePosition: false,
      updateTime: 1999,
    }],
  });
  assert.equal(view.last_transaction_time, null);
  assert.equal(view.last_reconciliation_time, 2000);
  assert.equal(view.balances[0]?.available_balance, "990.00");
  assert.equal(view.orders[0]?.reduce_only, true);
  assert.equal(view.stream_expired, false);

  state.apply({
    e: "ACCOUNT_UPDATE",
    E: 2001,
    T: 2001,
    a: {
      B: [{ a: "USDT", wb: "996.00", cw: "996.00", bc: "1.00" }],
      P: [],
    },
  });
  assert.equal(state.view().balances[0]?.available_balance, null);
});
