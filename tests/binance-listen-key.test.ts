import test from "node:test";
import assert from "node:assert/strict";
import { BinanceUsdmListenKeyClient } from "../src/venue/binance-usdm/listen-key-client.js";

test("listen-key lifecycle is isolated to the user-stream endpoint", async () => {
  const calls: Array<{ method: string; path: string; apiKey: string | null; signature: string | null }> = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const headers = new Headers(init?.headers);
    calls.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      apiKey: headers.get("X-MBX-APIKEY"),
      signature: url.searchParams.get("signature"),
    });
    const payload = init?.method === "POST" ? { listenKey: "listen-key-value" } : {};
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;

  const client = new BinanceUsdmListenKeyClient({
    baseUrl: "https://fapi.example.test",
    apiKey: "read-only-key",
    fetchImpl: fakeFetch,
  });
  assert.equal(await client.create(), "listen-key-value");
  await client.keepAlive();
  await client.close();

  assert.deepEqual(calls.map((call) => call.method), ["POST", "PUT", "DELETE"]);
  assert.equal(calls.every((call) => call.path === "/fapi/v1/listenKey"), true);
  assert.equal(calls.every((call) => call.apiKey === "read-only-key"), true);
  assert.equal(calls.every((call) => call.signature === null), true);
});

test("listen-key failures never expose the configured API key", async () => {
  const client = new BinanceUsdmListenKeyClient({
    baseUrl: "https://fapi.example.test",
    apiKey: "read-only-key",
    fetchImpl: (async () => new Response(JSON.stringify({ msg: "read-only-key rejected" }), { status: 401 })) as typeof fetch,
  });
  await assert.rejects(
    () => client.create(),
    (error: unknown) => error instanceof Error && !error.message.includes("read-only-key") && error.message.includes("[REDACTED]"),
  );
});
