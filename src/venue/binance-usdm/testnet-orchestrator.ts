import { bodyHash } from "../../domain/canonical-json.js";
import type { BinanceUsdmProtectedEntryPlan } from "./entry-plan.js";
import type { BinanceUsdmProtectionManagementPlan } from "./management-plan.js";
import {
  canonicalPositiveDecimal,
  type BinanceUsdmOwnedProtectionCloseRequest,
  type BinanceUsdmProtectedEntryRequest,
  type BinanceUsdmProtectionRevisionRequest,
} from "./mutation-contract.js";
import {
  applyBinanceUsdmOwnedProtectionCloseResult,
  applyBinanceUsdmProtectedEntryResult,
  applyBinanceUsdmProtectionRevisionResult,
  BinanceUsdmOwnedProtectionRepository,
  stageBinanceUsdmOwnedProtectionClose,
  stageBinanceUsdmProtectedEntry,
  stageBinanceUsdmProtectionRevision,
  type BinanceUsdmOwnedProtectionBinding,
  type BinanceUsdmOwnedProtectionSnapshot,
} from "./owned-protection-state.js";
import type { BinanceUsdmProtectedEntryResult } from "./protection-coordinator.js";
import type {
  BinanceUsdmOwnedProtectionCloseResult,
  BinanceUsdmProtectionRevisionResult,
} from "./protection-revision.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAXIMUM_PERMIT_LIFETIME_MS = 5 * 60_000;

export type BinanceUsdmTestnetPermitAction =
  | "protected_entry"
  | "protection_revision"
  | "owned_position_close";

export interface BinanceUsdmTestnetMutationPermit {
  schema_version: "glitch.crypto.binance-usdm-testnet-mutation-permit.v1";
  permit_id: string;
  intent_id: string;
  environment: "testnet";
  symbol: "BTCUSDT";
  action: BinanceUsdmTestnetPermitAction;
  proof_body_hash: string;
  maximum_quantity: string;
  issued_utc: string;
  expires_utc: string;
}

export interface BinanceUsdmTestnetExecutionEffects {
  createProtectedEntry(
    request: BinanceUsdmProtectedEntryRequest,
  ): Promise<BinanceUsdmProtectedEntryResult>;
  reconcileProtectedEntry(
    request: BinanceUsdmProtectedEntryRequest,
  ): Promise<BinanceUsdmProtectedEntryResult>;
  closeOwnedProtection(
    request: BinanceUsdmOwnedProtectionCloseRequest,
  ): Promise<BinanceUsdmOwnedProtectionCloseResult>;
  reviseProtection(
    request: BinanceUsdmProtectionRevisionRequest,
  ): Promise<BinanceUsdmProtectionRevisionResult>;
  reconcileOwnedProtectionClose(
    request: BinanceUsdmOwnedProtectionCloseRequest,
  ): Promise<BinanceUsdmOwnedProtectionCloseResult>;
  reconcileProtectionRevision(
    request: BinanceUsdmProtectionRevisionRequest,
  ): Promise<BinanceUsdmProtectionRevisionResult>;
}

export interface BinanceUsdmOrchestratedResult<T> {
  result: T;
  ownership: BinanceUsdmOwnedProtectionSnapshot;
}

export interface BinanceUsdmRecoveryResult {
  kind: "none" | "protected_entry" | "protection_revision" | "owned_position_close";
  result:
    | BinanceUsdmProtectedEntryResult
    | BinanceUsdmProtectionRevisionResult
    | BinanceUsdmOwnedProtectionCloseResult
    | null;
  ownership: BinanceUsdmOwnedProtectionSnapshot;
}

export interface BinanceUsdmTestnetOrchestratorOptions {
  now?: () => number;
  proofMaxAgeMs?: number;
}

export class BinanceUsdmTestnetExecutionOrchestrator {
  private readonly now: () => number;
  private readonly proofMaxAgeMs: number;
  private active = false;

  constructor(
    private readonly repository: BinanceUsdmOwnedProtectionRepository,
    private readonly effects: BinanceUsdmTestnetExecutionEffects,
    options: BinanceUsdmTestnetOrchestratorOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.proofMaxAgeMs = integer(
      options.proofMaxAgeMs ?? 1_000,
      1,
      60_000,
      "orchestrator proof maximum age",
    );
  }

  executeProtectedEntry(
    plan: BinanceUsdmProtectedEntryPlan,
    permit: BinanceUsdmTestnetMutationPermit,
  ): Promise<BinanceUsdmOrchestratedResult<BinanceUsdmProtectedEntryResult>> {
    return this.exclusive(async () => {
      if (
        plan.schema_version !== "glitch.crypto.binance-usdm-protected-entry-plan.v1" ||
        plan.status !== "ready" ||
        plan.request === null ||
        plan.mutation_authority !== false ||
        plan.engine_binding_authority !== false ||
        plan.blockers.length > 0
      ) {
        throw new Error("protected entry requires a ready non-authorizing plan");
      }
      this.assertFresh(plan.observed_utc, "protected entry plan");
      validatePermit(
        permit,
        "protected_entry",
        plan.request.intentId,
        plan.request.symbol,
        plan.request.quantity,
        bodyHash(plan),
        this.now(),
      );

      const loaded = this.repository.load();
      const stagedState = stageBinanceUsdmProtectedEntry(
        loaded.state,
        plan.request,
        new Date(this.now()).toISOString(),
      );
      const staged = this.repository.save(loaded.storage_version, stagedState);
      const result = await this.effects.createProtectedEntry(plan.request);
      const completedState = applyBinanceUsdmProtectedEntryResult(
        staged.state,
        plan.request,
        result,
        new Date(this.now()).toISOString(),
      );
      return {
        result,
        ownership: this.repository.save(staged.storage_version, completedState),
      };
    });
  }

  executeOwnedPositionClose(
    binding: BinanceUsdmOwnedProtectionBinding,
    closeIntentId: string,
    permit: BinanceUsdmTestnetMutationPermit,
  ): Promise<BinanceUsdmOrchestratedResult<BinanceUsdmOwnedProtectionCloseResult>> {
    return this.exclusive(async () => {
      if (
        binding.schema_version !== "glitch.crypto.binance-usdm-owned-protection-binding.v1" ||
        binding.status !== "ready" ||
        binding.current === null ||
        binding.pending !== null ||
        binding.management_preconditions_satisfied !== true ||
        binding.mutation_authority !== false ||
        binding.engine_binding_authority !== false ||
        binding.blockers.length > 0
      ) {
        throw new Error("owned close requires a ready non-authorizing binding");
      }
      this.assertFresh(binding.observed_utc, "owned protection binding");
      const request: BinanceUsdmOwnedProtectionCloseRequest = {
        closeIntentId,
        current: { ...binding.current },
      };
      validatePermit(
        permit,
        "owned_position_close",
        closeIntentId,
        binding.current.symbol,
        binding.current.quantity,
        bodyHash(binding),
        this.now(),
      );

      const loaded = this.repository.load();
      if (bodyHash(loaded.state) !== binding.state_body_hash) {
        throw new Error("owned protection binding is stale relative to durable state");
      }
      const stagedState = stageBinanceUsdmOwnedProtectionClose(
        loaded.state,
        request,
        new Date(this.now()).toISOString(),
      );
      const staged = this.repository.save(loaded.storage_version, stagedState);
      const result = await this.effects.closeOwnedProtection(request);
      const completedState = applyBinanceUsdmOwnedProtectionCloseResult(
        staged.state,
        request,
        result,
        new Date(this.now()).toISOString(),
      );
      return {
        result,
        ownership: this.repository.save(staged.storage_version, completedState),
      };
    });
  }

  executeProtectionRevision(
    plan: BinanceUsdmProtectionManagementPlan,
    permit: BinanceUsdmTestnetMutationPermit,
  ): Promise<BinanceUsdmOrchestratedResult<BinanceUsdmProtectionRevisionResult>> {
    return this.exclusive(async () => {
      if (
        plan.schema_version !== "glitch.crypto.binance-usdm-protection-management-plan.v1" ||
        plan.status !== "ready" ||
        plan.request === null ||
        plan.mutation_authority !== false ||
        plan.engine_binding_authority !== false ||
        plan.blockers.length > 0
      ) {
        throw new Error("protection revision requires a ready non-authorizing management plan");
      }
      this.assertFresh(plan.observed_utc, "protection management plan");
      validatePermit(
        permit,
        "protection_revision",
        plan.request.revisionIntentId,
        plan.request.current.symbol,
        plan.request.current.quantity,
        bodyHash(plan),
        this.now(),
      );

      const loaded = this.repository.load();
      if (
        bodyHash(loaded.state) !== plan.binding_state_body_hash ||
        loaded.state.transition_sequence !== plan.binding_transition_sequence
      ) {
        throw new Error("protection management plan is stale relative to durable state");
      }
      const stagedState = stageBinanceUsdmProtectionRevision(
        loaded.state,
        plan.request,
        new Date(this.now()).toISOString(),
      );
      const staged = this.repository.save(loaded.storage_version, stagedState);
      const result = await this.effects.reviseProtection(plan.request);
      const completedState = applyBinanceUsdmProtectionRevisionResult(
        staged.state,
        plan.request,
        result,
        new Date(this.now()).toISOString(),
      );
      return {
        result,
        ownership: this.repository.save(staged.storage_version, completedState),
      };
    });
  }

  recoverPending(): Promise<BinanceUsdmRecoveryResult> {
    return this.exclusive(async () => {
      const loaded = this.repository.load();
      const pending = loaded.state.pending;
      if (pending === null) {
        return { kind: "none", result: null, ownership: loaded };
      }
      const recordedUtc = new Date(this.now()).toISOString();
      if (pending.kind === "protected_entry") {
        const result = await this.effects.reconcileProtectedEntry(pending.request);
        const state = applyBinanceUsdmProtectedEntryResult(
          loaded.state,
          pending.request,
          result,
          recordedUtc,
        );
        return {
          kind: pending.kind,
          result,
          ownership: this.repository.save(loaded.storage_version, state),
        };
      }
      if (pending.kind === "protection_revision") {
        const result = await this.effects.reconcileProtectionRevision(pending.request);
        const state = applyBinanceUsdmProtectionRevisionResult(
          loaded.state,
          pending.request,
          result,
          recordedUtc,
        );
        return {
          kind: pending.kind,
          result,
          ownership: this.repository.save(loaded.storage_version, state),
        };
      }
      const result = await this.effects.reconcileOwnedProtectionClose(pending.request);
      const state = applyBinanceUsdmOwnedProtectionCloseResult(
        loaded.state,
        pending.request,
        result,
        recordedUtc,
      );
      return {
        kind: pending.kind,
        result,
        ownership: this.repository.save(loaded.storage_version, state),
      };
    });
  }

  private assertFresh(value: string, name: string): void {
    const observed = Date.parse(value);
    const now = this.now();
    if (!Number.isFinite(observed) || observed > now || now - observed > this.proofMaxAgeMs) {
      throw new Error(`${name} is stale or future-dated`);
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active) {
      throw new Error("Binance Testnet execution operation is already in progress");
    }
    this.active = true;
    try {
      return await operation();
    } finally {
      this.active = false;
    }
  }
}

function validatePermit(
  permit: BinanceUsdmTestnetMutationPermit,
  action: BinanceUsdmTestnetPermitAction,
  intentId: string,
  symbol: string,
  quantity: string,
  proofBodyHash: string,
  now: number,
): void {
  const maximumQuantity = canonicalPositiveDecimal(
    permit.maximum_quantity,
    "permit maximum quantity",
  );
  const issued = Date.parse(permit.issued_utc);
  const expires = Date.parse(permit.expires_utc);
  if (
    permit.schema_version !== "glitch.crypto.binance-usdm-testnet-mutation-permit.v1" ||
    !UUID.test(permit.permit_id) ||
    permit.intent_id !== intentId ||
    !UUID.test(permit.intent_id) ||
    permit.environment !== "testnet" ||
    permit.symbol !== "BTCUSDT" ||
    symbol !== permit.symbol ||
    permit.action !== action ||
    !/^[0-9a-f]{64}$/.test(permit.proof_body_hash) ||
    permit.proof_body_hash !== proofBodyHash ||
    !Number.isFinite(issued) ||
    !Number.isFinite(expires) ||
    issued > now ||
    expires <= now ||
    expires <= issued ||
    expires - issued > MAXIMUM_PERMIT_LIFETIME_MS ||
    comparePositiveDecimals(quantity, maximumQuantity) > 0
  ) {
    throw new Error("bounded Binance Testnet mutation permit is invalid");
  }
}

function comparePositiveDecimals(left: string, right: string): number {
  const [leftWhole = "0", leftFraction = ""] = left.split(".");
  const [rightWhole = "0", rightFraction = ""] = right.split(".");
  const digits = Math.max(leftFraction.length, rightFraction.length);
  const scale = 10n ** BigInt(digits);
  const leftValue = BigInt(leftWhole) * scale + BigInt(leftFraction.padEnd(digits, "0") || "0");
  const rightValue = BigInt(rightWhole) * scale + BigInt(rightFraction.padEnd(digits, "0") || "0");
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function integer(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}
