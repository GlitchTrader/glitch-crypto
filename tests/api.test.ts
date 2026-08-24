import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../src/api/server.js";
import { TradingEngine } from "../src/core/trading-engine.js";
import { GlitchDatabase } from "../src/storage/database.js";
import { PaperVenue } from "../src/venue/paper-venue.js";
import type { RuntimeConfig } from "../src/config.js";

const MODEL_TOKEN = "model-token-1234567890";
const OPERATOR_TOKEN = "operator-token-1234567890";

test("operator controls reject the model token", async () => {
  const database = new GlitchDatabase(":memory:");
  const engine = new TradingEngine(database, new PaperVenue());
  const config: RuntimeConfig = {
    host: "127.0.0.1",
    port: 8791,
    localToken: MODEL_TOKEN,
    operatorToken: OPERATOR_TOKEN,
    databasePath: ":memory:",
    gatewayMode: "shadow",
    initialEquityCents: 100_000,
    initialMarkPriceCents: 6_000_000,
  };
  const server = await startServer(engine, config, 0);
  const base = `http://127.0.0.1:${server.port}`;

  const health = await fetch(base + "/health");
  assert.equal(health.status, 200);

  const denied = await fetch(base + "/control/start", {
    method: "POST",
    headers: { Authorization: `Bearer ${MODEL_TOKEN}` },
  });
  assert.equal(denied.status, 401);

  const allowed = await fetch(base + "/control/start", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPERATOR_TOKEN}` },
  });
  assert.equal(allowed.status, 200);

  await server.close();
  database.close();
});
