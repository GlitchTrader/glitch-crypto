import test from "node:test";
import assert from "node:assert/strict";
import { BinanceUsdmShadowClient } from "../src/venue/binance-usdm/shadow-client.js";

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

test("shadow capture uses only approved GET endpoints and never emits credentials", async () => {
  const calls: Array<{ url: string; method: string; apiKey: string | null }> = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const headers = new Headers(init?.headers);
    calls.push({
      url: url.toString(),
      method: init?.method ?? "GET",
      apiKey: headers.get("X-MBX-APIKEY"),
    });
    const publicResponses: Record<string, unknown> = {
      "/fapi/v1/time": { serverTime: 1_700_000_000_100 },
      "/fapi/v1/exchangeInfo": exchangeInfo,
      "/fapi/v1/ticker/bookTicker": { symbol: "BTCUSDT", bidPrice: "60000", askPrice: "60000.1" },
      "/fapi/v1/depth": { lastUpdateId: 100, bids: [["60000", "1"]], asks: [["60000.1", "1"]] },
      "/fapi/v1/premiumIndex": { symbol: "BTCUSDT", markPrice: "60000.05" },
    };
    const privateResponses: Record<string, unknown> = {
      "/fapi/v3/balance": [{ asset: "USDT", balance: "1000" }],
      "/fapi/v3/positionRisk": [],
      "/fapi/v1/openOrders": [],
      "/fapi/v1/commissionRate": { symbol: "BTCUSDT", makerCommissionRate: "0.0002", takerCommissionRate: "0.0005" },
      "/fapi/v1/positionSide/dual": { dualSidePosition: false },
      "/fapi/v1/multiAssetsMargin": { multiAssetsMargin: false },
      "/fapi/v1/symbolConfig": [{ symbol: "BTCUSDT", marginType: "ISOLATED", leverage: 3 }],
      "/fapi/v1/accountConfig": { feeTier: 0, canTrade: true },
    };
    const payload = publicResponses[url.pathname] ?? privateResponses[url.pathname];
    if (payload === undefined) {
      return new Response(JSON.stringify({ code: -1, msg: "unexpected endpoint" }), { status: 404 });
    }
    if (url.pathname in privateResponses) {
      assert.equal(headers.get("X-MBX-APIKEY"), "read-only-key");
      assert.ok(url.searchParams.get("signature"));
      assert.ok(url.searchParams.get("timestamp"));
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const client = new BinanceUsdmShadowClient({
    baseUrl: "https://fapi.example.test",
    symbol: "BTCUSDT",
    apiKey: "read-only-key",
    apiSecret: "read-only-secret",
    now: () => 1_700_000_000_000,
    fetchImpl: fakeFetch,
  });
  const evidence = await client.capture(true);
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes("read-only-key"), false);
  assert.equal(serialized.includes("read-only-secret"), false);
  assert.equal(evidence.mutation_authority, false);
  assert.equal(evidence.credential_mode, "read_only_authenticated");
  assert.equal(calls.every((call) => call.method === "GET"), true);
  assert.equal(calls.some((call) => new URL(call.url).pathname.includes("order") && new URL(call.url).pathname !== "/fapi/v1/openOrders"), false);
});

test("the signed client rejects every endpoint outside the explicit read-only allowlist", async () => {
  const client = new BinanceUsdmShadowClient({
    baseUrl: "https://fapi.example.test",
    apiKey: "read-only-key",
    apiSecret: "read-only-secret",
    fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch,
  });
  await assert.rejects(() => client.signedGet("/fapi/v1/order", { symbol: "BTCUSDT" }));
});

test("approved public raw responses preserve exact text and request provenance", async () => {
  const exact = '{ "lastUpdateId":100,"bids":[["60000","1"]],"asks":[["60001","1"]] }';
  const client = new BinanceUsdmShadowClient({
    baseUrl: "https://demo-fapi.binance.com",
    symbol: "BTCUSDT",
    now: () => 1_700_000_000_500,
    monotonicClock: () => 2_000_000n,
    fetchImpl: (async () => new Response(exact, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch,
  });

  const raw = await client.publicGetRaw("/fapi/v1/depth", {
    symbol: "BTCUSDT",
    limit: 1_000,
  });
  assert.equal(raw.raw_response, exact);
  assert.equal(raw.method, "GET");
  assert.equal(raw.origin, "https://demo-fapi.binance.com");
  assert.equal(raw.path, "/fapi/v1/depth");
  assert.equal(raw.query, "limit=1000&symbol=BTCUSDT");
  assert.equal(raw.http_status, 200);
  assert.equal(raw.local_receive_timestamp_ms, 1_700_000_000_500);
  assert.equal(raw.monotonic_receive_ns, "2000000");
  await assert.rejects(
    () => client.publicGetRaw("/fapi/v1/order", { symbol: "BTCUSDT" }),
    /not approved/,
  );
});
