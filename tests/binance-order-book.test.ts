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

test("USD-M Futures accepts pu continuity even when update IDs are not consecutive", () => {
  const book = new BinanceUsdmOrderBook();
  book.loadSnapshot({
    lastUpdateId: 410_618_541_984,
    bids: [["60000", "1"]],
    asks: [["60001", "1"]],
  });

  assert.equal(book.ingest({
    U: 410_618_550_946,
    u: 410_618_551_612,
    pu: 410_618_541_984,
    s: "BTCUSDT",
    b: [["60000", "2"]],
    a: [],
  }), "applied");
  assert.equal(book.ingest({
    U: 410_618_552_999,
    u: 410_618_553_111,
    pu: 410_618_551_612,
    s: "BTCUSDT",
    b: [],
    a: [["60001", "3"]],
  }), "applied");

  const view = book.view();
  assert.equal(view.status, "ready");
  assert.equal(view.update_id, 410_618_553_111);
  assert.deepEqual(view.best_bid, ["60000", "2"]);
  assert.deepEqual(view.best_ask, ["60001", "3"]);
});

test("the first Futures delta may overlap the snapshot while older buffered deltas are ignored", () => {
  const book = new BinanceUsdmOrderBook();
  assert.equal(book.ingest({
    U: 410_618_534_079,
    u: 410_618_534_079,
    pu: 410_618_533_020,
    s: "BTCUSDT",
    b: [["59999", "2"]],
    a: [],
  }), "buffered");

  const snapshot = book.loadSnapshot({
    lastUpdateId: 410_618_535_686,
    bids: [["60000", "1"]],
    asks: [["60001", "1"]],
  });
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.update_id, 410_618_535_686);

  assert.equal(book.ingest({
    U: 410_618_535_686,
    u: 410_618_536_369,
    pu: 410_618_534_079,
    s: "BTCUSDT",
    b: [["60000", "2"]],
    a: [["60001", "0"], ["60002", "1"]],
  }), "applied");

  const view = book.view();
  assert.equal(view.status, "ready");
  assert.equal(view.update_id, 410_618_536_369);
  assert.deepEqual(view.best_bid, ["60000", "2"]);
  assert.deepEqual(view.best_ask, ["60002", "1"]);
});

test("the first post-snapshot delta must overlap or explicitly follow the snapshot", () => {
  const book = new BinanceUsdmOrderBook();
  book.loadSnapshot({
    lastUpdateId: 100,
    bids: [["99", "1"]],
    asks: [["101", "1"]],
  });

  assert.equal(book.ingest({
    U: 110,
    u: 111,
    pu: 109,
    s: "BTCUSDT",
    b: [],
    a: [],
  }), "gapped");
  assert.match(book.view().gap_reason ?? "", /snapshot_update_gap/);
});

test("a symbol change invalidates the synchronized book", () => {
  const book = new BinanceUsdmOrderBook();
  book.loadSnapshot({ lastUpdateId: 100, bids: [["99", "1"]], asks: [["101", "1"]] });
  assert.equal(book.ingest({
    U: 100,
    u: 101,
    pu: 99,
    s: "BTCUSDT",
    b: [],
    a: [],
  }), "applied");
  assert.equal(book.ingest({
    U: 102,
    u: 102,
    pu: 101,
    s: "ETHUSDT",
    b: [],
    a: [],
  }), "gapped");
  assert.match(book.view().gap_reason ?? "", /symbol_changed/);
});
