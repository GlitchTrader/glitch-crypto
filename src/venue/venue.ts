import type { PositionSide } from "../domain/types.js";

export interface ProtectedEntryRequest {
  intentId: string;
  instrument: string;
  side: PositionSide;
  quantityUnits: number;
  entryPriceCents: number;
  stopPriceCents: number;
  targetPriceCents: number;
}

export interface NativeEntryEvidence {
  venue: string;
  entryOrderId: string;
  stopOrderId: string;
  targetOrderId: string;
  fillPriceCents: number;
  protectionStatus: "confirmed";
}

export interface VenueAdapter {
  readonly name: string;
  createProtectedEntry(request: ProtectedEntryRequest): NativeEntryEvidence;
  replacementProtectionIds(trancheId: string, causeIntentId: string): {
    stopOrderId: string;
    targetOrderId: string;
  };
  closeOrderId(trancheId: string, causeIntentId: string): string;
}
