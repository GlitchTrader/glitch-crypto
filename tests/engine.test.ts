import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { TradingEngine } from "../src/core/trading-engine.js";
import { GlitchDatabase } from "../src/storage/database.js";
import { PaperVenue } from "../src/venue/paper-venue.js";

function createEngine(): { database: GlitchDatabase; engine: TradingEngine } {
  const database = new GlitchDatabase(":memory:", 100_000, 6_000_000);
  database.setGatewayMode("shadow");
  const engine = new TradingEngine(database, new PaperVenue());
  engine.start();
  return { database, engine };
}

function entry(intentId = randomUUID(), targetPrice = 61_200): Record<string, unknown> {
  return {
    schema_version: "glitch.crypto.intent.v1",
    intent_id: intentId,
    packet_id: "packet-1",
    account: "paper-main",
    instrument: "BTCUSDT-PERP",
    action: "ENTER_LONG",
    stop_price: 59_400,
    target_price: targetPrice,
    requested_risk_pct: 0.5,
    requested_leverage: 3,
    reason: "Test a bounded structure with native protection.",
  };
}

test("same UUID and body replays; changed body conflicts", () => {
  const { database, engine } = createEngine();
  const intentId = randomUUID();
  const first = engine.submitIntent(entry(intentId));
  assert.equal(first.state, "open_protected");
  assert.equal(first.replayed, false);

  const replay = engine.submitIntent(entry(intentId));
  assert.equal(replay.state, "open_protected");
  assert.equal(replay.replayed, true);

  const changed = engine.submitIntent(entry(intentId, 61_500));
  assert.equal(changed.state, "conflict");
  assert.equal(changed.reason, "intent_body_conflict");
  database.close();
});

test("partial reduction re-arms exact protection and target closes the survivor", () => {
  const { database, engine } = createEngine();
  const opened = engine.submitIntent(entry());
  assert.equal(opened.state, "open_protected");
  const before = database.getPositions()[0];
  if (!before) throw new Error("expected an open position");

  const reduced = engine.submitIntent({
    schema_version: "glitch.crypto.intent.v1",
    intent_id: randomUUID(),
    packet_id: "packet-2",
    account: "paper-main",
    instrument: "BTCUSDT-PERP",
    action: "REDUCE",
    tranche_id: before.trancheId,
    reduce_fraction_pct: 50,
    reason: "Take a supported partial while preserving the runner.",
  });
  assert.equal(reduced.state, "reduced_protected");
  const after = database.getPositions()[0];
  if (!after) throw new Error("expected a surviving position");
  assert.ok(after.quantityUnits < before.quantityUnits);
  assert.ok(after.stopOrderId !== before.stopOrderId);
  assert.ok(after.targetOrderId !== before.targetOrderId);

  engine.updatePaperMark(61_200);
  assert.equal(database.getPositions().length, 0);
  assert.equal(database.listTrades(10).length, 2);
  database.close();
});

test("reaching the 0.5% lock blocks new risk that would surrender the floor", () => {
  const { database, engine } = createEngine();
  const first = engine.submitIntent(entry());
  assert.equal(first.accepted, true);
  engine.updatePaperMark(61_200);
  const risk = engine.risk.snapshot();
  assert.equal(risk.lockReached, true);
  assert.ok(risk.activeFloorCents !== null);

  const second = engine.submitIntent(entry(randomUUID(), 62_000));
  assert.equal(second.accepted, false);
  assert.match(second.reason, /daily lock floor/);
  database.close();
});


test("raising the target preserves the already earned floor until the higher target is reached", () => {
  const { database, engine } = createEngine();
  engine.submitIntent(entry());
  engine.updatePaperMark(61_200);
  const earned = engine.risk.snapshot();
  assert.equal(earned.activeFloorCents, 100_500);
  engine.updatePolicy({ daily_lock_target_pct: 1.0 });
  const raised = engine.risk.snapshot();
  assert.equal(raised.dailyTargetEquityCents, 101_000);
  assert.equal(raised.activeFloorCents, 100_500);
  database.close();
});
