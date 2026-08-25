import type { BinanceMarketStreamRecorderStatus } from "./market-stream-recorder.js";
import type { BinanceUsdmStreamSupervisorStatus } from "./stream-supervisor.js";
import type { BinanceUsdmTestnetPreflightReport } from "./testnet-preflight.js";

const TERMINAL_ORDER_STATUSES = new Set([
  "FILLED",
  "CANCELED",
  "EXPIRED",
  "EXPIRED_IN_MATCH",
  "REJECTED",
]);

export interface BinanceUsdmExecutionFreshnessPolicy {
  preflight_max_age_ms: number;
  depth_max_age_ms: number;
  market_max_age_ms: number;
  private_reconciliation_max_age_ms: number;
  future_tolerance_ms: number;
}

export interface CompileBinanceUsdmExecutionContextInput {
  preflight: BinanceUsdmTestnetPreflightReport;
  streams: BinanceUsdmStreamSupervisorStatus;
  market: BinanceMarketStreamRecorderStatus;
  observedAtMs: number;
  freshness?: Partial<BinanceUsdmExecutionFreshnessPolicy>;
}

export interface BinanceUsdmExecutionContext {
  readonly schema_version: "glitch.crypto.binance-usdm-execution-context.v3";
  readonly venue: "binance-usdm";
  readonly environment: "testnet";
  readonly symbol: string;
  readonly status: "ready" | "blocked";
  readonly mutation_authority: false;
  readonly engine_binding_authority: false;
  readonly preconditions_satisfied_for_bounded_testnet_entry_exercise: boolean;
  readonly observed_utc: string;
  readonly preflight_observed_utc: string;
  readonly freshness: Readonly<BinanceUsdmExecutionFreshnessPolicy>;
  readonly account: Readonly<{
    wallet_balance: string | null;
    available_balance: string | null;
    maker_commission_rate: string | null;
    taker_commission_rate: string | null;
    leverage: number | null;
    maximum_leverage: number;
    last_reconciliation_time: number | null;
    active_position_count: number;
    active_order_count: number;
  }>;
  readonly market: Readonly<{
    mark_price: string | null;
    mark_event_time: number | null;
    last_trade_price: string | null;
    last_trade_event_time: number | null;
    best_bid: string | null;
    best_ask: string | null;
    depth_event_time: number | null;
    depth_update_id: number | null;
  }>;
  readonly contract: Readonly<{
    tick_size: string;
    market_quantity_step: string;
    market_minimum_quantity: string;
    minimum_notional: string;
  }>;
  readonly capabilities: Readonly<{
    protected_entry: true;
    owned_position_full_close: true;
    protection_revision: true;
    restart_reconciliation: true;
    partial_reduction: true;
    stop_replacement: true;
    target_replacement: true;
    native_algo_amendment: false;
  }>;
  readonly blockers: readonly string[];
}

const DEFAULT_FRESHNESS: BinanceUsdmExecutionFreshnessPolicy = {
  preflight_max_age_ms: 5 * 60_000,
  depth_max_age_ms: 5_000,
  market_max_age_ms: 5_000,
  private_reconciliation_max_age_ms: 60_000,
  future_tolerance_ms: 5_000,
};

export function compileBinanceUsdmExecutionContext(
  input: CompileBinanceUsdmExecutionContextInput,
): BinanceUsdmExecutionContext {
  const observedAtMs = boundedInteger(
    input.observedAtMs,
    1,
    Number.MAX_SAFE_INTEGER,
    "execution-context observation time",
  );
  const freshness = compileFreshness(input.freshness);
  const blockers: string[] = [];
  const { preflight, streams, market } = input;
  const symbol = preflight.symbol;

  if (symbol !== "BTCUSDT") {
    blockers.push("unsupported_execution_symbol");
  }
  if (
    preflight.schema_version !==
      "glitch.crypto.binance-usdm-testnet-preflight.v1" ||
    preflight.venue !== "binance-usdm" ||
    preflight.environment !== "testnet" ||
    preflight.mutation_authority !== false
  ) {
    blockers.push("authenticated_testnet_preflight_contract_invalid");
  }
  if (preflight.status !== "ready" || preflight.blockers.length > 0) {
    blockers.push("authenticated_testnet_preflight_not_ready");
  }
  const preflightTime = Date.parse(preflight.observed_utc);
  checkFreshness(
    preflightTime,
    observedAtMs,
    freshness.preflight_max_age_ms,
    freshness.future_tolerance_ms,
    "preflight",
    blockers,
  );

  if (streams.symbol !== symbol || market.symbol !== symbol) {
    blockers.push("runtime_symbol_mismatch");
  }
  if (
    streams.schema_version !== "glitch.crypto.binance-usdm-stream-status.v1" ||
    market.schema_version !==
      "glitch.crypto.binance-usdm-market-recorder-status.v2" ||
    streams.private.account.schema_version !==
      "glitch.crypto.binance-usdm-private-state.v2"
  ) {
    blockers.push("runtime_state_contract_invalid");
  }
  if (streams.mutation_authority !== false || market.mutation_authority !== false) {
    blockers.push("runtime_read_only_authority_not_proven");
  }
  if (!streams.desired_running) {
    blockers.push("stream_supervisor_not_running");
  }
  if (streams.public.state !== "running") {
    blockers.push("public_depth_lane_not_running");
  }
  const book = streams.public.order_book;
  if (book.status !== "ready") {
    blockers.push("public_order_book_not_ready");
  }
  if (book.symbol !== symbol) {
    blockers.push("public_order_book_symbol_mismatch");
  }
  checkFreshness(
    book.event_time,
    observedAtMs,
    freshness.depth_max_age_ms,
    freshness.future_tolerance_ms,
    "depth",
    blockers,
  );
  const bestBid = validPositiveDecimal(book.best_bid?.[0]);
  const bestAsk = validPositiveDecimal(book.best_ask?.[0]);
  if (bestBid === null || bestAsk === null) {
    blockers.push("public_top_of_book_missing");
  } else if (compareDecimals(bestBid, bestAsk) >= 0) {
    blockers.push("public_order_book_crossed");
  }

  if (!market.desired_running || market.state !== "running") {
    blockers.push("public_market_lane_not_running");
  }
  const mark = market.last_mark_price;
  const trade = market.last_aggregate_trade;
  if (mark?.symbol !== symbol || trade?.symbol !== symbol) {
    blockers.push("public_market_symbol_mismatch");
  }
  checkFreshness(
    mark?.event_time ?? null,
    observedAtMs,
    freshness.market_max_age_ms,
    freshness.future_tolerance_ms,
    "mark_price",
    blockers,
  );
  checkFreshness(
    trade?.event_time ?? null,
    observedAtMs,
    freshness.market_max_age_ms,
    freshness.future_tolerance_ms,
    "aggregate_trade",
    blockers,
  );
  const markPrice = validPositiveDecimal(mark?.mark_price);
  const tradePrice = validPositiveDecimal(trade?.price);
  if (markPrice === null) {
    blockers.push("mark_price_invalid");
  }
  if (tradePrice === null) {
    blockers.push("aggregate_trade_price_invalid");
  }
  if (
    mark?.event_time !== market.last_mark_price_event_time ||
    trade?.event_time !== market.last_aggregate_trade_event_time ||
    trade?.aggregate_trade_id !== market.last_aggregate_trade_id
  ) {
    blockers.push("public_market_summary_identity_mismatch");
  }

  const privateLane = streams.private;
  const privateAccount = privateLane.account;
  if (!privateLane.enabled) {
    blockers.push("private_stream_not_enabled");
  }
  if (privateLane.state !== "running") {
    blockers.push("private_stream_not_running");
  }
  if (privateLane.buffered_events !== 0) {
    blockers.push("private_stream_has_buffered_events");
  }
  if (privateAccount.stream_expired) {
    blockers.push("private_stream_expired");
  }
  checkFreshness(
    privateAccount.last_reconciliation_time,
    observedAtMs,
    freshness.private_reconciliation_max_age_ms,
    freshness.future_tolerance_ms,
    "private_reconciliation",
    blockers,
  );
  checkFutureOnly(
    privateAccount.last_event_time,
    observedAtMs,
    freshness.future_tolerance_ms,
    "private_event",
    blockers,
  );
  checkFutureOnly(
    privateAccount.last_transaction_time,
    observedAtMs,
    freshness.future_tolerance_ms,
    "private_transaction",
    blockers,
  );

  let activePositionCount = 0;
  for (const position of privateAccount.positions) {
    if (!validSignedDecimal(position.quantity)) {
      blockers.push("private_position_quantity_invalid");
      continue;
    }
    if (position.position_side !== "BOTH") {
      blockers.push("private_position_mode_mismatch");
    }
    if (!isZeroDecimal(position.quantity)) {
      activePositionCount += 1;
    }
  }
  if (activePositionCount > 0) {
    blockers.push("preexisting_native_exposure_present");
  }
  const activeOrderCount = privateAccount.orders.filter(
    (order) => !TERMINAL_ORDER_STATUSES.has(order.status),
  ).length;
  if (activeOrderCount > 0) {
    blockers.push("preexisting_active_native_orders_present");
  }

  const usdt = privateAccount.balances.find((balance) => balance.asset === "USDT");
  const walletBalance = validPositiveDecimal(usdt?.wallet_balance);
  const availableBalance = validPositiveDecimal(usdt?.available_balance);
  if (walletBalance === null) {
    blockers.push("positive_reconciled_usdt_wallet_balance_not_proven");
  }
  if (availableBalance === null) {
    blockers.push("positive_reconciled_usdt_available_balance_not_proven");
  }

  const makerRate = validNonNegativeDecimal(
    preflight.account.maker_commission_rate,
  );
  const takerRate = validNonNegativeDecimal(
    preflight.account.taker_commission_rate,
  );
  if (makerRate === null || takerRate === null) {
    blockers.push("preflight_commission_rates_invalid");
  }
  if (
    preflight.account.leverage === null ||
    preflight.account.leverage < 1 ||
    preflight.account.leverage > preflight.maximum_leverage
  ) {
    blockers.push("preflight_leverage_envelope_invalid");
  }
  if (
    preflight.account.one_way_mode !== true ||
    preflight.account.multi_asset_mode !== false ||
    preflight.account.margin_type !== "ISOLATED" ||
    preflight.account.auto_add_margin !== false ||
    preflight.account.can_trade !== true ||
    preflight.account.open_position_count !== 0 ||
    preflight.account.open_order_count !== 0
  ) {
    blockers.push("preflight_account_envelope_invalid");
  }
  if (
    preflight.contract.required_order_types_present !== true ||
    validPositiveDecimal(preflight.contract.tick_size) === null ||
    validPositiveDecimal(preflight.contract.market_quantity_step) === null ||
    validPositiveDecimal(preflight.contract.market_minimum_quantity) === null ||
    validPositiveDecimal(preflight.contract.minimum_notional) === null
  ) {
    blockers.push("preflight_instrument_contract_invalid");
  }

  const uniqueBlockers = [...new Set(blockers)].sort();
  const status = uniqueBlockers.length === 0 ? "ready" : "blocked";
  return deepFreeze({
    schema_version: "glitch.crypto.binance-usdm-execution-context.v3",
    venue: "binance-usdm",
    environment: "testnet",
    symbol,
    status,
    mutation_authority: false,
    engine_binding_authority: false,
    preconditions_satisfied_for_bounded_testnet_entry_exercise:
      status === "ready",
    observed_utc: new Date(observedAtMs).toISOString(),
    preflight_observed_utc: preflight.observed_utc,
    freshness: { ...freshness },
    account: {
      wallet_balance: walletBalance,
      available_balance: availableBalance,
      maker_commission_rate: makerRate,
      taker_commission_rate: takerRate,
      leverage: preflight.account.leverage,
      maximum_leverage: preflight.maximum_leverage,
      last_reconciliation_time: privateAccount.last_reconciliation_time,
      active_position_count: activePositionCount,
      active_order_count: activeOrderCount,
    },
    market: {
      mark_price: markPrice,
      mark_event_time: mark?.event_time ?? null,
      last_trade_price: tradePrice,
      last_trade_event_time: trade?.event_time ?? null,
      best_bid: bestBid,
      best_ask: bestAsk,
      depth_event_time: book.event_time,
      depth_update_id: book.update_id,
    },
    contract: {
      tick_size: preflight.contract.tick_size,
      market_quantity_step: preflight.contract.market_quantity_step,
      market_minimum_quantity: preflight.contract.market_minimum_quantity,
      minimum_notional: preflight.contract.minimum_notional,
    },
    capabilities: {
      protected_entry: true,
      owned_position_full_close: true,
      protection_revision: true,
      restart_reconciliation: true,
      partial_reduction: true,
      stop_replacement: true,
      target_replacement: true,
      native_algo_amendment: false,
    },
    blockers: uniqueBlockers,
  });
}

function compileFreshness(
  patch: Partial<BinanceUsdmExecutionFreshnessPolicy> | undefined,
): BinanceUsdmExecutionFreshnessPolicy {
  const result = { ...DEFAULT_FRESHNESS, ...patch };
  result.preflight_max_age_ms = boundedInteger(
    result.preflight_max_age_ms,
    1,
    24 * 60 * 60_000,
    "preflight maximum age",
  );
  result.depth_max_age_ms = boundedInteger(
    result.depth_max_age_ms,
    1,
    60_000,
    "depth maximum age",
  );
  result.market_max_age_ms = boundedInteger(
    result.market_max_age_ms,
    1,
    60_000,
    "market maximum age",
  );
  result.private_reconciliation_max_age_ms = boundedInteger(
    result.private_reconciliation_max_age_ms,
    1,
    60 * 60_000,
    "private reconciliation maximum age",
  );
  result.future_tolerance_ms = boundedInteger(
    result.future_tolerance_ms,
    0,
    60_000,
    "future timestamp tolerance",
  );
  return result;
}

function checkFreshness(
  timestamp: number | null,
  now: number,
  maximumAge: number,
  futureTolerance: number,
  prefix: string,
  blockers: string[],
): void {
  if (!Number.isSafeInteger(timestamp) || (timestamp as number) <= 0) {
    blockers.push(`${prefix}_time_missing_or_invalid`);
    return;
  }
  if ((timestamp as number) > now + futureTolerance) {
    blockers.push(`${prefix}_time_in_future`);
  } else if (now - (timestamp as number) > maximumAge) {
    blockers.push(`${prefix}_stale`);
  }
}

function checkFutureOnly(
  timestamp: number | null,
  now: number,
  futureTolerance: number,
  prefix: string,
  blockers: string[],
): void {
  if (timestamp !== null && (
    !Number.isSafeInteger(timestamp) ||
    timestamp <= 0 ||
    timestamp > now + futureTolerance
  )) {
    blockers.push(`${prefix}_time_invalid`);
  }
}

function validPositiveDecimal(value: unknown): string | null {
  const result = validNonNegativeDecimal(value);
  return result !== null && !isZeroDecimal(result) ? result : null;
}

function validNonNegativeDecimal(value: unknown): string | null {
  return typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)
    ? value
    : null;
}

function validSignedDecimal(value: unknown): value is string {
  return typeof value === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value);
}

function isZeroDecimal(value: string): boolean {
  return /^-?0(?:\.0+)?$/.test(value);
}

function compareDecimals(left: string, right: string): number {
  const [leftWhole = "0", leftFraction = ""] = left.split(".");
  const [rightWhole = "0", rightFraction = ""] = right.split(".");
  const fractionLength = Math.max(leftFraction.length, rightFraction.length);
  const scale = 10n ** BigInt(fractionLength);
  const leftValue = BigInt(leftWhole) * scale + BigInt(leftFraction.padEnd(fractionLength, "0") || "0");
  const rightValue = BigInt(rightWhole) * scale + BigInt(rightFraction.padEnd(fractionLength, "0") || "0");
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
