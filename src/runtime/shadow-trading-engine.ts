import { bodyHash } from "../domain/canonical-json.js";
import { TradingEngine } from "../core/trading-engine.js";
import type { GlitchDatabase } from "../storage/database.js";
import type { VenueAdapter } from "../venue/venue.js";
import type { ShadowRuntimeProvider } from "./binance-shadow-runtime.js";

export class ShadowTradingEngine extends TradingEngine {
  private runtime: ShadowRuntimeProvider | null = null;

  constructor(database: GlitchDatabase, venue: VenueAdapter) {
    super(database, venue);
  }

  attachRuntime(runtime: ShadowRuntimeProvider): void {
    this.runtime = runtime;
  }

  override getHealth(): Record<string, unknown> {
    return {
      ...super.getHealth(),
      runtime: this.runtime?.snapshot().status ?? {
        mode: "paper",
        running: false,
        mutation_authority: false,
      },
    };
  }

  override getState(): Record<string, unknown> {
    const base = super.getState();
    const runtime = this.runtime?.snapshot() ?? null;
    const baseMarket = objectValue(base.market);
    const liveMarket = runtime?.market_observation.market;
    return {
      ...base,
      market: liveMarket
        ? {
            ...baseMarket,
            source: "binance-shadow",
            instrument: liveMarket.instrument,
            mark_price: liveMarket.mark_price ?? baseMarket.mark_price,
            index_price: liveMarket.index_price,
            best_bid: liveMarket.best_bid,
            best_ask: liveMarket.best_ask,
            spread_bps: liveMarket.spread_bps,
            funding_rate: liveMarket.funding_rate,
            observed_utc: runtime.market_observation.observed_utc,
          }
        : baseMarket,
      runtime: runtime?.status ?? {
        mode: "paper",
        running: false,
        mutation_authority: false,
      },
    };
  }

  override getPacket(): Record<string, unknown> {
    const base = super.getPacket();
    const runtime = this.runtime?.snapshot() ?? null;
    const core = {
      ...withoutPacketId(base),
      market_observation: runtime?.market_observation ?? null,
      decision_event: runtime?.decision_event ?? null,
      runtime: runtime?.status ?? {
        mode: "paper",
        running: false,
        mutation_authority: false,
      },
    };
    return {
      ...core,
      packet_id: bodyHash(core),
    };
  }
}

function withoutPacketId(value: Record<string, unknown>): Record<string, unknown> {
  const output = { ...value };
  delete output.packet_id;
  return output;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
