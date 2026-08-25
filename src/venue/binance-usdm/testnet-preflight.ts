import type {
  BinanceUsdmAccountSnapshot,
  BinanceUsdmShadowEvidence,
} from "./shadow-client.js";
import { BinanceUsdmShadowClient } from "./shadow-client.js";

const TESTNET_ORIGIN = "https://demo-fapi.binance.com";
const REQUIRED_ORDER_TYPES = ["MARKET", "STOP_MARKET", "TAKE_PROFIT_MARKET"] as const;

export interface BinanceUsdmTestnetPreflightReport {
  schema_version: "glitch.crypto.binance-usdm-testnet-preflight.v1";
  venue: "binance-usdm";
  environment: "testnet";
  mutation_authority: false;
  status: "ready" | "blocked";
  symbol: string;
  maximum_leverage: number;
  observed_utc: string;
  account: {
    one_way_mode: boolean | null;
    multi_asset_mode: boolean | null;
    margin_type: string | null;
    leverage: number | null;
    auto_add_margin: boolean | null;
    can_trade: boolean | null;
    wallet_balance: string | null;
    available_balance: string | null;
    maker_commission_rate: string | null;
    taker_commission_rate: string | null;
    open_position_count: number | null;
    open_order_count: number | null;
  };
  contract: {
    tick_size: string;
    market_quantity_step: string;
    market_minimum_quantity: string;
    minimum_notional: string;
    required_order_types_present: boolean;
  };
  blockers: string[];
}

export class BinanceUsdmTestnetPreflight {
  constructor(
    private readonly client: BinanceUsdmShadowClient,
    private readonly maximumLeverage = 3,
  ) {
    requireTestnetOrigin(client.baseUrl);
    if (!client.credentialsConfigured()) {
      throw new Error("Binance authenticated Testnet preflight credentials are required");
    }
    if (!Number.isSafeInteger(maximumLeverage) || maximumLeverage < 1 || maximumLeverage > 125) {
      throw new Error("Binance Testnet maximum leverage must be an integer between 1 and 125");
    }
  }

  async run(): Promise<BinanceUsdmTestnetPreflightReport> {
    return evaluateBinanceUsdmTestnetPreflight(
      await this.client.capture(true),
      this.maximumLeverage,
    );
  }
}

export function evaluateBinanceUsdmTestnetPreflight(
  evidence: BinanceUsdmShadowEvidence,
  maximumLeverage = 3,
): BinanceUsdmTestnetPreflightReport {
  if (!Number.isSafeInteger(maximumLeverage) || maximumLeverage < 1 || maximumLeverage > 125) {
    throw new Error("Binance Testnet maximum leverage must be an integer between 1 and 125");
  }
  requireTestnetOrigin(evidence.base_url_origin);
  const blockers: string[] = [];
  const privateState = evidence.private;
  const account = inspectAccount(privateState, evidence.symbol, maximumLeverage, blockers);
  const supported = new Set(evidence.public.symbol_rules.supported_order_types);
  const requiredOrderTypesPresent = REQUIRED_ORDER_TYPES.every((type) => supported.has(type));
  if (!requiredOrderTypesPresent) {
    blockers.push("required_native_order_types_absent");
  }
  if (evidence.credential_mode !== "read_only_authenticated" || privateState === null) {
    blockers.push("authenticated_testnet_evidence_required");
  }
  return {
    schema_version: "glitch.crypto.binance-usdm-testnet-preflight.v1",
    venue: "binance-usdm",
    environment: "testnet",
    mutation_authority: false,
    status: blockers.length === 0 ? "ready" : "blocked",
    symbol: evidence.symbol,
    maximum_leverage: maximumLeverage,
    observed_utc: evidence.observed_utc,
    account,
    contract: {
      tick_size: evidence.public.symbol_rules.tick_size,
      market_quantity_step: evidence.public.symbol_rules.market_quantity_step,
      market_minimum_quantity: evidence.public.symbol_rules.market_minimum_quantity,
      minimum_notional: evidence.public.symbol_rules.minimum_notional,
      required_order_types_present: requiredOrderTypesPresent,
    },
    blockers: [...new Set(blockers)].sort(),
  };
}

function inspectAccount(
  snapshot: BinanceUsdmAccountSnapshot | null,
  symbol: string,
  maximumLeverage: number,
  blockers: string[],
): BinanceUsdmTestnetPreflightReport["account"] {
  if (snapshot === null) {
    return emptyAccount();
  }
  const positionMode = record(snapshot.position_mode);
  const multiAssetMode = record(snapshot.multi_asset_mode);
  const accountConfig = record(snapshot.account_configuration);
  const symbolConfig = array(snapshot.symbol_configuration)
    .map(record)
    .find((item) => item?.symbol === symbol) ?? null;
  const commission = record(snapshot.commission_rate);
  const balance = array(snapshot.balances)
    .map(record)
    .find((item) => item?.asset === "USDT") ?? null;
  const positionItems = array(snapshot.positions);
  const openOrderItems = array(snapshot.open_orders);
  const positions = positionItems.map(record).filter(notNull);
  const openOrders = openOrderItems.map(record).filter(notNull);

  const dualSidePosition = boolean(positionMode?.dualSidePosition);
  const oneWayMode = dualSidePosition === null
    ? null
    : !dualSidePosition;
  const multiAsset = boolean(multiAssetMode?.multiAssetsMargin);
  const marginType = text(symbolConfig?.marginType);
  const leverage = integer(symbolConfig?.leverage);
  const autoAddMargin = boolean(symbolConfig?.isAutoAddMargin);
  const canTrade = boolean(accountConfig?.canTrade);
  const walletBalance = decimal(balance?.balance ?? balance?.walletBalance);
  const availableBalance = decimal(balance?.availableBalance ?? balance?.crossWalletBalance ?? balance?.balance);
  const makerRate = decimal(commission?.makerCommissionRate);
  const takerRate = decimal(commission?.takerCommissionRate);
  const openPositionCount = positions.filter((position) => {
    const quantity = signedDecimal(position.positionAmt);
    return position.symbol === symbol && quantity !== null && !isZero(quantity);
  }).length;

  requireTrue(oneWayMode, "one_way_position_mode_not_proven", blockers);
  requireFalse(multiAsset, "single_asset_margin_mode_not_proven", blockers);
  if (marginType !== "ISOLATED") {
    blockers.push("isolated_margin_not_proven");
  }
  if (leverage === null || leverage < 1 || leverage > maximumLeverage) {
    blockers.push("leverage_exceeds_or_lacks_configured_ceiling");
  }
  requireFalse(autoAddMargin, "auto_add_margin_disabled_not_proven", blockers);
  requireTrue(canTrade, "account_trading_permission_not_proven", blockers);
  if (walletBalance === null || isZero(walletBalance)) {
    blockers.push("positive_usdt_wallet_balance_not_proven");
  }
  if (availableBalance === null || isZero(availableBalance)) {
    blockers.push("positive_available_usdt_balance_not_proven");
  }
  if (makerRate === null || takerRate === null) {
    blockers.push("commission_rates_not_proven");
  }
  if (positions.some((position) => position.symbol === symbol && signedDecimal(position.positionAmt) === null)) {
    blockers.push("position_quantity_contract_invalid");
  }
  if (!Array.isArray(snapshot.positions) || positions.length !== positionItems.length) {
    blockers.push("position_snapshot_contract_invalid");
  }
  if (openPositionCount > 0) {
    blockers.push("preexisting_symbol_exposure_present");
  }
  if (openOrders.length > 0) {
    blockers.push("preexisting_open_orders_present");
  }
  if (!Array.isArray(snapshot.open_orders) || openOrders.length !== openOrderItems.length) {
    blockers.push("open_order_snapshot_contract_invalid");
  }

  return {
    one_way_mode: oneWayMode,
    multi_asset_mode: multiAsset,
    margin_type: marginType,
    leverage,
    auto_add_margin: autoAddMargin,
    can_trade: canTrade,
    wallet_balance: walletBalance,
    available_balance: availableBalance,
    maker_commission_rate: makerRate,
    taker_commission_rate: takerRate,
    open_position_count: openPositionCount,
    open_order_count: openOrders.length,
  };
}

function emptyAccount(): BinanceUsdmTestnetPreflightReport["account"] {
  return {
    one_way_mode: null,
    multi_asset_mode: null,
    margin_type: null,
    leverage: null,
    auto_add_margin: null,
    can_trade: null,
    wallet_balance: null,
    available_balance: null,
    maker_commission_rate: null,
    taker_commission_rate: null,
    open_position_count: null,
    open_order_count: null,
  };
}

function requireTestnetOrigin(value: string): void {
  const parsed = new URL(value);
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "::1" || parsed.hostname === "[::1]";
  if (parsed.origin !== TESTNET_ORIGIN && !loopback) {
    throw new Error("Binance authenticated preflight requires Futures Testnet or numeric loopback");
  }
}

function requireTrue(value: boolean | null, blocker: string, blockers: string[]): void {
  if (value !== true) {
    blockers.push(blocker);
  }
}

function requireFalse(value: boolean | null, blocker: string, blockers: string[]): void {
  if (value !== false) {
    blockers.push(blocker);
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function notNull(value: Record<string, unknown> | null): value is Record<string, unknown> {
  return value !== null;
}

function boolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function integer(value: unknown): number | null {
  return Number.isSafeInteger(value) ? value as number : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function decimal(value: unknown): string | null {
  return typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) ? value : null;
}

function signedDecimal(value: unknown): string | null {
  return typeof value === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) ? value : null;
}

function isZero(value: string): boolean {
  return Number(value) === 0;
}
