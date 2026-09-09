import test from "node:test";
import assert from "node:assert/strict";
import { completedCandles, describePriceContext } from "../src/runtime/price-context.js";

const rows = Array.from({ length: 61 }, (_, i) => [i * 60_000, 100 + i, 102 + i,
  99 + i, 101 + i, 2, i * 60_000 + 59_999, 2 * (100.5 + i)]);

test("context excludes the live partial and aggregates only complete 5m bars", () => {
  const bars = completedCandles(rows, 60 * 60_000);
  assert.equal(bars.length, 60);
  const context = describePriceContext(bars);
  assert.equal((context.completed_1m as unknown[]).length, 30);
  assert.equal((context.completed_5m as unknown[]).length, 12);
  const last = (context.completed_5m as Record<string, number>[]).at(-1)!;
  assert.equal(last.open, 155);
  assert.equal(last.high, 161);
  assert.equal(last.low, 154);
  assert.equal(last.close, 160);
  assert.equal(context.completed_through_ms, 3_599_999);
});

test("context rejects gaps, reordered bars, and invalid geometry instead of inventing facts", () => {
  assert.throws(() => completedCandles([rows[0], rows[2]], 1_000_000));
  assert.throws(() => completedCandles([[0, 100, 99, 98, 101, 1, 59999, 100]], 60000));
});

test("simple ATR and window VWAP are calculated and labelled explicitly", () => {
  const context = describePriceContext(completedCandles(rows, 3_600_000));
  const window = (context.windows as Record<string, number>[])[1]!;
  assert.equal(window.atr14_simple, 3);
  assert.equal(window.rsi14_simple, 100);
  assert.equal(window.window_vwap, 130);
  assert.equal(window.directional_efficiency, 1);
});
