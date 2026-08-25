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

export interface BinanceUsdmOwnedProtection {
  positionIntentId: string;
  symbol: string;
  direction: BinanceUsdmPositionDirection;
  quantity: string;
  stopPrice: string;
  targetPrice: string;
  stopClientAlgoId: string;
  targetClientAlgoId: string;
}

export interface BinanceUsdmProtectionRevisionRequest {
  revisionIntentId: string;
  current: BinanceUsdmOwnedProtection;
  reductionQuantity?: string | null;
  nextStopPrice: string;
  nextTargetPrice: string;
}

export interface BinanceUsdmProtectionRevisionIds {
  reductionClientOrderId: string;
  stopClientAlgoId: string;
  targetClientAlgoId: string;
}

export interface ValidatedBinanceUsdmProtectionRevision {
  revisionIntentId: string;
  current: BinanceUsdmOwnedProtection;
  entrySide: BinanceUsdmOrderSide;
  exitSide: BinanceUsdmOrderSide;
  reductionQuantity: string | null;
  remainingQuantity: string;
  nextStopPrice: string;
  nextTargetPrice: string;
  ids: BinanceUsdmProtectionRevisionIds;
}

export interface BinanceUsdmOwnedProtectionCloseRequest {
  closeIntentId: string;
  current: BinanceUsdmOwnedProtection;
}

export interface ValidatedBinanceUsdmOwnedProtectionClose {
  closeIntentId: string;
  current: BinanceUsdmOwnedProtection;
  exitSide: BinanceUsdmOrderSide;
  closeClientOrderId: string;
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

export function validateBinanceUsdmProtectionRevision(
  request: BinanceUsdmProtectionRevisionRequest,
): ValidatedBinanceUsdmProtectionRevision {
  const revisionIntentId = canonicalUuid(request.revisionIntentId);
  const current = canonicalOwnedProtection(request.current);
  const nextStopPrice = canonicalPositiveDecimal(
    request.nextStopPrice,
    "next stop price",
  );
  const nextTargetPrice = canonicalPositiveDecimal(
    request.nextTargetPrice,
    "next target price",
  );
  const reductionQuantity = request.reductionQuantity === undefined ||
      request.reductionQuantity === null
    ? null
    : canonicalPositiveDecimal(request.reductionQuantity, "reduction quantity");
  if (
    reductionQuantity === null &&
    decimalEquals(nextStopPrice, current.stopPrice) &&
    decimalEquals(nextTargetPrice, current.targetPrice)
  ) {
    throw new Error("Binance protection revision must change quantity or geometry");
  }
  const remainingQuantity = reductionQuantity === null
    ? current.quantity
    : subtractPositiveDecimal(current.quantity, reductionQuantity);
  const ids = deriveBinanceUsdmProtectionRevisionIds(revisionIntentId);
  if (
    ids.stopClientAlgoId === current.stopClientAlgoId ||
    ids.stopClientAlgoId === current.targetClientAlgoId ||
    ids.targetClientAlgoId === current.stopClientAlgoId ||
    ids.targetClientAlgoId === current.targetClientAlgoId
  ) {
    throw new Error("Binance replacement protection identities must be new");
  }
  return {
    revisionIntentId,
    current,
    entrySide: current.direction === "LONG" ? "BUY" : "SELL",
    exitSide: current.direction === "LONG" ? "SELL" : "BUY",
    reductionQuantity,
    remainingQuantity,
    nextStopPrice,
    nextTargetPrice,
    ids,
  };
}

export function validateBinanceUsdmOwnedProtectionClose(
  request: BinanceUsdmOwnedProtectionCloseRequest,
): ValidatedBinanceUsdmOwnedProtectionClose {
  const closeIntentId = canonicalUuid(request.closeIntentId);
  const current = canonicalOwnedProtection(request.current);
  return {
    closeIntentId,
    current,
    exitSide: current.direction === "LONG" ? "SELL" : "BUY",
    closeClientOrderId: orderId(
      "gpc",
      closeIntentId.replaceAll("-", ""),
    ),
  };
}

export function deriveBinanceUsdmProtectionRevisionIds(
  revisionIntentId: string,
): BinanceUsdmProtectionRevisionIds {
  const compact = canonicalUuid(revisionIntentId).replaceAll("-", "");
  return {
    reductionClientOrderId: orderId("gcr", compact),
    stopClientAlgoId: orderId("grs", compact),
    targetClientAlgoId: orderId("grt", compact),
  };
}

export function subtractPositiveDecimal(
  minuend: string,
  subtrahend: string,
): string {
  const left = canonicalPositiveDecimal(minuend, "decimal minuend");
  const right = canonicalPositiveDecimal(subtrahend, "decimal subtrahend");
  const leftFraction = left.split(".")[1]?.length ?? 0;
  const rightFraction = right.split(".")[1]?.length ?? 0;
  const scaleDigits = Math.max(leftFraction, rightFraction);
  const scale = 10n ** BigInt(scaleDigits);
  const difference = decimalToScaledInteger(left, scaleDigits, scale) -
    decimalToScaledInteger(right, scaleDigits, scale);
  if (difference <= 0n) {
    throw new Error(
      "Binance reduction quantity must be strictly smaller than current quantity",
    );
  }
  const whole = difference / scale;
  const fraction = (difference % scale).toString().padStart(scaleDigits, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
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

function direction(value: string): BinanceUsdmPositionDirection {
  if (value !== "LONG" && value !== "SHORT") {
    throw new Error("Binance protected position direction must be LONG or SHORT");
  }
  return value;
}

function canonicalClientId(value: string): string {
  if (typeof value !== "string" || !/^[.A-Z:/a-z0-9_-]{1,36}$/.test(value)) {
    throw new Error("Binance owned client order ID is invalid");
  }
  return value;
}

function canonicalOwnedProtection(
  value: BinanceUsdmOwnedProtection,
): BinanceUsdmOwnedProtection {
  const current = {
    positionIntentId: canonicalUuid(value.positionIntentId),
    symbol: canonicalSymbol(value.symbol),
    direction: direction(value.direction),
    quantity: canonicalPositiveDecimal(value.quantity, "current quantity"),
    stopPrice: canonicalPositiveDecimal(value.stopPrice, "current stop price"),
    targetPrice: canonicalPositiveDecimal(value.targetPrice, "current target price"),
    stopClientAlgoId: canonicalClientId(value.stopClientAlgoId),
    targetClientAlgoId: canonicalClientId(value.targetClientAlgoId),
  };
  if (current.stopClientAlgoId === current.targetClientAlgoId) {
    throw new Error("Binance current stop and target identities must differ");
  }
  return current;
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

function decimalToScaledInteger(
  value: string,
  scaleDigits: number,
  scale: bigint,
): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * scale +
    BigInt(fraction.padEnd(scaleDigits, "0") || "0");
}

function orderId(prefix: string, compactUuid: string): string {
  const value = prefix + "-" + compactUuid;
  if (value.length > 36 || !/^[.A-Z:/a-z0-9_-]{1,36}$/.test(value)) {
    throw new Error("derived Binance client order ID is invalid");
  }
  return value;
}
