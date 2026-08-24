import { createServer } from "node:http";
import { URL } from "node:url";
import type { GatewayMode } from "../domain/types.js";
import type { RuntimeConfig } from "../config.js";
import { TradingEngine } from "../core/trading-engine.js";

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

export async function startServer(
  engine: TradingEngine,
  config: RuntimeConfig,
  portOverride?: number,
): Promise<RunningServer> {
  const server = createServer(async (request, response) => {
    try {
      await route(engine, config, request, response);
    } catch (error) {
      sendJson(response, 500, {
        error: "internal_error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  const port = portOverride ?? config.port;
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, config.host, () => resolvePromise());
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? Number(address.port) : port;
  return {
    port: actualPort,
    close: () => new Promise<void>((resolvePromise, reject) => {
      server.close((error: unknown) => error ? reject(error) : resolvePromise());
    }),
  };
}

async function route(
  engine: TradingEngine,
  config: RuntimeConfig,
  request: any,
  response: any,
): Promise<void> {
  const method = String(request.method ?? "GET").toUpperCase();
  const url = new URL(String(request.url ?? "/"), "http://127.0.0.1");

  if (method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, engine.getHealth());
    return;
  }

  const operatorPath = url.pathname.startsWith("/control/") || url.pathname.startsWith("/paper/");
  const requiredToken = operatorPath ? config.operatorToken : config.localToken;
  if (!authorized(request, requiredToken)) {
    sendJson(response, 401, { error: "unauthorized" });
    return;
  }

  if (method === "GET" && url.pathname === "/state") {
    sendJson(response, 200, engine.getState());
  } else if (method === "GET" && url.pathname === "/packet") {
    sendJson(response, 200, engine.getPacket());
  } else if (method === "GET" && url.pathname === "/policy") {
    sendJson(response, 200, engine.getPolicy());
  } else if (method === "GET" && url.pathname === "/performance") {
    sendJson(response, 200, engine.getPerformance());
  } else if (method === "GET" && url.pathname === "/trades") {
    sendJson(response, 200, { trades: engine.publicTrades(limit(url)) });
  } else if (method === "GET" && url.pathname === "/journal") {
    sendJson(response, 200, { journal: engine.journal(limit(url)) });
  } else if (method === "POST" && url.pathname === "/intent") {
    const receipt = engine.submitIntent(await readJson(request));
    sendJson(response, receipt.accepted ? 200 : receipt.state === "conflict" ? 409 : 422, receipt);
  } else if (method === "POST" && url.pathname === "/control/start") {
    sendJson(response, 200, engine.start());
  } else if (method === "POST" && url.pathname === "/control/stop") {
    sendJson(response, 200, engine.stop());
  } else if (method === "POST" && url.pathname === "/control/flatten") {
    const body = await readJsonOptional(request);
    const reason = typeof body.reason === "string" ? body.reason : "operator_flatten";
    sendJson(response, 200, engine.flattenAll(reason));
  } else if (method === "PUT" && url.pathname === "/control/policy") {
    sendJson(response, 200, engine.updatePolicy(await readJson(request)));
  } else if (method === "PUT" && url.pathname === "/control/mode") {
    const body = await readJson(request);
    const mode = body.gateway_mode as GatewayMode;
    if (!new Set<GatewayMode>(["disabled", "shadow", "armed"]).has(mode)) {
      sendJson(response, 422, { error: "invalid_gateway_mode" });
      return;
    }
    engine.database.setGatewayMode(mode);
    sendJson(response, 200, engine.getState());
  } else if (method === "POST" && url.pathname === "/paper/mark") {
    const body = await readJson(request);
    const mark = Number(body.mark_price);
    if (!Number.isFinite(mark) || mark <= 0) {
      sendJson(response, 422, { error: "mark_price_must_be_positive" });
      return;
    }
    sendJson(response, 200, engine.updatePaperMark(mark));
  } else {
    sendJson(response, 404, { error: "not_found" });
  }
}

function authorized(request: any, token: string): boolean {
  return String(request.headers?.authorization ?? "") === `Bearer ${token}`;
}

async function readJson(request: any): Promise<Record<string, unknown>> {
  const body = await readBody(request);
  if (!body) {
    throw new Error("request body is required");
  }
  const value = JSON.parse(body) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

async function readJsonOptional(request: any): Promise<Record<string, unknown>> {
  const body = await readBody(request);
  return body ? (JSON.parse(body) as Record<string, unknown>) : {};
}

async function readBody(request: any): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("request body exceeds 1 MB"));
        request.destroy();
      }
    });
    request.on("end", () => resolvePromise(body));
    request.on("error", reject);
  });
}

function limit(url: URL): number {
  const parsed = Number(url.searchParams.get("limit") ?? "100");
  return Number.isInteger(parsed) ? Math.max(1, Math.min(1_000, parsed)) : 100;
}

function sendJson(response: any, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Length", String(new TextEncoder().encode(body).byteLength));
  response.end(body);
}
