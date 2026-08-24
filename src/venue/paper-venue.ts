import type { NativeEntryEvidence, ProtectedEntryRequest, VenueAdapter } from "./venue.js";

export class PaperVenue implements VenueAdapter {
  readonly name = "paper";

  createProtectedEntry(request: ProtectedEntryRequest): NativeEntryEvidence {
    const prefix = nativePrefix(request.intentId);
    return {
      venue: this.name,
      entryOrderId: `${prefix}-ENTRY`,
      stopOrderId: `${prefix}-STOP`,
      targetOrderId: `${prefix}-TARGET`,
      fillPriceCents: request.entryPriceCents,
      protectionStatus: "confirmed",
    };
  }

  replacementProtectionIds(
    trancheId: string,
    causeIntentId: string,
  ): { stopOrderId: string; targetOrderId: string } {
    const prefix = `PAPER-${short(trancheId)}-${short(causeIntentId)}`;
    return {
      stopOrderId: `${prefix}-STOP-REARM`,
      targetOrderId: `${prefix}-TARGET-REARM`,
    };
  }

  closeOrderId(trancheId: string, causeIntentId: string): string {
    return `PAPER-${short(trancheId)}-${short(causeIntentId)}-CLOSE`;
  }
}

function nativePrefix(intentId: string): string {
  return `PAPER-${short(intentId)}`;
}

function short(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "").slice(0, 20).toUpperCase();
}
