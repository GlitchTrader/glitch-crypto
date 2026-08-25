import { bodyHash } from "../domain/canonical-json.js";
import { TradingEngine } from "../core/trading-engine.js";
import type { IntentReceipt } from "../domain/types.js";
import { nowUtc, type GlitchDatabase } from "../storage/database.js";
import type { VenueAdapter } from "../venue/venue.js";
import type {
  ShadowDecisionEvent,
  ShadowRuntimeProvider,
} from "./binance-shadow-runtime.js";

interface PacketBinding {
  eventId: string;
  expiresUtc: string;
}

const MAXIMUM_PACKET_BINDINGS = 500;
const ACTIONS_REQUIRING_CURRENT_EVENT = new Set([
  "ENTER_LONG",
  "ENTER_SHORT",
  "HOLD",
  "MOVE_STOP",
  "MOVE_TARGET",
]);

export class ShadowTradingEngine extends TradingEngine {
  private runtime: ShadowRuntimeProvider | null = null;
  private readonly packetBindings = new Map<string, PacketBinding>();

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
    const packetId = bodyHash(core);
    if (runtime?.decision_event) {
      this.rememberPacket(packetId, runtime.decision_event);
    }
    return {
      ...core,
      packet_id: packetId,
    };
  }

  override submitIntent(input: unknown): IntentReceipt {
    const record = objectValue(input);
    const action = typeof record.action === "string" ? record.action : "";
    const packetId = typeof record.packet_id === "string" ? record.packet_id : "";
    const runtime = this.runtime?.snapshot() ?? null;
    const binding = packetId ? this.packetBindings.get(packetId) : undefined;
    const currentEvent = runtime?.decision_event ?? null;

    if (
      runtime?.status.mode === "binance-shadow" &&
      runtime.status.running &&
      ACTIONS_REQUIRING_CURRENT_EVENT.has(action) &&
      !bindingMatchesCurrentEvent(binding, currentEvent)
    ) {
      return rejectedReceipt(input, "intent_packet_is_not_bound_to_current_decision_event");
    }

    const receipt = super.submitIntent(input);
    if (
      receipt.accepted &&
      binding &&
      currentEvent &&
      bindingMatchesCurrentEvent(binding, currentEvent)
    ) {
      this.runtime?.acknowledgeDecision(currentEvent.event_id);
    }
    return receipt;
  }

  private rememberPacket(packetId: string, event: ShadowDecisionEvent): void {
    const now = Date.now();
    for (const [key, binding] of this.packetBindings) {
      const expires = Date.parse(binding.expiresUtc);
      if (!Number.isFinite(expires) || expires <= now) {
        this.packetBindings.delete(key);
      }
    }
    this.packetBindings.set(packetId, {
      eventId: event.event_id,
      expiresUtc: event.expires_utc,
    });
    while (this.packetBindings.size > MAXIMUM_PACKET_BINDINGS) {
      const oldest = this.packetBindings.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.packetBindings.delete(oldest);
    }
  }
}

function bindingMatchesCurrentEvent(
  binding: PacketBinding | undefined,
  current: ShadowDecisionEvent | null,
): boolean {
  if (!binding || !current || binding.eventId !== current.event_id) {
    return false;
  }
  const bindingExpiry = Date.parse(binding.expiresUtc);
  const eventExpiry = Date.parse(current.expires_utc);
  const now = Date.now();
  return Number.isFinite(bindingExpiry) && Number.isFinite(eventExpiry) &&
    bindingExpiry > now && eventExpiry > now;
}

function rejectedReceipt(input: unknown, reason: string): IntentReceipt {
  const record = objectValue(input);
  return {
    schema_version: "glitch.crypto.intent-receipt.v1",
    intent_id: typeof record.intent_id === "string" ? record.intent_id : "invalid-intent",
    body_hash: bodyHash(input),
    state: "rejected",
    accepted: false,
    replayed: false,
    reason,
    recorded_utc: nowUtc(),
  };
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
