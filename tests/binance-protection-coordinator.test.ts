import test from "node:test";
import assert from "node:assert/strict";
import { deriveBinanceUsdmMutationIds } from "../src/venue/binance-usdm/mutation-contract.js";
import {
  BinanceUsdmMutationClient,
  InMemoryBinanceUsdmMutationEvidenceSink,
} from "../src/venue/binance-usdm/mutation-client.js";
import { BinanceUsdmProtectionCoordinator } from "../src/venue/binance-usdm/protection-coordinator.js";

const intentId = "123e4567-e89b-42d3-a456-426614174000";
const ids = deriveBinanceUsdmMutationIds(intentId);

interface Scenario {
  entry?: "filled" | "partial" | "execution_unknown";
  entryLookup?: "found" | "not_found";
  stop?: "accepted" | "rejected" | "execution_unknown";
  stopLookup?: "found" | "canceled" | "not_found";
  target?: "accepted" | "rejected";
  targetLookup?: "found" | "canceled" | "not_found";
  close?: "filled" | "execution_unknown";
  closeLookup?: "found" | "not_found";
  stopCancel?: "accepted" | "rejected" | "execution_unknown";
  targetCancel?: "accepted" | "rejected" | "execution_unknown";
}

interface RecordedCall {
  method: string;
  path: string;
  clientId: string | null;
  type: string | null;
  reduceOnly: string | null;
}

test("stop ownership is proven before target submission", async () => {
  const harness = await createHarness({});
  const outcome = await harness.coordinator.createProtectedEntry(entryRequest());

  assert.equal(outcome.state, "open_protected");
  assert.equal(outcome.entry?.executed_quantity, "0.01");
  assert.equal(outcome.stop?.client_algo_id, ids.stopClientAlgoId);
  assert.equal(outcome.target?.client_algo_id, ids.targetClientAlgoId);

  const stopPost = findCall(harness.calls, "POST", ids.stopClientAlgoId);
  const stopQuery = findCall(harness.calls, "GET", ids.stopClientAlgoId);
  const targetPost = findCall(harness.calls, "POST", ids.targetClientAlgoId);
  assert.ok(harness.calls.indexOf(stopPost) < harness.calls.indexOf(stopQuery));
  assert.ok(harness.calls.indexOf(stopQuery) < harness.calls.indexOf(targetPost));
  assert.equal(stopPost.type, "STOP_MARKET");
  assert.equal(stopPost.reduceOnly, "true");
  assert.equal(targetPost.type, "TAKE_PROFIT_MARKET");
  assert.equal(targetPost.reduceOnly, "true");
});

test("execution-unknown entry is queried once and never blindly resubmitted", async () => {
  const harness = await createHarness({
    entry: "execution_unknown",
    entryLookup: "not_found",
  });
  const outcome = await harness.coordinator.createProtectedEntry(entryRequest());

  assert.equal(outcome.state, "entry_visibility_pending");
  assert.equal(
    harness.calls.filter((call) => call.method === "POST" && call.clientId === ids.entryClientOrderId).length,
    1,
  );
  assert.equal(
    harness.calls.filter((call) => call.method === "GET" && call.clientId === ids.entryClientOrderId).length,
    1,
  );
  assert.equal(harness.calls.some((call) => call.path === "/fapi/v1/algoOrder"), false);
});

test("a partial entry fill is flattened at the exact executed quantity before protection", async () => {
  const harness = await createHarness({ entry: "partial" });
  const outcome = await harness.coordinator.createProtectedEntry(entryRequest());

  assert.equal(outcome.state, "emergency_flatten_confirmed");
  assert.equal(outcome.entry?.status, "PARTIALLY_FILLED");
  assert.equal(outcome.entry?.executed_quantity, "0.005");
  assert.equal(outcome.emergency_close?.executed_quantity, "0.005");
  const closePost = findCall(harness.calls, "POST", ids.emergencyCloseClientOrderId);
  assert.equal(closePost.reduceOnly, "true");
  assert.equal(harness.calls.some((call) => call.path === "/fapi/v1/algoOrder"), false);
});

test("a rejected native stop triggers one exact reduce-only emergency close", async () => {
  const harness = await createHarness({ stop: "rejected" });
  const outcome = await harness.coordinator.createProtectedEntry(entryRequest());

  assert.equal(outcome.state, "emergency_flatten_confirmed");
  assert.equal(outcome.emergency_close?.client_order_id, ids.emergencyCloseClientOrderId);
  assert.equal(outcome.emergency_close?.executed_quantity, "0.01");
  const closePost = findCall(harness.calls, "POST", ids.emergencyCloseClientOrderId);
  assert.equal(closePost.reduceOnly, "true");
  assert.equal(
    harness.calls.some((call) => call.clientId === ids.targetClientAlgoId),
    false,
  );
});

test("an execution-unknown stop can be proven by clientAlgoId without duplicate POST", async () => {
  const harness = await createHarness({ stop: "execution_unknown" });
  const outcome = await harness.coordinator.createProtectedEntry(entryRequest());

  assert.equal(outcome.state, "open_protected");
  assert.equal(
    harness.calls.filter((call) => call.method === "POST" && call.clientId === ids.stopClientAlgoId).length,
    1,
  );
  assert.equal(
    harness.calls.filter((call) => call.method === "GET" && call.clientId === ids.stopClientAlgoId).length,
    1,
  );
});

test("an unproven stop enters emergency close without submitting a target", async () => {
  const harness = await createHarness({ stopLookup: "not_found" });
  const outcome = await harness.coordinator.createProtectedEntry(entryRequest());

  assert.equal(outcome.state, "emergency_flatten_confirmed");
  assert.equal(outcome.reason, "native_stop_not_proven_close_proven");
  assert.equal(
    harness.calls.filter((call) => call.method === "POST" && call.clientId === ids.stopClientAlgoId).length,
    1,
  );
  assert.equal(
    harness.calls.some((call) => call.clientId === ids.targetClientAlgoId),
    false,
  );
});

test("target rejection preserves proven stop and reports degraded protection state", async () => {
  const harness = await createHarness({ target: "rejected" });
  const outcome = await harness.coordinator.createProtectedEntry(entryRequest());

  assert.equal(outcome.state, "open_protected_target_pending");
  assert.equal(outcome.stop?.client_algo_id, ids.stopClientAlgoId);
  assert.equal(outcome.target, null);
  assert.equal(outcome.emergency_close, null);
});

test("restart reconciliation reconstructs native ownership without any mutation", async () => {
  const harness = await createHarness({});
  const outcome = await harness.coordinator.reconcileProtectedEntry(entryRequest());

  assert.equal(outcome.state, "open_protected");
  assert.equal(outcome.entry?.client_order_id, ids.entryClientOrderId);
  assert.equal(outcome.stop?.client_algo_id, ids.stopClientAlgoId);
  assert.equal(outcome.target?.client_algo_id, ids.targetClientAlgoId);
  assert.equal(harness.calls.every((call) => call.method === "GET"), true);
});

test("a protected close is proven before either owned protection order is canceled", async () => {
  const harness = await createHarness({});
  const outcome = await harness.coordinator.closeProtectedEntry(entryRequest());

  assert.equal(outcome.state, "closed");
  assert.equal(outcome.close?.client_order_id, ids.emergencyCloseClientOrderId);
  assert.equal(outcome.close?.reduce_only, true);
  assert.equal(outcome.target_cleanup?.disposition, "canceled");
  assert.equal(outcome.stop_cleanup?.disposition, "canceled");

  const closePost = findCall(harness.calls, "POST", ids.emergencyCloseClientOrderId);
  const targetDelete = findCall(harness.calls, "DELETE", ids.targetClientAlgoId);
  const stopDelete = findCall(harness.calls, "DELETE", ids.stopClientAlgoId);
  assert.ok(harness.calls.indexOf(closePost) < harness.calls.indexOf(targetDelete));
  assert.ok(harness.calls.indexOf(closePost) < harness.calls.indexOf(stopDelete));
  assert.equal(closePost.reduceOnly, "true");
});

test("unknown close visibility leaves both native protection orders untouched", async () => {
  const harness = await createHarness({
    close: "execution_unknown",
    closeLookup: "not_found",
  });
  const outcome = await harness.coordinator.closeProtectedEntry(entryRequest());

  assert.equal(outcome.state, "close_visibility_pending");
  assert.equal(outcome.close, null);
  assert.equal(
    harness.calls.some((call) => call.method === "DELETE"),
    false,
  );
});

test("ambiguous target cancellation remains pending while exact lookup says active", async () => {
  const harness = await createHarness({ targetCancel: "execution_unknown" });
  const outcome = await harness.coordinator.closeProtectedEntry(entryRequest());

  assert.equal(outcome.state, "closed_protection_cleanup_pending");
  assert.equal(outcome.target_cleanup?.disposition, "active");
  assert.equal(outcome.target_cleanup?.venue_status, "NEW");
  assert.equal(outcome.stop_cleanup?.disposition, "canceled");
});

test("ambiguous cancellation is complete only after exact canceled status is visible", async () => {
  const harness = await createHarness({
    targetCancel: "execution_unknown",
    targetLookup: "canceled",
  });
  const outcome = await harness.coordinator.closeProtectedEntry(entryRequest());

  assert.equal(outcome.state, "closed");
  assert.equal(outcome.target_cleanup?.disposition, "canceled");
  assert.equal(outcome.target_cleanup?.venue_status, "CANCELED");
});

test("restart close reconciliation is GET-only and reconstructs completed cleanup", async () => {
  const harness = await createHarness({
    targetLookup: "canceled",
    stopLookup: "canceled",
  });
  const outcome = await harness.coordinator.reconcileProtectedClose(entryRequest());

  assert.equal(outcome.state, "closed");
  assert.equal(outcome.close?.client_order_id, ids.emergencyCloseClientOrderId);
  assert.equal(outcome.target_cleanup?.disposition, "canceled");
  assert.equal(outcome.stop_cleanup?.disposition, "canceled");
  assert.equal(harness.calls.every((call) => call.method === "GET"), true);
});

test("mutation evidence precedes transport and excludes credentials and signatures", async () => {
  const harness = await createHarness({});
  await harness.coordinator.closeProtectedEntry(entryRequest());

  const serialized = JSON.stringify(harness.evidence.events);
  assert.equal(serialized.includes("test-api-key"), false);
  assert.equal(serialized.includes("test-api-secret"), false);
  assert.equal(serialized.toLowerCase().includes("signature"), false);
  const closeBefore = harness.evidence.events.find(
    (event) => event.operation_id === ids.emergencyCloseClientOrderId && event.phase === "before_transport",
  );
  const closeResult = harness.evidence.events.find(
    (event) => event.operation_id === ids.emergencyCloseClientOrderId && event.phase === "transport_result",
  );
  assert.ok(closeBefore);
  assert.ok(closeResult);
  assert.ok((closeBefore?.sequence ?? 0) < (closeResult?.sequence ?? 0));

  for (const clientAlgoId of [ids.targetClientAlgoId, ids.stopClientAlgoId]) {
    const deleteBefore = harness.evidence.events.find(
      (event) => event.operation_id === clientAlgoId &&
        event.method === "DELETE" &&
        event.phase === "before_transport",
    );
    const deleteResult = harness.evidence.events.find(
      (event) => event.operation_id === clientAlgoId &&
        event.method === "DELETE" &&
        event.phase === "transport_result",
    );
    assert.ok(deleteBefore);
    assert.ok(deleteResult);
    assert.ok((deleteBefore?.sequence ?? 0) < (deleteResult?.sequence ?? 0));
  }
});

function entryRequest() {
  return {
    intentId,
    symbol: "BTCUSDT",
    direction: "LONG" as const,
    quantity: "0.010",
    stopPrice: "59000.0",
    targetPrice: "61000.0",
  };
}

async function createHarness(scenario: Scenario) {
  const calls: RecordedCall[] = [];
  const evidence = new InMemoryBinanceUsdmMutationEvidenceSink();
  const fakeFetch = createFakeFetch(scenario, calls);
  const client = new BinanceUsdmMutationClient({
    environment: "testnet",
    baseUrl: "http://127.0.0.1:8788",
    apiKey: "test-api-key",
    apiSecret: "test-api-secret",
    evidence,
    now: () => 1_700_000_000_000,
    fetchImpl: fakeFetch,
  });
  await client.synchronizeClock();
  return {
    calls,
    evidence,
    coordinator: new BinanceUsdmProtectionCoordinator(client),
  };
}

function createFakeFetch(
  scenario: Scenario,
  calls: RecordedCall[],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = init?.method ?? "GET";
    if (url.pathname === "/fapi/v1/time") {
      return jsonResponse({ serverTime: 1_700_000_000_100 });
    }
    const parameters = method === "POST"
      ? new URLSearchParams(String(init?.body ?? ""))
      : url.searchParams;
    const clientId = parameters.get("newClientOrderId")
      ?? parameters.get("clientAlgoId")
      ?? parameters.get("origClientOrderId");
    calls.push({
      method,
      path: url.pathname,
      clientId,
      type: parameters.get("type"),
      reduceOnly: parameters.get("reduceOnly"),
    });

    if (url.pathname === "/fapi/v1/order" && method === "POST") {
      if (clientId === ids.entryClientOrderId) {
        return scenario.entry === "execution_unknown"
          ? executionUnknown()
          : scenario.entry === "partial"
            ? jsonResponse(ordinaryOrder(ids.entryClientOrderId, "BUY", false, "PARTIALLY_FILLED", "0.005"))
            : jsonResponse(ordinaryOrder(ids.entryClientOrderId, "BUY", false));
      }
      if (clientId === ids.emergencyCloseClientOrderId) {
        return scenario.close === "execution_unknown"
          ? executionUnknown()
          : jsonResponse(ordinaryOrder(
              ids.emergencyCloseClientOrderId,
              "SELL",
              true,
              "FILLED",
              scenario.entry === "partial" ? "0.005" : "0.010",
            ));
      }
    }

    if (url.pathname === "/fapi/v1/order" && method === "GET") {
      if (clientId === ids.entryClientOrderId) {
        return scenario.entryLookup === "not_found"
          ? notFound()
          : jsonResponse(ordinaryOrder(ids.entryClientOrderId, "BUY", false));
      }
      if (clientId === ids.emergencyCloseClientOrderId) {
        return scenario.closeLookup === "not_found"
          ? notFound()
          : jsonResponse(ordinaryOrder(ids.emergencyCloseClientOrderId, "SELL", true));
      }
    }

    if (url.pathname === "/fapi/v1/algoOrder" && method === "POST") {
      if (clientId === ids.stopClientAlgoId) {
        if (scenario.stop === "rejected") {
          return jsonResponse({ code: -1102, msg: "Mandatory parameter invalid" }, 400);
        }
        return scenario.stop === "execution_unknown"
          ? executionUnknown()
          : jsonResponse({ algoId: 2001, clientAlgoId: ids.stopClientAlgoId });
      }
      if (clientId === ids.targetClientAlgoId) {
        return scenario.target === "rejected"
          ? jsonResponse({ code: -1102, msg: "Mandatory parameter invalid" }, 400)
          : jsonResponse({ algoId: 2002, clientAlgoId: ids.targetClientAlgoId });
      }
    }

    if (url.pathname === "/fapi/v1/algoOrder" && method === "GET") {
      if (clientId === ids.stopClientAlgoId) {
        return scenario.stopLookup === "not_found"
          ? notFound()
          : jsonResponse(algoOrder(
              ids.stopClientAlgoId,
              "STOP_MARKET",
              "59000.0",
              2001,
              scenario.stopLookup === "canceled" ? "CANCELED" : "NEW",
            ));
      }
      if (clientId === ids.targetClientAlgoId) {
        return scenario.targetLookup === "not_found"
          ? notFound()
          : jsonResponse(algoOrder(
              ids.targetClientAlgoId,
              "TAKE_PROFIT_MARKET",
              "61000.0",
              2002,
              scenario.targetLookup === "canceled" ? "CANCELED" : "NEW",
            ));
      }
    }

    if (url.pathname === "/fapi/v1/algoOrder" && method === "DELETE") {
      const disposition = clientId === ids.stopClientAlgoId
        ? scenario.stopCancel
        : scenario.targetCancel;
      if (disposition === "execution_unknown") {
        return executionUnknown();
      }
      if (disposition === "rejected") {
        return jsonResponse({ code: -2011, msg: "Unknown order sent." }, 400);
      }
      const algoId = clientId === ids.stopClientAlgoId ? 2001 : 2002;
      return jsonResponse({ algoId, clientAlgoId: clientId, code: 200, msg: "success" });
    }

    return jsonResponse({ code: -1, msg: "unexpected request" }, 500);
  }) as typeof fetch;
}

function ordinaryOrder(
  clientOrderId: string,
  side: "BUY" | "SELL",
  reduceOnly: boolean,
  status: "FILLED" | "PARTIALLY_FILLED" = "FILLED",
  executedQty = "0.010",
) {
  return {
    clientOrderId,
    orderId: side === "BUY" ? 1001 : 1002,
    symbol: "BTCUSDT",
    side,
    status,
    executedQty,
    avgPrice: "60000.00",
    reduceOnly,
  };
}

function algoOrder(
  clientAlgoId: string,
  orderType: "STOP_MARKET" | "TAKE_PROFIT_MARKET",
  triggerPrice: string,
  algoId: number,
  algoStatus: "NEW" | "CANCELED" = "NEW",
) {
  return {
    clientAlgoId,
    algoId,
    algoType: "CONDITIONAL",
    orderType,
    symbol: "BTCUSDT",
    side: "SELL",
    positionSide: "BOTH",
    quantity: "0.010",
    triggerPrice,
    reduceOnly: true,
    algoStatus,
  };
}

function executionUnknown(): Response {
  return jsonResponse({
    code: -1000,
    msg: "Unknown error, please check your request or try again later.",
  }, 503);
}

function notFound(): Response {
  return jsonResponse({ code: -2013, msg: "Order does not exist." }, 400);
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function findCall(calls: RecordedCall[], method: string, clientId: string): RecordedCall {
  const call = calls.find((candidate) => candidate.method === method && candidate.clientId === clientId);
  assert.ok(call);
  return call as RecordedCall;
}
