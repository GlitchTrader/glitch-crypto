export interface BinanceUsdmSymbolRules {
  schema_version: "glitch.crypto.binance-usdm-symbol-rules.v1";
  venue: "binance-usdm";
  symbol: string;
  status: "TRADING";
  contract_type: "PERPETUAL";
  base_asset: string;
  quote_asset: string;
  margin_asset: string;
  price_precision: number;
  quantity_precision: number;
  tick_size: string;
  minimum_price: string;
  maximum_price: string;
  quantity_step: string;
  minimum_quantity: string;
  maximum_quantity: string;
  market_quantity_step: string;
  market_minimum_quantity: string;
  market_maximum_quantity: string;
  minimum_notional: string;
  supported_order_types: string[];
  supported_time_in_force: string[];
}

export function parseBinanceUsdmSymbolRules(
  exchangeInfo: unknown,
  requestedSymbol: string,
): BinanceUsdmSymbolRules {
  const root = objectValue(exchangeInfo, "exchange information");
  const symbols = arrayValue(root.symbols, "exchange information symbols");
  const symbol = symbols
    .map((item) => objectValue(item, "exchange information symbol"))
    .find((item) => stringValue(item.symbol, "symbol") === requestedSymbol);
  if (!symbol) {
    throw new Error(`Binance USDⓈ-M symbol ${requestedSymbol} is unavailable`);
  }
  const status = stringValue(symbol.status, "symbol status");
  const contractType = stringValue(symbol.contractType, "contract type");
  if (status !== "TRADING") {
    throw new Error(`Binance USDⓈ-M symbol ${requestedSymbol} is not trading`);
  }
  if (contractType !== "PERPETUAL") {
    throw new Error(`Binance USDⓈ-M symbol ${requestedSymbol} is not perpetual`);
  }

  const filters = arrayValue(symbol.filters, "symbol filters")
    .map((item) => objectValue(item, "symbol filter"));
  const price = filter(filters, "PRICE_FILTER");
  const lot = filter(filters, "LOT_SIZE");
  const marketLot = optionalFilter(filters, "MARKET_LOT_SIZE") ?? lot;
  const notional = optionalFilter(filters, "MIN_NOTIONAL") ?? optionalFilter(filters, "NOTIONAL");
  if (!notional) {
    throw new Error(`Binance USDⓈ-M symbol ${requestedSymbol} has no notional filter`);
  }

  return {
    schema_version: "glitch.crypto.binance-usdm-symbol-rules.v1",
    venue: "binance-usdm",
    symbol: requestedSymbol,
    status: "TRADING",
    contract_type: "PERPETUAL",
    base_asset: stringValue(symbol.baseAsset, "base asset"),
    quote_asset: stringValue(symbol.quoteAsset, "quote asset"),
    margin_asset: stringValue(symbol.marginAsset, "margin asset"),
    price_precision: integerValue(symbol.pricePrecision, "price precision"),
    quantity_precision: integerValue(symbol.quantityPrecision, "quantity precision"),
    tick_size: positiveDecimal(price.tickSize, "tick size"),
    minimum_price: decimal(price.minPrice, "minimum price"),
    maximum_price: decimal(price.maxPrice, "maximum price"),
    quantity_step: positiveDecimal(lot.stepSize, "quantity step"),
    minimum_quantity: decimal(lot.minQty, "minimum quantity"),
    maximum_quantity: decimal(lot.maxQty, "maximum quantity"),
    market_quantity_step: positiveDecimal(marketLot.stepSize, "market quantity step"),
    market_minimum_quantity: decimal(marketLot.minQty, "market minimum quantity"),
    market_maximum_quantity: decimal(marketLot.maxQty, "market maximum quantity"),
    minimum_notional: positiveDecimal(
      notional.notional ?? notional.minNotional,
      "minimum notional",
    ),
    supported_order_types: stringArray(symbol.orderTypes, "order types"),
    supported_time_in_force: stringArray(symbol.timeInForce, "time in force"),
  };
}

export function decimalStringToUnits(value: string, scale = 1_000_000): number {
  if (!Number.isSafeInteger(scale) || scale <= 0) {
    throw new Error("unit scale must be a positive safe integer");
  }
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) {
    throw new Error(`invalid non-negative decimal: ${value}`);
  }
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  const scaleDigits = Math.log10(scale);
  if (!Number.isInteger(scaleDigits)) {
    throw new Error("unit scale must be a power of ten");
  }
  if (fraction.length > scaleDigits && /[1-9]/.test(fraction.slice(scaleDigits))) {
    throw new Error(`decimal ${value} is not exactly representable at scale ${scale}`);
  }
  const padded = fraction.slice(0, scaleDigits).padEnd(scaleDigits, "0");
  const units = BigInt(whole) * BigInt(scale) + BigInt(padded || "0");
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`decimal ${value} exceeds safe integer units`);
  }
  return Number(units);
}

function filter(filters: Record<string, unknown>[], type: string): Record<string, unknown> {
  const result = optionalFilter(filters, type);
  if (!result) {
    throw new Error(`Binance symbol contract is missing ${type}`);
  }
  return result;
}

function optionalFilter(
  filters: Record<string, unknown>[],
  type: string,
): Record<string, unknown> | undefined {
  return filters.find((item) => item.filterType === type);
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array`);
  }
  return value;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function stringArray(value: unknown, name: string): string[] {
  return arrayValue(value, name).map((item) => stringValue(item, name));
}

function integerValue(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value as number;
}

function decimal(value: unknown, name: string): string {
  const text = stringValue(value, name);
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) {
    throw new Error(`${name} must be a non-negative decimal string`);
  }
  return text;
}

function positiveDecimal(value: unknown, name: string): string {
  const text = decimal(value, name);
  if (Number(text) <= 0) {
    throw new Error(`${name} must be positive`);
  }
  return text;
}
