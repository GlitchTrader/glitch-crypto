import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  deriveBinanceUsdmMutationIds,
  deriveBinanceUsdmProtectionRevisionIds,
  subtractPositiveDecimal,
  validateBinanceUsdmProtectedEntry,
  validateBinanceUsdmProtectionRevision,
} from "../src/venue/binance-usdm/mutation-contract.js";
import {
  BinanceUsdmMutationClient,
  InMemoryBinanceUsdmMutationEvidenceSink,
  JsonlBinanceUsdmMutationEvidenceSink,
} from "../src/venue/binance-usdm/mutation-client.js";

const intentId = "123e4567-e89b-42d3-a456-426614174000";
const revisionIntentId = "223e4567-e89b-42d3-a456-426614174000";

test("Binance mutation identities are deterministic, role-specific, and venue-valid", () => {
  const first = deriveBinanceUsdmMutationIds(intentId);
  const second = deriveBinanceUsdmMutationIds(intentId);

  assert.deepEqual(first, second);
  assert.equal(new Set(Object.values(first)).size, 4);
  for (const value of Object.values(first)) {
    assert.equal(value.length, 36);
    assert.match(value, /^[.A-Z:/a-z0-9_-]{1,36}$/);
  }
});

test("protected-entry geometry is canonical and direction owns venue sides", () => {
  const plan = validateBinanceUsdmProtectedEntry({
    intentId,
    symbol: "btcusdt",
    direction: "LONG",
    quantity: "0.0100",
    stopPrice: "59000.00",
    targetPrice: "61000.00",
  });

  assert.equal(plan.symbol, "BTCUSDT");
  assert.equal(plan.entrySide, "BUY");
  assert.equal(plan.exitSide, "SELL");
  assert.equal(plan.quantity, "0.01");
  assert.equal(plan.stopPrice, "59000");
  assert.equal(plan.targetPrice, "61000");
});

test("protection revision identities and remaining quantity are exact", () => {
  const currentIds = deriveBinanceUsdmMutationIds(intentId);
  const plan = validateBinanceUsdmProtectionRevision({
    revisionIntentId,
    current: {
      positionIntentId: intentId,
      symbol: "btcusdt",
      direction: "LONG",
      quantity: "0.0100",
      stopPrice: "59000.00",
      targetPrice: "61000.00",
      stopClientAlgoId: currentIds.stopClientAlgoId,
      targetClientAlgoId: currentIds.targetClientAlgoId,
    },
    reductionQuantity: "0.0035",
    nextStopPrice: "59500.00",
    nextTargetPrice: "61500.00",
  });

  assert.deepEqual(plan.ids, deriveBinanceUsdmProtectionRevisionIds(revisionIntentId));
  assert.equal(new Set(Object.values(plan.ids)).size, 3);
  assert.equal(plan.reductionQuantity, "0.0035");
  assert.equal(plan.remainingQuantity, "0.0065");
  assert.equal(plan.nextStopPrice, "59500");
  assert.equal(plan.exitSide, "SELL");
  assert.equal(subtractPositiveDecimal("1000.00000001", "999.99999999"), "0.00000002");
});

test("protection revision rejects no-op and full-position reduction", () => {
  const currentIds = deriveBinanceUsdmMutationIds(intentId);
  const current = {
    positionIntentId: intentId,
    symbol: "BTCUSDT",
    direction: "LONG" as const,
    quantity: "0.01",
    stopPrice: "59000",
    targetPrice: "61000",
    stopClientAlgoId: currentIds.stopClientAlgoId,
    targetClientAlgoId: currentIds.targetClientAlgoId,
  };
  assert.throws(() => validateBinanceUsdmProtectionRevision({
    revisionIntentId,
    current,
    nextStopPrice: "59000",
    nextTargetPrice: "61000",
  }), /must change/);
  assert.throws(() => validateBinanceUsdmProtectionRevision({
    revisionIntentId,
    current,
    reductionQuantity: "0.01",
    nextStopPrice: "59500",
    nextTargetPrice: "61500",
  }), /strictly smaller/);
});

test("mutation transport rejects production and non-loopback custom origins", () => {
  const evidence = new InMemoryBinanceUsdmMutationEvidenceSink();
  const common = {
    environment: "testnet" as const,
    apiKey: "key",
    apiSecret: "secret",
    evidence,
  };

  assert.throws(() => new BinanceUsdmMutationClient({
    ...common,
    baseUrl: "https://fapi.binance.com",
  }));
  assert.throws(() => new BinanceUsdmMutationClient({
    ...common,
    baseUrl: "https://example.test",
  }));
  const client = new BinanceUsdmMutationClient({
    ...common,
    baseUrl: "http://127.0.0.1:8788",
    fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch,
  });
  assert.equal(client.baseUrl, "http://127.0.0.1:8788");
});

test("mutation evidence is synchronously retained as bounded credential-free JSONL", async () => {
  const path = resolve("artifacts", "tests", "binance-mutation-" + randomUUID() + ".jsonl");
  try {
    const evidence = new JsonlBinanceUsdmMutationEvidenceSink(path, { maxBytes: 16_384 });
    const fakeFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      return url.pathname === "/fapi/v1/time"
        ? new Response(JSON.stringify({ serverTime: 1_700_000_000_100 }), { status: 200 })
        : new Response(JSON.stringify({
            clientOrderId: ids().entryClientOrderId,
            orderId: 1001,
            symbol: "BTCUSDT",
            side: "BUY",
            status: "FILLED",
            executedQty: "0.01",
            avgPrice: "60000",
            reduceOnly: false,
          }), { status: 200 });
    }) as typeof fetch;
    const client = new BinanceUsdmMutationClient({
      environment: "testnet",
      baseUrl: "http://127.0.0.1:8788",
      apiKey: "durable-key",
      apiSecret: "durable-secret",
      evidence,
      now: () => 1_700_000_000_000,
      fetchImpl: fakeFetch,
    });
    await client.synchronizeClock();
    await client.placeMarketEntry({
      symbol: "BTCUSDT",
      side: "BUY",
      quantity: "0.01",
      clientOrderId: ids().entryClientOrderId,
    });

    assert.equal(existsSync(path), true);
    const retained = readFileSync(path, "utf8");
    const records = retained.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.length, 2);
    assert.equal(records[0].phase, "before_transport");
    assert.equal(records[1].phase, "transport_result");
    assert.equal(records[0].session_id, records[1].session_id);
    assert.equal(records[0].sequence, 1);
    assert.equal(records[1].sequence, 2);
    assert.equal(retained.includes("durable-key"), false);
    assert.equal(retained.includes("durable-secret"), false);
    assert.equal(retained.toLowerCase().includes("signature"), false);
  } finally {
    rmSync(path, { force: true });
    rmSync(path + ".1", { force: true });
  }
});

function ids() {
  return deriveBinanceUsdmMutationIds(intentId);
}
