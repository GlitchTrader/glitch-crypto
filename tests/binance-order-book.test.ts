import test from "node:test";
import assert from "node:assert/strict";
import { BinanceUsdmOrderBook } from "../src/venue/binance-usdm/order-book.js";

test("buffered depth deltas join a REST snapshot and preserve best levels", () => {
  const book = new BinanceUsdmOrderBook();
  assert.equal(book.ingest({
    U: 101,
    u: 102,
    pu: 100,
    s: "BTCUSDT",
    E: 10,
    T: 9,
    b: [["99.0", "2.0"], ["98.0", "0"]],
    a: [["101.0", "0"], ["102.0", "3.0"]],
  }), "buffered");

  const view = book.loadSnapshot({
    lastUpdateId: 100,
    bids: [["99.0", "1.0"], ["98.0", "4.0"]],
    asks: [["101.0", "1.5"], ["103.0", "2.0"]],
  });
  assert.equal(view.status, "ready");
  assert.equal(view.update_id, 102);
  assert.deepEqual(view.best_bid, ["99.0", "2.0"]);
  assert.deepEqual(view.best_ask, ["102.0", "3.0"]);
  assert.equal(view.bids.some(([price]) => price === "98.0"), false);
});

test("duplicates are ignored and pu continuity gaps invalidate the book", () => {
  const book = new BinanceUsdmOrderBook();
  book.loadSnapshot({ lastUpdateId: 200, bids: [["100", "1"]], asks: [["101", "1"]] });
  assert.equal(book.ingest({ U: 201, u: 201, pu: 200, b: [["100", "2"]], a: [] }), "applied");
  assert.equal(book.ingest({ U: 201, u: 201, pu: 200, b: [], a: [] }), "ignored");
  assert.equal(book.ingest({ U: 202, u: 202, pu: 199, b: [], a: [] }), "gapped");
  const view = book.view();
  assert.equal(view.status, "gapped");
  assert.match(view.gap_reason ?? "", /previous_update_mismatch/);
});
