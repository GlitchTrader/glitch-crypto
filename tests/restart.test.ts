import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TradingEngine } from "../src/core/trading-engine.js";
import { GlitchDatabase } from "../src/storage/database.js";
import { PaperVenue } from "../src/venue/paper-venue.js";

test("trade history, journal, and receipts survive restart", () => {
  const path = join(tmpdir(), `glitch-crypto-${randomUUID()}.sqlite`);
  try {
    let database = new GlitchDatabase(path, 100_000, 6_000_000);
    database.setGatewayMode("shadow");
    let engine = new TradingEngine(database, new PaperVenue());
    engine.start();
    const intentId = randomUUID();
    const intent = {
      schema_version: "glitch.crypto.intent.v1",
      intent_id: intentId,
      packet_id: "restart-packet",
      account: "paper-main",
      instrument: "BTCUSDT-PERP",
      action: "ENTER_LONG",
      stop_price: 59_400,
      target_price: 61_200,
      reason: "Restart durability fixture.",
    };
    const opened = engine.submitIntent(intent);
    assert.equal(opened.state, "open_protected");
    engine.updatePaperMark(61_200);
    database.close();

    database = new GlitchDatabase(path, 100_000, 6_000_000);
    engine = new TradingEngine(database, new PaperVenue());
    assert.equal(database.listTrades(10).length, 1);
    assert.ok(database.listJournal(20).length > 0);
    const replay = engine.submitIntent(intent);
    assert.equal(replay.replayed, true);
    assert.equal(replay.state, "open_protected");
    database.close();
  } finally {
    rmSync(path, { force: true });
    rmSync(path + "-wal", { force: true });
    rmSync(path + "-shm", { force: true });
  }
});
