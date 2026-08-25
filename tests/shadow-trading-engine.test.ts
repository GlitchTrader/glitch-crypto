import test from "node:test";
import assert from "node:assert/strict";
import { ShadowTradingEngine } from "../src/runtime/shadow-trading-engine.js";
import type {
  BinanceShadowRuntimeSnapshot,
  ShadowRuntimeProvider,
} from "../src/runtime/binance-shadow-runtime.js";
import { GlitchDatabase } from "../src/storage/database.js";
import { PaperVenue } from "../src/venue/paper-venue.js";

class FixedRuntime implements ShadowRuntimeProvider {
  constructor(private readonly value: BinanceShadowRuntimeSnapshot) {}

  snapshot(): BinanceShadowRuntimeSnapshot {
    return this.value;
  }
}

test("live shadow evidence is part of the packet identity and market state", () => {
  const database = new GlitchDatabase(":memory:", 100_000, 6_000_000);
  const engine = new ShadowTradingEngine(database, new PaperVenue());
  engine.attachRuntime(new FixedRuntime({
    status: {
      schema_version: "glitch.crypto.binance-shadow-runtime.v1",
      mode: "binance-shadow",
      running: true,
      mutation_authority: false,
      started_utc: "2026-08-25T10:00:00.000Z",
      last_error: null,
      evidence_path: "data/live.jsonl",
      streams: {
        depth: "running",
        market: "running",
        private: {
          enabled: false,
          state: "stopped",
          positions: 0,
          orders: 0,
          last_event_time: null,
        },
      },
      latest_event_id: "event-1",
    },
    market_observation: {
      schema_version: "glitch.crypto.opportunity.v1",
      baseline_version: "microstructure-baseline.v1",
      calibrated: false,
      observation_id: "observation-1",
      observed_utc: "2026-08-25T10:00:01.000Z",
      state: "actionable",
      actionable: true,
      action: "ENTER_LONG",
      reason: "Positive edge after costs.",
      market: {
        instrument: "BTCUSDT-PERP",
        mark_price: 61_000,
        index_price: 60_999,
        best_bid: 60_999.9,
        best_ask: 61_000.1,
        spread_bps: 0.0328,
        funding_rate: 0.0001,
        market_age_ms: 10,
      },
      evidence: {
        trades_15s: 100,
        trades_60s: 400,
        trade_rate_15s: 6.6667,
        buy_notional_15s: 100_000,
        sell_notional_15s: 50_000,
        flow_imbalance_15s: 0.333333,
        flow_imbalance_60s: 0.2,
        book_imbalance_top5: 0.25,
        microprice_edge_bps: 0.02,
        momentum_15s_bps: 8,
        momentum_60s_bps: 12,
        range_15s_bps: 14,
        noise_15s_bps: 2,
        directional_pressure_bps: 10,
      },
      economics: {
        expected_gross_move_bps: 13,
        execution_and_noise_reserve_bps: 10,
        conservative_edge_bps: 3,
        minimum_edge_bps: 1.5,
      },
      geometry: {
        invalidation_distance_bps: 8,
        objective_distance_bps: 13,
        suggested_stop_price: 60_951.2,
        suggested_target_price: 61_079.3,
      },
    },
    decision_event: {
      schema_version: "glitch.crypto.shadow-decision-event.v1",
      event_id: "event-1",
      event_type: "CANDIDATE",
      instrument: "BTCUSDT-PERP",
      created_utc: "2026-08-25T10:00:01.000Z",
      expires_utc: "2026-08-25T10:00:31.000Z",
      source_observation_id: "observation-1",
      suggested_action: "ENTER_LONG",
      reason: "Positive edge after costs.",
      position_tranche_ids: [],
    },
  }));

  const state = engine.getState();
  const packet = engine.getPacket();
  assert.equal((state.market as Record<string, unknown>).source, "binance-shadow");
  assert.equal((state.market as Record<string, unknown>).mark_price, 61_000);
  assert.equal((packet.decision_event as Record<string, unknown>).event_id, "event-1");
  assert.equal((packet.market_observation as Record<string, unknown>).calibrated, false);
  assert.equal(typeof packet.packet_id, "string");
  assert.equal(String(packet.packet_id).length, 64);
  database.close();
});
