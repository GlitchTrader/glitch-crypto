import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveBinanceUsdmMutationIds,
  deriveBinanceUsdmProtectionRevisionIds,
  validateBinanceUsdmOwnedProtectionClose,
  type BinanceUsdmOwnedProtectionCloseRequest,
  type BinanceUsdmProtectionRevisionRequest,
} from "../src/venue/binance-usdm/mutation-contract.js";
import {
  BinanceUsdmMutationClient,
  InMemoryBinanceUsdmMutationEvidenceSink,
} from "../src/venue/binance-usdm/mutation-client.js";
import { BinanceUsdmProtectionRevisionCoordinator } from "../src/venue/binance-usdm/protection-revision.js";

const positionIntentId = "123e4567-e89b-42d3-a456-426614174000";
const revisionIntentId = "223e4567-e89b-42d3-a456-426614174000";
const closeIntentId = "323e4567-e89b-42d3-a456-426614174000";
const currentIds = deriveBinanceUsdmMutationIds(positionIntentId);
const revisionIds = deriveBinanceUsdmProtectionRevisionIds(revisionIntentId);
const closeClientOrderId = validateBinanceUsdmOwnedProtectionClose({
  closeIntentId,
  current: revisedProtection(),
}).closeClientOrderId;

interface Scenario {
  reduction?: "filled" | "partial" | "rejected" | "execution_unknown";
  reductionLookup?: "filled" | "partial" | "not_found";
  stop?: "accepted" | "rejected" | "execution_unknown";
  stopLookup?: "found" | "not_found";
  target?: "accepted" | "rejected" | "execution_unknown";
  targetLookup?: "found" | "not_found";
  oldTargetCancel?: "accepted" | "rejected" | "execution_unknown";
  oldStopCancel?: "accepted" | "rejected" | "execution_unknown";
  oldTargetAfterCancel?: "active" | "canceled" | "not_found";
  oldStopAfterCancel?: "active" | "canceled" | "not_found";
  reconcileOldTarget?: "active" | "canceled" | "not_found";
  reconcileOldStop?: "active" | "canceled" | "not_found";
  close?: "filled" | "partial" | "rejected" | "execution_unknown";
  closeLookup?: "filled" | "partial" | "not_found";
  closeTargetCancel?: "accepted" | "rejected" | "execution_unknown";
  closeStopCancel?: "accepted" | "rejected" | "execution_unknown";
  closeTargetAfterCancel?: "active" | "canceled" | "not_found";
  closeStopAfterCancel?: "active" | "canceled" | "not_found";
  reconcileRevisionTarget?: "active" | "canceled" | "not_found";
  reconcileRevisionStop?: "active" | "canceled" | "not_found";
}

interface RecordedCall {
  method: string;
  path: string;
  clientId: string | null;
  type: string | null;
  quantity: string | null;
  reduceOnly: string | null;
}

test("partial reduction proves exact remaining protection before old cleanup", async () => {
  const harness = await createHarness({});
  const outcome = await harness.coordinator.revise(revisionRequest());

  assert.equal(outcome.state, "revision_protected");
  assert.equal(outcome.reduction?.executed_quantity, "0.004");
  assert.equal(outcome.next.quantity, "0.006");
  assert.equal(outcome.replacement_stop?.quantity, "0.006");
  assert.equal(outcome.replacement_target?.quantity, "0.006");
  assert.equal(outcome.current_target_cleanup?.disposition, "canceled");
  assert.equal(outcome.current_stop_cleanup?.disposition, "canceled");

  const reduction = findCall(harness.calls, "POST", revisionIds.reductionClientOrderId);
  const stopPost = findCall(harness.calls, "POST", revisionIds.stopClientAlgoId);
  const stopGet = findCall(harness.calls, "GET", revisionIds.stopClientAlgoId);
  const targetPost = findCall(harness.calls, "POST", revisionIds.targetClientAlgoId);
  const targetGet = findCall(harness.calls, "GET", revisionIds.targetClientAlgoId);
  const oldTargetDelete = findCall(harness.calls, "DELETE", currentIds.targetClientAlgoId);
  const oldStopDelete = findCall(harness.calls, "DELETE", currentIds.stopClientAlgoId);
  assert.equal(reduction.reduceOnly, "true");
  assert.equal(reduction.quantity, "0.004");
  assert.equal(stopPost.quantity, "0.006");
  assert.equal(stopPost.reduceOnly, "true");
  assert.ok(harness.calls.indexOf(reduction) < harness.calls.indexOf(stopPost));
  assert.ok(harness.calls.indexOf(stopPost) < harness.calls.indexOf(stopGet));
  assert.ok(harness.calls.indexOf(stopGet) < harness.calls.indexOf(targetPost));
  assert.ok(harness.calls.indexOf(targetPost) < harness.calls.indexOf(targetGet));
  assert.ok(harness.calls.indexOf(targetGet) < harness.calls.indexOf(oldTargetDelete));
  assert.ok(harness.calls.indexOf(oldTargetDelete) < harness.calls.indexOf(oldStopDelete));
  const retained = JSON.stringify(harness.evidence.events);
  assert.equal(retained.includes("revision-api-key"), false);
  assert.equal(retained.includes("revision-api-secret"), false);
  assert.equal(retained.toLowerCase().includes("signature"), false);
});

test("pure geometry replacement performs no position reduction", async () => {
  const harness = await createHarness({});
  const outcome = await harness.coordinator.revise(revisionRequest(null));

  assert.equal(outcome.state, "revision_protected");
  assert.equal(outcome.reduction, null);
  assert.equal(outcome.next.quantity, "0.01");
  assert.equal(
    harness.calls.some((call) => call.clientId === revisionIds.reductionClientOrderId),
    false,
  );
});

test("ambiguous reduction is queried once and never resubmitted", async () => {
  const harness = await createHarness({
    reduction: "execution_unknown",
    reductionLookup: "not_found",
  });
  const outcome = await harness.coordinator.revise(revisionRequest());

  assert.equal(outcome.state, "reduction_visibility_pending");
  assert.equal(countCalls(harness.calls, "POST", revisionIds.reductionClientOrderId), 1);
  assert.equal(countCalls(harness.calls, "GET", revisionIds.reductionClientOrderId), 1);
  assert.equal(harness.calls.some((call) => call.method === "DELETE"), false);
  assert.equal(
    harness.calls.some((call) => call.clientId === revisionIds.stopClientAlgoId),
    false,
  );
});

test("partial reduction fill leaves current protection untouched", async () => {
  const harness = await createHarness({
    reduction: "partial",
    reductionLookup: "partial",
  });
  const outcome = await harness.coordinator.revise(revisionRequest());

  assert.equal(outcome.state, "reduction_visibility_pending");
  assert.equal(outcome.reduction, null);
  assert.equal(harness.calls.some((call) => call.method === "DELETE"), false);
  assert.equal(
    harness.calls.some((call) => call.clientId === revisionIds.stopClientAlgoId),
    false,
  );
});

test("rejected reduction leaves current protection untouched", async () => {
  const harness = await createHarness({ reduction: "rejected" });
  const outcome = await harness.coordinator.revise(revisionRequest());

  assert.equal(outcome.state, "reduction_rejected");
  assert.equal(outcome.current_stop?.client_algo_id, currentIds.stopClientAlgoId);
  assert.equal(outcome.current_target?.client_algo_id, currentIds.targetClientAlgoId);
  assert.equal(harness.calls.some((call) => call.method === "DELETE"), false);
  assert.equal(
    harness.calls.some((call) => call.clientId === revisionIds.stopClientAlgoId),
    false,
  );
});

test("ambiguous replacement stop is proven by identity without duplicate POST", async () => {
  const harness = await createHarness({ stop: "execution_unknown" });
  const outcome = await harness.coordinator.revise(revisionRequest());

  assert.equal(outcome.state, "revision_protected");
  assert.equal(countCalls(harness.calls, "POST", revisionIds.stopClientAlgoId), 1);
  assert.equal(countCalls(harness.calls, "GET", revisionIds.stopClientAlgoId), 1);
});

test("unproven replacement stop prevents target and old cleanup", async () => {
  const harness = await createHarness({ stopLookup: "not_found" });
  const outcome = await harness.coordinator.revise(revisionRequest());

  assert.equal(outcome.state, "replacement_stop_pending");
  assert.equal(outcome.replacement_stop, null);
  assert.equal(
    harness.calls.some((call) => call.clientId === revisionIds.targetClientAlgoId),
    false,
  );
  assert.equal(harness.calls.some((call) => call.method === "DELETE"), false);
});

test("unproven replacement target preserves both old protections", async () => {
  const harness = await createHarness({ targetLookup: "not_found" });
  const outcome = await harness.coordinator.revise(revisionRequest());

  assert.equal(outcome.state, "replacement_target_pending");
  assert.equal(outcome.replacement_stop?.client_algo_id, revisionIds.stopClientAlgoId);
  assert.equal(outcome.replacement_target, null);
  assert.equal(harness.calls.some((call) => call.method === "DELETE"), false);
});

test("ambiguous old cleanup stays pending when exact lookup remains active", async () => {
  const harness = await createHarness({
    oldTargetCancel: "execution_unknown",
    oldTargetAfterCancel: "active",
  });
  const outcome = await harness.coordinator.revise(revisionRequest());

  assert.equal(outcome.state, "revision_protected_cleanup_pending");
  assert.equal(outcome.current_target_cleanup?.disposition, "active");
  assert.equal(outcome.current_stop_cleanup?.disposition, "canceled");
});

test("restart reconciliation reconstructs a completed revision with GET only", async () => {
  const harness = await createHarness({
    reductionLookup: "filled",
    reconcileOldTarget: "canceled",
    reconcileOldStop: "canceled",
  });
  const outcome = await harness.coordinator.reconcile(revisionRequest());

  assert.equal(outcome.state, "revision_protected");
  assert.equal(outcome.reduction?.client_order_id, revisionIds.reductionClientOrderId);
  assert.equal(outcome.replacement_stop?.client_algo_id, revisionIds.stopClientAlgoId);
  assert.equal(outcome.replacement_target?.client_algo_id, revisionIds.targetClientAlgoId);
  assert.equal(harness.calls.every((call) => call.method === "GET"), true);
});

test("generic close flattens revised quantity before current protection cleanup", async () => {
  const harness = await createHarness({});
  const outcome = await harness.coordinator.closeOwnedProtection(closeRequest());

  assert.equal(outcome.state, "closed");
  assert.equal(outcome.close?.client_order_id, closeClientOrderId);
  assert.equal(outcome.close?.executed_quantity, "0.006");
  assert.equal(outcome.current_target_cleanup?.disposition, "canceled");
  assert.equal(outcome.current_stop_cleanup?.disposition, "canceled");
  const closePost = findCall(harness.calls, "POST", closeClientOrderId);
  const targetDelete = findCall(harness.calls, "DELETE", revisionIds.targetClientAlgoId);
  const stopDelete = findCall(harness.calls, "DELETE", revisionIds.stopClientAlgoId);
  assert.equal(closePost.quantity, "0.006");
  assert.equal(closePost.reduceOnly, "true");
  assert.ok(harness.calls.indexOf(closePost) < harness.calls.indexOf(targetDelete));
  assert.ok(harness.calls.indexOf(targetDelete) < harness.calls.indexOf(stopDelete));
});

test("ambiguous generic close is queried once and leaves protection intact", async () => {
  const harness = await createHarness({
    close: "execution_unknown",
    closeLookup: "not_found",
  });
  const outcome = await harness.coordinator.closeOwnedProtection(closeRequest());

  assert.equal(outcome.state, "close_visibility_pending");
  assert.equal(countCalls(harness.calls, "POST", closeClientOrderId), 1);
  assert.equal(countCalls(harness.calls, "GET", closeClientOrderId), 1);
  assert.equal(harness.calls.some((call) => call.method === "DELETE"), false);
});

test("partial generic close remains pending and performs no cleanup", async () => {
  const harness = await createHarness({
    close: "partial",
    closeLookup: "partial",
  });
  const outcome = await harness.coordinator.closeOwnedProtection(closeRequest());

  assert.equal(outcome.state, "close_visibility_pending");
  assert.equal(outcome.close, null);
  assert.equal(harness.calls.some((call) => call.method === "DELETE"), false);
});

test("rejected generic close performs no cleanup", async () => {
  const harness = await createHarness({ close: "rejected" });
  const outcome = await harness.coordinator.closeOwnedProtection(closeRequest());

  assert.equal(outcome.state, "close_visibility_pending");
  assert.equal(outcome.close, null);
  assert.equal(harness.calls.some((call) => call.method === "DELETE"), false);
});

test("generic close requires exact current pair before mutation", async () => {
  const harness = await createHarness({ stopLookup: "not_found" });
  const outcome = await harness.coordinator.closeOwnedProtection(closeRequest());

  assert.equal(outcome.state, "owned_protection_not_proven");
  assert.equal(harness.calls.some((call) => call.method === "POST"), false);
  assert.equal(harness.calls.some((call) => call.method === "DELETE"), false);
});

test("restart generic-close reconciliation is GET-only", async () => {
  const harness = await createHarness({
    closeLookup: "filled",
    reconcileRevisionTarget: "canceled",
    reconcileRevisionStop: "canceled",
  });
  const outcome = await harness.coordinator.reconcileOwnedProtectionClose(
    closeRequest(),
  );

  assert.equal(outcome.state, "closed");
  assert.equal(outcome.close?.executed_quantity, "0.006");
  assert.equal(harness.calls.every((call) => call.method === "GET"), true);
});

function revisionRequest(
  reductionQuantity: string | null = "0.004",
): BinanceUsdmProtectionRevisionRequest {
  return {
    revisionIntentId,
    current: {
      positionIntentId,
      symbol: "BTCUSDT",
      direction: "LONG",
      quantity: "0.010",
      stopPrice: "59000",
      targetPrice: "61000",
      stopClientAlgoId: currentIds.stopClientAlgoId,
      targetClientAlgoId: currentIds.targetClientAlgoId,
    },
    reductionQuantity,
    nextStopPrice: "59500",
    nextTargetPrice: "61500",
  };
}

function revisedProtection() {
  return {
    positionIntentId,
    symbol: "BTCUSDT",
    direction: "LONG" as const,
    quantity: "0.006",
    stopPrice: "59500",
    targetPrice: "61500",
    stopClientAlgoId: revisionIds.stopClientAlgoId,
    targetClientAlgoId: revisionIds.targetClientAlgoId,
  };
}

function closeRequest(): BinanceUsdmOwnedProtectionCloseRequest {
  return {
    closeIntentId,
    current: revisedProtection(),
  };
}

async function createHarness(scenario: Scenario) {
  const calls: RecordedCall[] = [];
  const evidence = new InMemoryBinanceUsdmMutationEvidenceSink();
  const client = new BinanceUsdmMutationClient({
    environment: "testnet",
    baseUrl: "http://127.0.0.1:8788",
    apiKey: "revision-api-key",
    apiSecret: "revision-api-secret",
    evidence,
    now: () => 1_700_000_000_000,
    fetchImpl: createFakeFetch(scenario, calls),
  });
  await client.synchronizeClock();
  return {
    calls,
    evidence,
    coordinator: new BinanceUsdmProtectionRevisionCoordinator(client),
  };
}

function createFakeFetch(
  scenario: Scenario,
  calls: RecordedCall[],
): typeof fetch {
  const cancelAttempted = new Set<string>();
  const placedQuantity = new Map<string, string>();
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = init?.method ?? "GET";
    if (url.pathname === "/fapi/v1/time") {
      return jsonResponse({ serverTime: 1_700_000_000_100 });
    }
    const parameters = method === "POST"
      ? new URLSearchParams(String(init?.body ?? ""))
      : url.searchParams;
    const clientId = parameters.get("newClientOrderId") ??
      parameters.get("clientAlgoId") ??
      parameters.get("origClientOrderId");
    calls.push({
      method,
      path: url.pathname,
      clientId,
      type: parameters.get("type"),
      quantity: parameters.get("quantity"),
      reduceOnly: parameters.get("reduceOnly"),
    });

    if (url.pathname === "/fapi/v1/order" && clientId === revisionIds.reductionClientOrderId) {
      if (method === "POST") {
        if (scenario.reduction === "rejected") {
          return jsonResponse({ code: -1102, msg: "rejected" }, 400);
        }
        if (scenario.reduction === "execution_unknown") {
          return executionUnknown();
        }
        return jsonResponse(reductionOrder(
          scenario.reduction === "partial" ? "PARTIALLY_FILLED" : "FILLED",
          scenario.reduction === "partial" ? "0.002" : "0.004",
        ));
      }
      if (scenario.reductionLookup === "not_found") {
        return notFound();
      }
      return jsonResponse(reductionOrder(
        scenario.reductionLookup === "partial" ? "PARTIALLY_FILLED" : "FILLED",
        scenario.reductionLookup === "partial" ? "0.002" : "0.004",
      ));
    }

    if (url.pathname === "/fapi/v1/order" && clientId === closeClientOrderId) {
      if (method === "POST") {
        if (scenario.close === "rejected") {
          return jsonResponse({ code: -1102, msg: "rejected" }, 400);
        }
        if (scenario.close === "execution_unknown") {
          return executionUnknown();
        }
        return jsonResponse(closeOrder(
          scenario.close === "partial" ? "PARTIALLY_FILLED" : "FILLED",
          scenario.close === "partial" ? "0.003" : "0.006",
        ));
      }
      if (scenario.closeLookup === "not_found") {
        return notFound();
      }
      return jsonResponse(closeOrder(
        scenario.closeLookup === "partial" ? "PARTIALLY_FILLED" : "FILLED",
        scenario.closeLookup === "partial" ? "0.003" : "0.006",
      ));
    }

    if (url.pathname === "/fapi/v1/algoOrder" && method === "POST") {
      if (clientId === revisionIds.stopClientAlgoId) {
        placedQuantity.set(clientId, parameters.get("quantity") ?? "");
        if (scenario.stop === "rejected") {
          return jsonResponse({ code: -1102, msg: "rejected" }, 400);
        }
        return scenario.stop === "execution_unknown"
          ? executionUnknown()
          : jsonResponse({ algoId: 3001, clientAlgoId: clientId });
      }
      if (clientId === revisionIds.targetClientAlgoId) {
        placedQuantity.set(clientId, parameters.get("quantity") ?? "");
        if (scenario.target === "rejected") {
          return jsonResponse({ code: -1102, msg: "rejected" }, 400);
        }
        return scenario.target === "execution_unknown"
          ? executionUnknown()
          : jsonResponse({ algoId: 3002, clientAlgoId: clientId });
      }
    }

    if (url.pathname === "/fapi/v1/algoOrder" && method === "DELETE") {
      if (clientId === null) {
        return jsonResponse({ code: -1, msg: "missing client ID" }, 400);
      }
      cancelAttempted.add(clientId);
      const disposition = clientId === currentIds.targetClientAlgoId
        ? scenario.oldTargetCancel
        : clientId === currentIds.stopClientAlgoId
          ? scenario.oldStopCancel
          : clientId === revisionIds.targetClientAlgoId
            ? scenario.closeTargetCancel
            : scenario.closeStopCancel;
      if (disposition === "execution_unknown") {
        return executionUnknown();
      }
      if (disposition === "rejected") {
        return jsonResponse({ code: -2011, msg: "unknown order" }, 400);
      }
      return jsonResponse({ code: 200, msg: "success", clientAlgoId: clientId });
    }

    if (url.pathname === "/fapi/v1/algoOrder" && method === "GET" && clientId) {
      if (clientId === revisionIds.stopClientAlgoId) {
        const state = cancelAttempted.has(clientId)
          ? scenario.closeStopAfterCancel ?? "active"
          : scenario.reconcileRevisionStop;
        return scenario.stopLookup === "not_found"
          ? notFound()
          : state
            ? cleanupLookup(state, algoOrder(
                clientId,
                "STOP_MARKET",
                "59500",
                placedQuantity.get(clientId) ?? "0.006",
                3001,
              ))
            : jsonResponse(algoOrder(
              clientId,
              "STOP_MARKET",
              "59500",
              placedQuantity.get(clientId) ?? "0.006",
              3001,
            ));
      }
      if (clientId === revisionIds.targetClientAlgoId) {
        const state = cancelAttempted.has(clientId)
          ? scenario.closeTargetAfterCancel ?? "active"
          : scenario.reconcileRevisionTarget;
        return scenario.targetLookup === "not_found"
          ? notFound()
          : state
            ? cleanupLookup(state, algoOrder(
                clientId,
                "TAKE_PROFIT_MARKET",
                "61500",
                placedQuantity.get(clientId) ?? "0.006",
                3002,
              ))
            : jsonResponse(algoOrder(
              clientId,
              "TAKE_PROFIT_MARKET",
              "61500",
              placedQuantity.get(clientId) ?? "0.006",
              3002,
            ));
      }
      if (clientId === currentIds.stopClientAlgoId) {
        const state = cancelAttempted.has(clientId)
          ? scenario.oldStopAfterCancel ?? "active"
          : scenario.reconcileOldStop ?? "active";
        return cleanupLookup(
          state,
          algoOrder(clientId, "STOP_MARKET", "59000", "0.01", 2001),
        );
      }
      if (clientId === currentIds.targetClientAlgoId) {
        const state = cancelAttempted.has(clientId)
          ? scenario.oldTargetAfterCancel ?? "active"
          : scenario.reconcileOldTarget ?? "active";
        return cleanupLookup(
          state,
          algoOrder(clientId, "TAKE_PROFIT_MARKET", "61000", "0.01", 2002),
        );
      }
    }

    return jsonResponse({ code: -1, msg: "unexpected request" }, 500);
  }) as typeof fetch;
}

function reductionOrder(
  status: "FILLED" | "PARTIALLY_FILLED",
  executedQty: string,
) {
  return {
    clientOrderId: revisionIds.reductionClientOrderId,
    orderId: 4001,
    symbol: "BTCUSDT",
    side: "SELL",
    status,
    executedQty,
    avgPrice: "60000",
    reduceOnly: true,
  };
}

function closeOrder(
  status: "FILLED" | "PARTIALLY_FILLED",
  executedQty: string,
) {
  return {
    clientOrderId: closeClientOrderId,
    orderId: 5001,
    symbol: "BTCUSDT",
    side: "SELL",
    status,
    executedQty,
    avgPrice: "60000",
    reduceOnly: true,
  };
}

function algoOrder(
  clientAlgoId: string,
  orderType: "STOP_MARKET" | "TAKE_PROFIT_MARKET",
  triggerPrice: string,
  quantity: string,
  algoId: number,
) {
  return {
    clientAlgoId,
    algoId,
    algoType: "CONDITIONAL",
    orderType,
    symbol: "BTCUSDT",
    side: "SELL",
    positionSide: "BOTH",
    quantity,
    triggerPrice,
    reduceOnly: true,
    algoStatus: "NEW",
  };
}

function cleanupLookup(
  state: "active" | "canceled" | "not_found",
  order: Record<string, unknown>,
): Response {
  if (state === "not_found") {
    return notFound();
  }
  return jsonResponse({
    ...order,
    algoStatus: state === "canceled" ? "CANCELED" : "NEW",
  });
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

function findCall(
  calls: RecordedCall[],
  method: string,
  clientId: string,
): RecordedCall {
  const call = calls.find(
    (candidate) => candidate.method === method && candidate.clientId === clientId,
  );
  assert.ok(call);
  return call as RecordedCall;
}

function countCalls(
  calls: RecordedCall[],
  method: string,
  clientId: string,
): number {
  return calls.filter(
    (candidate) => candidate.method === method && candidate.clientId === clientId,
  ).length;
}
