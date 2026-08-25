import type {
  BinanceUsdmOwnedProtectionCloseRequest,
  BinanceUsdmProtectedEntryRequest,
  BinanceUsdmProtectionRevisionRequest,
} from "./mutation-contract.js";
import type { BinanceUsdmProtectedEntryResult } from "./protection-coordinator.js";
import type {
  BinanceUsdmOwnedProtectionCloseResult,
  BinanceUsdmProtectionRevisionResult,
} from "./protection-revision.js";
import type { BinanceUsdmTestnetExecutionEffects } from "./testnet-orchestrator.js";

export interface BinanceUsdmProtectedEntryEffectsPort {
  createProtectedEntry(request: BinanceUsdmProtectedEntryRequest): Promise<BinanceUsdmProtectedEntryResult>;
  reconcileProtectedEntry(request: BinanceUsdmProtectedEntryRequest): Promise<BinanceUsdmProtectedEntryResult>;
}

export interface BinanceUsdmProtectionManagementEffectsPort {
  revise(request: BinanceUsdmProtectionRevisionRequest): Promise<BinanceUsdmProtectionRevisionResult>;
  reconcile(request: BinanceUsdmProtectionRevisionRequest): Promise<BinanceUsdmProtectionRevisionResult>;
  closeOwnedProtection(request: BinanceUsdmOwnedProtectionCloseRequest): Promise<BinanceUsdmOwnedProtectionCloseResult>;
  reconcileOwnedProtectionClose(request: BinanceUsdmOwnedProtectionCloseRequest): Promise<BinanceUsdmOwnedProtectionCloseResult>;
}

export class BinanceUsdmTestnetExecutionEffectsAdapter
implements BinanceUsdmTestnetExecutionEffects {
  constructor(
    private readonly entry: BinanceUsdmProtectedEntryEffectsPort,
    private readonly management: BinanceUsdmProtectionManagementEffectsPort,
  ) {}

  createProtectedEntry(
    request: BinanceUsdmProtectedEntryRequest,
  ): Promise<BinanceUsdmProtectedEntryResult> {
    return this.entry.createProtectedEntry(request);
  }

  reconcileProtectedEntry(
    request: BinanceUsdmProtectedEntryRequest,
  ): Promise<BinanceUsdmProtectedEntryResult> {
    return this.entry.reconcileProtectedEntry(request);
  }

  reviseProtection(
    request: BinanceUsdmProtectionRevisionRequest,
  ): Promise<BinanceUsdmProtectionRevisionResult> {
    return this.management.revise(request);
  }

  reconcileProtectionRevision(
    request: BinanceUsdmProtectionRevisionRequest,
  ): Promise<BinanceUsdmProtectionRevisionResult> {
    return this.management.reconcile(request);
  }

  closeOwnedProtection(
    request: BinanceUsdmOwnedProtectionCloseRequest,
  ): Promise<BinanceUsdmOwnedProtectionCloseResult> {
    return this.management.closeOwnedProtection(request);
  }

  reconcileOwnedProtectionClose(
    request: BinanceUsdmOwnedProtectionCloseRequest,
  ): Promise<BinanceUsdmOwnedProtectionCloseResult> {
    return this.management.reconcileOwnedProtectionClose(request);
  }
}
