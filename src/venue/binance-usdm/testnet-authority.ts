import { randomUUID } from "node:crypto";
import { bodyHash } from "../../domain/canonical-json.js";
import type { BinanceUsdmProtectedEntryPlan } from "./entry-plan.js";
import type { BinanceUsdmProtectionManagementPlan } from "./management-plan.js";
import { validateBinanceUsdmOwnedProtectionClose } from "./mutation-contract.js";
import type { BinanceUsdmOwnedProtectionBinding } from "./owned-protection-state.js";
import type {
  BinanceUsdmTestnetMutationPermit,
  BinanceUsdmTestnetPermitAction,
} from "./testnet-orchestrator.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAXIMUM_PERMIT_LIFETIME_MS = 5 * 60_000;

export interface BinanceUsdmTestnetPermitIssuerOptions {
  operatorToken: string;
  now?: () => number;
  permitIdFactory?: () => string;
  lifetimeMs?: number;
  proofMaxAgeMs?: number;
}

export class BinanceUsdmTestnetPermitIssuer {
  private readonly operatorToken: string;
  private readonly now: () => number;
  private readonly permitIdFactory: () => string;
  private readonly lifetimeMs: number;
  private readonly proofMaxAgeMs: number;

  constructor(options: BinanceUsdmTestnetPermitIssuerOptions) {
    this.operatorToken = options.operatorToken.trim();
    if (this.operatorToken.length < 16) {
      throw new Error("Binance Testnet permit issuer requires an operator token");
    }
    this.now = options.now ?? Date.now;
    this.permitIdFactory = options.permitIdFactory ?? randomUUID;
    this.lifetimeMs = integer(
      options.lifetimeMs ?? 30_000,
      1,
      MAXIMUM_PERMIT_LIFETIME_MS,
      "permit lifetime",
    );
    this.proofMaxAgeMs = integer(
      options.proofMaxAgeMs ?? 1_000,
      1,
      60_000,
      "permit proof maximum age",
    );
  }

  issueProtectedEntry(
    authorization: string,
    plan: BinanceUsdmProtectedEntryPlan,
  ): BinanceUsdmTestnetMutationPermit {
    this.authorize(authorization);
    if (
      plan.schema_version !== "glitch.crypto.binance-usdm-protected-entry-plan.v1" ||
      plan.venue !== "binance-usdm" ||
      plan.environment !== "testnet" ||
      plan.status !== "ready" ||
      plan.request === null ||
      plan.request.symbol !== "BTCUSDT" ||
      plan.mutation_authority !== false ||
      plan.engine_binding_authority !== false ||
      plan.blockers.length > 0
    ) throw new Error("operator permit requires a ready protected-entry proof");
    this.assertFresh(plan.observed_utc);
    return this.issue(
      "protected_entry",
      plan.request.intentId,
      plan.request.quantity,
      plan,
    );
  }

  issueProtectionRevision(
    authorization: string,
    plan: BinanceUsdmProtectionManagementPlan,
  ): BinanceUsdmTestnetMutationPermit {
    this.authorize(authorization);
    if (
      plan.schema_version !== "glitch.crypto.binance-usdm-protection-management-plan.v1" ||
      plan.venue !== "binance-usdm" ||
      plan.environment !== "testnet" ||
      plan.status !== "ready" ||
      plan.request === null ||
      plan.request.current.symbol !== "BTCUSDT" ||
      plan.mutation_authority !== false ||
      plan.engine_binding_authority !== false ||
      plan.blockers.length > 0
    ) throw new Error("operator permit requires a ready protection-management proof");
    this.assertFresh(plan.observed_utc);
    return this.issue(
      "protection_revision",
      plan.request.revisionIntentId,
      plan.request.current.quantity,
      plan,
    );
  }

  issueOwnedPositionClose(
    authorization: string,
    binding: BinanceUsdmOwnedProtectionBinding,
    closeIntentId: string,
  ): BinanceUsdmTestnetMutationPermit {
    this.authorize(authorization);
    if (
      binding.schema_version !== "glitch.crypto.binance-usdm-owned-protection-binding.v1" ||
      binding.venue !== "binance-usdm" ||
      binding.environment !== "testnet" ||
      binding.status !== "ready" ||
      binding.current === null ||
      binding.current.symbol !== "BTCUSDT" ||
      binding.pending !== null ||
      binding.management_preconditions_satisfied !== true ||
      binding.mutation_authority !== false ||
      binding.engine_binding_authority !== false ||
      binding.blockers.length > 0
    ) throw new Error("operator permit requires a ready owned-protection proof");
    this.assertFresh(binding.observed_utc);
    const close = validateBinanceUsdmOwnedProtectionClose({
      closeIntentId,
      current: binding.current,
    });
    return this.issue(
      "owned_position_close",
      close.closeIntentId,
      close.current.quantity,
      binding,
    );
  }

  private authorize(authorization: string): void {
    if (authorization !== `Bearer ${this.operatorToken}`) {
      throw new Error("operator authorization required for Binance Testnet permit");
    }
  }

  private assertFresh(observedUtc: string): void {
    const observed = Date.parse(observedUtc);
    const now = this.now();
    if (!Number.isFinite(observed) || observed > now || now - observed > this.proofMaxAgeMs) {
      throw new Error("operator permit proof is stale or future-dated");
    }
  }

  private issue(
    action: BinanceUsdmTestnetPermitAction,
    intentId: string,
    maximumQuantity: string,
    proof: unknown,
  ): BinanceUsdmTestnetMutationPermit {
    const permitId = this.permitIdFactory().trim().toLowerCase();
    if (!UUID.test(permitId) || !UUID.test(intentId)) {
      throw new Error("operator permit identity is invalid");
    }
    const issued = this.now();
    if (!Number.isSafeInteger(issued) || issued <= 0) {
      throw new Error("operator permit clock is invalid");
    }
    return Object.freeze({
      schema_version: "glitch.crypto.binance-usdm-testnet-mutation-permit.v1",
      permit_id: permitId,
      intent_id: intentId,
      environment: "testnet",
      symbol: "BTCUSDT",
      action,
      proof_body_hash: bodyHash(proof),
      maximum_quantity: maximumQuantity,
      issued_utc: new Date(issued).toISOString(),
      expires_utc: new Date(issued + this.lifetimeMs).toISOString(),
    });
  }
}

function integer(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}
