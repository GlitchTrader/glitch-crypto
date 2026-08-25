export type BinanceUsdmPositionDirection = "LONG" | "SHORT";
export type BinanceUsdmOrderSide = "BUY" | "SELL";
export type BinanceUsdmAlgoOrderType = "STOP_MARKET" | "TAKE_PROFIT_MARKET";

export interface BinanceUsdmProtectedEntryRequest {
  intentId: string;
  symbol: string;
  direction: BinanceUsdmPositionDirection;
  quantity: string;
  stopPrice: string;
  targetPrice: string;
}

export interface BinanceUsdmMutationIds {
  entryClientOrderId: string;
  stopClientAlgoId: string;
  targetClientAlgoId: string;
  emergencyCloseClientOrderId: string;
}

export interface ValidatedBinanceUsdmProtectedEntry {
  intentId: string;
  symbol: string;
  direction: BinanceUsdmPositionDirection;
  entrySide: BinanceUsdmOrderSide;
  exitSide: BinanceUsdmOrderSide;
  quantity: string;
  stopPrice: string;
  targetPrice: string;
  ids: BinanceUsdmMutationIds;
}

export function validateBinanceUsdmProtectedEntry(
  request: BinanceUsdmProtectedEntryRequest,
): ValidatedBinanceUsdmProtectedEntry {
  const intentId = canonicalUuid(request.intentId);
  const symbol = canonicalSymbol(request.symbol);
  const quantity = canonicalPositiveDecimal(request.quantity, "quantity");
  const stopPrice = canonicalPositiveDecimal(request.stopPrice, "stop price");
  const targetPrice = canonicalPositiveDecimal(request.targetPrice, "target price");
  if (request.direction !== "LONG" && request.direction !== "SHORT") {
    throw new Error("Binance protected entry direction must be LONG or SHORT");
  }
  return {
    intentId,
    symbol,
    direction: request.direction,
    entrySide: request.direction === "LONG" ? "BUY" : "SELL",
    exitSide: request.direction === "LONG" ? "SELL" : "BUY",
    quantity,
    stopPrice,
    targetPrice,
    ids: deriveBinanceUsdmMutationIds(intentId),
  };
}

export function deriveBinanceUsdmMutationIds(intentId: string): BinanceUsdmMutationIds {
  const compact = canonicalUuid(intentId).replaceAll("-", "");
  return {
    entryClientOrderId: orderId("gce", compact),
    stopClientAlgoId: orderId("gcs", compact),
    targetClientAlgoId: orderId("gct", compact),
    emergencyCloseClientOrderId: orderId("gcf", compact),
  };
}

export function canonicalPositiveDecimal(value: string, name: string): string {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new Error("Binance " + name + " must be a plain nonnegative decimal string");
  }
  const canonical = canonicalDecimal(value);
  if (canonical === "0") {
    throw new Error("Binance " + name + " must be greater than zero");
  }
  return canonical;
}

export function decimalEquals(left: unknown, right: string): boolean {
  if (typeof left !== "string" && typeof left !== "number") {
    return false;
  }
  const value = String(left);
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    return false;
  }
  return canonicalDecimal(value) === canonicalDecimal(right);
}

export function positiveDecimal(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  try {
    return canonicalPositiveDecimal(String(value), "response decimal");
  } catch {
    return null;
  }
}

export function objectRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function stringValue(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function canonicalUuid(value: string): string {
  const canonical = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(canonical)) {
    throw new Error("Binance mutation intent ID must be a canonical UUID");
  }
  return canonical;
}

function canonicalSymbol(value: string): string {
  const symbol = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!/^[A-Z0-9]{5,24}$/.test(symbol)) {
    throw new Error("Binance mutation symbol must contain 5-24 uppercase alphanumeric characters");
  }
  return symbol;
}

function canonicalDecimal(value: string): string {
  const [whole = "0", fraction = ""] = value.split(".");
  const trimmedFraction = fraction.replace(/0+$/, "");
  return trimmedFraction.length > 0 ? whole + "." + trimmedFraction : whole;
}

function orderId(prefix: string, compactUuid: string): string {
  const value = prefix + "-" + compactUuid;
  if (value.length > 36 || !/^[.A-Z:/a-z0-9_-]{1,36}$/.test(value)) {
    throw new Error("derived Binance client order ID is invalid");
  }
  return value;
}
