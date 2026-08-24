export const QUANTITY_SCALE = 100_000_000;

export function usdToCents(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error("USD value must be finite");
  }
  return Math.round(value * 100);
}

export function centsToUsd(value: number): number {
  return Number((value / 100).toFixed(2));
}

export function priceToCents(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Price must be positive and finite");
  }
  return Math.round(value * 100);
}

export function centsToPrice(value: number): number {
  return Number((value / 100).toFixed(2));
}

export function pctToBps(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error("Percentage must be finite");
  }
  return Math.round(value * 100);
}

export function bpsToPct(value: number): number {
  return Number((value / 100).toFixed(4));
}

export function applyBps(value: number, bps: number): number {
  return Math.round((value * bps) / 10_000);
}

export function notionalCents(priceCents: number, quantityUnits: number): number {
  return Math.round((priceCents * quantityUnits) / QUANTITY_SCALE);
}

export function pnlCents(
  side: "LONG" | "SHORT",
  entryPriceCents: number,
  exitPriceCents: number,
  quantityUnits: number,
): number {
  const direction = side === "LONG" ? 1 : -1;
  return Math.round(
    (direction * (exitPriceCents - entryPriceCents) * quantityUnits) / QUANTITY_SCALE,
  );
}

export function quantityToString(quantityUnits: number): string {
  const whole = Math.floor(quantityUnits / QUANTITY_SCALE);
  const fraction = String(quantityUnits % QUANTITY_SCALE).padStart(8, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export function roundDownToStep(value: number, step: number): number {
  if (!Number.isInteger(step) || step <= 0) {
    throw new Error("Quantity step must be a positive integer");
  }
  return Math.floor(value / step) * step;
}

export function utcDay(utc: string = new Date().toISOString()): string {
  return utc.slice(0, 10);
}
