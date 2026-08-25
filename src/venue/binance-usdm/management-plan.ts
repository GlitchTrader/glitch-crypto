import { validatePolicy } from "../../domain/policy.js";
import type { DailyStateRecord, RiskPolicy } from "../../domain/types.js";
import {
  canonicalPositiveDecimal,
  decimalEquals,
  validateBinanceUsdmProtectionRevision,
  type BinanceUsdmOwnedProtection,
  type BinanceUsdmProtectionRevisionRequest,
} from "./mutation-contract.js";
import type { BinanceUsdmOwnedProtectionBinding } from "./owned-protection-state.js";
import type { BinanceUsdmShadowEvidence } from "./shadow-client.js";

const SCALE_DIGITS = 8;
const SCALE = 100_000_000n;
const TESTNET_ORIGIN = "https://demo-fapi.binance.com";
const REQUIRED_ORDER_TYPES = new Set(["MARKET", "STOP_MARKET", "TAKE_PROFIT_MARKET"]);

export interface CompileBinanceUsdmProtectionManagementPlanInput {
  revisionIntentId: string;
  binding: BinanceUsdmOwnedProtectionBinding;
  evidence: BinanceUsdmShadowEvidence;
  policy: RiskPolicy;
  daily: DailyStateRecord;
  nextStopPrice: string;
  nextTargetPrice: string;
  requestedReductionBps?: number | null;
  observedAtMs: number;
  bindingMaxAgeMs?: number;
  evidenceMaxAgeMs?: number;
  dailyMaxAgeMs?: number;
}

export interface BinanceUsdmProtectionManagementPlan {
  readonly schema_version: "glitch.crypto.binance-usdm-protection-management-plan.v1";
  readonly venue: "binance-usdm";
  readonly environment: "testnet";
  readonly status: "ready" | "blocked";
  readonly mutation_authority: false;
  readonly engine_binding_authority: false;
  readonly observed_utc: string;
  readonly binding_observed_utc: string;
  readonly evidence_observed_utc: string;
  readonly binding_state_body_hash: string;
  readonly binding_transition_sequence: number;
  readonly request: Readonly<BinanceUsdmProtectionRevisionRequest> | null;
  readonly account: Readonly<{
    wallet_balance_cents: number | null;
    unrealized_pnl_cents: number | null;
    equity_cents: number | null;
    projected_equity_cents: number | null;
    leverage: number | null;
  }>;
  readonly market: Readonly<{
    mark_price: string | null;
    best_bid: string | null;
    best_ask: string | null;
    reduction_executable_price: string | null;
  }>;
  readonly risk: Readonly<{
    usable_pot_cents: number | null;
    daily_start_pot_cents: number | null;
    daily_target_profit_cents: number | null;
    daily_loss_boundary_cents: number | null;
    active_floor_cents: number | null;
    current_protected_equity_cents: number | null;
    projected_protected_equity_cents: number | null;
    current_open_risk_cents: number | null;
    projected_open_risk_cents: number | null;
    maximum_open_risk_cents: number | null;
    reduction_realized_pnl_cents: number | null;
    reduction_cost_cents: number | null;
    venue_round_trip_cost_bps: number | null;
    applied_exit_cost_bps: number | null;
  }>;
  readonly precision: Readonly<{
    tick_size: string | null;
    venue_quantity_step: string | null;
    effective_quantity_step: string | null;
    venue_minimum_quantity: string | null;
    venue_minimum_notional_cents: number | null;
    effective_minimum_notional_cents: number | null;
    requested_reduction_bps: number | null;
    derived_reduction_quantity: string | null;
    remaining_quantity: string | null;
  }>;
  readonly blockers: readonly string[];
}

export function compileBinanceUsdmProtectionManagementPlan(
  input: CompileBinanceUsdmProtectionManagementPlanInput,
): BinanceUsdmProtectionManagementPlan {
  validatePolicy(input.policy);
  const observedAtMs = integer(input.observedAtMs, 1, Number.MAX_SAFE_INTEGER, "management-plan observation time");
  const bindingMaxAgeMs = integer(input.bindingMaxAgeMs ?? 1_000, 1, 60_000, "binding maximum age");
  const evidenceMaxAgeMs = integer(input.evidenceMaxAgeMs ?? 5_000, 1, 60_000, "evidence maximum age");
  const dailyMaxAgeMs = integer(input.dailyMaxAgeMs ?? 1_000, 1, 60_000, "daily state maximum age");
  const blockers: string[] = [];
  const binding = input.binding;
  const evidence = input.evidence;

  if (
    binding.schema_version !== "glitch.crypto.binance-usdm-owned-protection-binding.v1" ||
    binding.venue !== "binance-usdm" ||
    binding.environment !== "testnet" ||
    binding.status !== "ready" ||
    binding.current === null ||
    binding.native_position === null ||
    binding.pending !== null ||
    binding.management_preconditions_satisfied !== true ||
    binding.mutation_authority !== false ||
    binding.engine_binding_authority !== false ||
    binding.blockers.length > 0
  ) {
    blockers.push("owned_protection_binding_not_ready");
  }
  if (
    !/^[0-9a-f]{64}$/.test(binding.state_body_hash) ||
    !Number.isSafeInteger(binding.transition_sequence) ||
    binding.transition_sequence < 0
  ) blockers.push("owned_protection_binding_identity_invalid");
  checkFreshness(binding.observed_utc, observedAtMs, bindingMaxAgeMs, "owned_protection_binding", blockers);

  if (
    evidence.schema_version !== "glitch.crypto.binance-usdm-shadow-evidence.v1" ||
    evidence.venue !== "binance-usdm" ||
    evidence.base_url_origin !== TESTNET_ORIGIN ||
    evidence.mutation_authority !== false ||
    evidence.credential_mode !== "read_only_authenticated" ||
    evidence.private === null
  ) {
    blockers.push("authenticated_testnet_management_evidence_invalid");
  }
  checkFreshness(evidence.observed_utc, observedAtMs, evidenceMaxAgeMs, "management_evidence", blockers);

  const current = binding.current;
  if (evidence.symbol !== "BTCUSDT" || (current !== null && evidence.symbol !== current.symbol)) {
    blockers.push("management_symbol_mismatch");
  }

  const rules = evidence.public.symbol_rules;
  if (
    rules.schema_version !== "glitch.crypto.binance-usdm-symbol-rules.v1" ||
    rules.venue !== "binance-usdm" ||
    rules.symbol !== evidence.symbol ||
    rules.status !== "TRADING" ||
    rules.contract_type !== "PERPETUAL" ||
    rules.quote_asset !== "USDT" ||
    rules.margin_asset !== "USDT" ||
    ![...REQUIRED_ORDER_TYPES].every((type) => rules.supported_order_types.includes(type))
  ) {
    blockers.push("management_instrument_contract_invalid");
  }

  const tickUnits = positiveScaled(rules.tick_size);
  const venueStepUnits = positiveScaled(rules.market_quantity_step);
  const venueMinimumQuantityUnits = positiveScaled(rules.market_minimum_quantity);
  const venueMinimumNotionalCents = decimalToCents(rules.minimum_notional, "ceil");
  const effectiveMinimumNotionalCents = venueMinimumNotionalCents === null
    ? null
    : Math.max(venueMinimumNotionalCents, input.policy.minimumNotionalCents);
  if (tickUnits === null) blockers.push("management_tick_size_invalid");
  if (venueStepUnits === null) blockers.push("management_quantity_step_invalid");
  if (venueMinimumQuantityUnits === null) blockers.push("management_minimum_quantity_invalid");
  if (venueMinimumNotionalCents === null || venueMinimumNotionalCents <= 0) {
    blockers.push("management_minimum_notional_invalid");
  }

  const book = record(evidence.public.book_ticker);
  const premium = record(evidence.public.premium_index);
  const bestBid = positiveText(book?.bidPrice);
  const bestAsk = positiveText(book?.askPrice);
  const markPrice = positiveText(premium?.markPrice);
  if (book?.symbol !== evidence.symbol || premium?.symbol !== evidence.symbol) {
    blockers.push("management_market_symbol_mismatch");
  }
  const bestBidUnits = bestBid === null ? null : positiveScaled(bestBid);
  const bestAskUnits = bestAsk === null ? null : positiveScaled(bestAsk);
  const markUnits = markPrice === null ? null : positiveScaled(markPrice);
  if (bestBidUnits === null || bestAskUnits === null || markUnits === null) {
    blockers.push("management_market_price_invalid");
  } else if (bestBidUnits >= bestAskUnits) {
    blockers.push("management_market_crossed");
  }

  const privateEvidence = evidence.private;
  const balances = strictRecords(privateEvidence?.balances, "management_balance_snapshot", blockers);
  const positions = strictRecords(privateEvidence?.positions, "management_position_snapshot", blockers);
  const openOrders = strictRecords(privateEvidence?.open_orders, "management_open_order_snapshot", blockers);
  if (openOrders.length > 0) blockers.push("unowned_active_ordinary_orders_present");

  const balance = balances.filter((item) => item.asset === "USDT");
  if (balance.length !== 1) blockers.push("single_usdt_balance_not_proven");
  const walletText = nonNegativeText(balance[0]?.balance ?? balance[0]?.walletBalance);
  const availableText = nonNegativeText(balance[0]?.availableBalance);
  const walletCents = walletText === null ? null : decimalToCents(walletText, "floor");
  if (walletCents === null || walletCents <= 0) blockers.push("positive_wallet_balance_not_proven");
  if (availableText === null) blockers.push("available_balance_not_proven");

  const activePositions = positions.filter((item) => {
    const quantity = signedText(item.positionAmt);
    return quantity !== null && !zeroDecimal(quantity);
  });
  if (positions.some((item) => signedText(item.positionAmt) === null)) {
    blockers.push("management_position_quantity_invalid");
  }
  if (activePositions.length !== 1) blockers.push("single_owned_native_position_not_proven");
  const position = activePositions[0] ?? null;
  const signedQuantity = signedText(position?.positionAmt);
  const absoluteQuantity = signedQuantity === null ? null : unsignedAbsolute(signedQuantity);
  const positionDirection = signedQuantity?.startsWith("-") ? "SHORT" : "LONG";
  const entryPrice = positiveText(position?.entryPrice);
  const unrealizedText = signedText(position?.unRealizedProfit ?? position?.unrealizedProfit);
  const unrealizedPnlCents = unrealizedText === null ? null : signedDecimalToCentsFloor(unrealizedText);
  if (position?.symbol !== evidence.symbol) blockers.push("owned_snapshot_position_symbol_mismatch");
  if (position?.positionSide !== "BOTH") blockers.push("owned_snapshot_position_mode_mismatch");
  if (current !== null && positionDirection !== current.direction) blockers.push("owned_snapshot_position_direction_mismatch");
  if (current !== null && (absoluteQuantity === null || !decimalEquals(absoluteQuantity, current.quantity))) {
    blockers.push("owned_snapshot_position_quantity_mismatch");
  }
  if (binding.native_position !== null && (
    entryPrice === null || !decimalEquals(entryPrice, binding.native_position.entry_price)
  )) {
    blockers.push("owned_snapshot_entry_price_mismatch");
  }
  if (unrealizedPnlCents === null) blockers.push("owned_snapshot_unrealized_pnl_invalid");

  const positionMode = record(privateEvidence?.position_mode);
  const multiAssetMode = record(privateEvidence?.multi_asset_mode);
  const accountConfiguration = record(privateEvidence?.account_configuration);
  const symbolConfigurations = strictRecords(
    privateEvidence?.symbol_configuration,
    "management_symbol_configuration",
    blockers,
  );
  const symbolConfiguration = symbolConfigurations.find((item) => item.symbol === evidence.symbol) ?? null;
  const leverage = safeInteger(symbolConfiguration?.leverage);
  if (positionMode?.dualSidePosition !== false) blockers.push("one_way_position_mode_not_proven");
  if (multiAssetMode?.multiAssetsMargin !== false) blockers.push("single_asset_margin_mode_not_proven");
  if (symbolConfiguration?.marginType !== "ISOLATED") blockers.push("isolated_margin_not_proven");
  if (symbolConfiguration?.isAutoAddMargin !== false) blockers.push("auto_add_margin_disabled_not_proven");
  if (accountConfiguration?.canTrade !== true) blockers.push("account_trading_permission_not_proven");
  if (leverage === null || leverage < 1 || leverage > input.policy.maxLeverage) {
    blockers.push("configured_leverage_outside_policy");
  }

  const commission = record(privateEvidence?.commission_rate);
  const takerRate = commission?.symbol === evidence.symbol
    ? nonNegativeText(commission.takerCommissionRate)
    : null;
  const takerRateUnits = takerRate === null ? null : nonNegativeScaled(takerRate, "ceil");
  if (takerRateUnits === null) blockers.push("authenticated_taker_fee_not_proven");

  const nextStop = canonicalDecimalOrNull(input.nextStopPrice);
  const nextTarget = canonicalDecimalOrNull(input.nextTargetPrice);
  const nextStopUnits = nextStop === null ? null : positiveScaled(nextStop);
  const nextTargetUnits = nextTarget === null ? null : positiveScaled(nextTarget);
  if (nextStopUnits === null) blockers.push("next_stop_price_invalid");
  if (nextTargetUnits === null) blockers.push("next_target_price_invalid");
  if (tickUnits !== null) {
    if (nextStopUnits !== null && nextStopUnits % tickUnits !== 0n) blockers.push("next_stop_price_off_tick");
    if (nextTargetUnits !== null && nextTargetUnits % tickUnits !== 0n) blockers.push("next_target_price_off_tick");
  }
  if (current !== null && markUnits !== null && nextStopUnits !== null && nextTargetUnits !== null) {
    if (
      (current.direction === "LONG" && nextStopUnits >= markUnits) ||
      (current.direction === "SHORT" && nextStopUnits <= markUnits)
    ) blockers.push("next_stop_wrong_side_of_mark");
    if (
      (current.direction === "LONG" && nextTargetUnits <= markUnits) ||
      (current.direction === "SHORT" && nextTargetUnits >= markUnits)
    ) blockers.push("next_target_wrong_side_of_mark");
  }

  const requestedReductionBps = input.requestedReductionBps ?? null;
  if (
    requestedReductionBps !== null &&
    (!Number.isSafeInteger(requestedReductionBps) || requestedReductionBps < 1 || requestedReductionBps > 9_999)
  ) blockers.push("requested_reduction_bps_invalid");

  const currentQuantityUnits = current === null ? null : positiveScaled(current.quantity);
  const entryPriceUnits = entryPrice === null ? null : positiveScaled(entryPrice);
  const policyStepUnits = BigInt(input.policy.quantityStepUnits);
  let effectiveStepUnits: bigint | null = null;
  let reductionUnits: bigint | null = null;
  let remainingUnits: bigint | null = null;
  if (venueStepUnits !== null) effectiveStepUnits = leastCommonMultiple(policyStepUnits, venueStepUnits);
  if (currentQuantityUnits === null) blockers.push("owned_current_quantity_invalid");
  if (currentQuantityUnits !== null && effectiveStepUnits !== null) {
    if (currentQuantityUnits % effectiveStepUnits !== 0n) blockers.push("owned_current_quantity_off_effective_step");
    if (requestedReductionBps === null) {
      remainingUnits = currentQuantityUnits;
    } else if (Number.isSafeInteger(requestedReductionBps) && requestedReductionBps > 0 && requestedReductionBps < 10_000) {
      const rawReduction = currentQuantityUnits * BigInt(requestedReductionBps) / 10_000n;
      reductionUnits = rawReduction / effectiveStepUnits * effectiveStepUnits;
      if (reductionUnits <= 0n) blockers.push("requested_reduction_rounds_to_zero");
      else if (reductionUnits >= currentQuantityUnits) blockers.push("requested_reduction_is_not_partial");
      else remainingUnits = currentQuantityUnits - reductionUnits;
    }
  }
  if (remainingUnits !== null && venueMinimumQuantityUnits !== null && remainingUnits < venueMinimumQuantityUnits) {
    blockers.push("remaining_quantity_below_venue_minimum");
  }
  if (remainingUnits !== null && markUnits !== null && effectiveMinimumNotionalCents !== null) {
    if (notionalCents(markUnits, remainingUnits) < effectiveMinimumNotionalCents) {
      blockers.push("remaining_notional_below_effective_minimum");
    }
  }

  const observedDay = new Date(observedAtMs).toISOString().slice(0, 10);
  if (
    input.daily.day !== observedDay ||
    !Number.isSafeInteger(input.daily.startEquityCents) ||
    input.daily.startEquityCents <= 0 ||
    !Number.isSafeInteger(input.daily.highWaterEquityCents) ||
    input.daily.highWaterEquityCents < input.daily.startEquityCents ||
    (input.daily.activeFloorCents !== null && (
      !Number.isSafeInteger(input.daily.activeFloorCents) ||
      input.daily.activeFloorCents <= 0 ||
      input.daily.activeFloorCents > input.daily.highWaterEquityCents
    )) ||
    input.daily.lockReached !== (input.daily.activeFloorCents !== null)
  ) blockers.push("daily_state_invalid_or_wrong_epoch");
  checkFreshness(input.daily.updatedUtc, observedAtMs, dailyMaxAgeMs, "daily_state", blockers);

  let request: BinanceUsdmProtectionRevisionRequest | null = null;
  let equityCents: number | null = null;
  let projectedEquityCents: number | null = null;
  let usablePotCents: number | null = null;
  let dailyStartPotCents: number | null = null;
  let dailyTargetProfitCents: number | null = null;
  let dailyLossBoundaryCents: number | null = null;
  let activeFloorCents = input.daily.activeFloorCents;
  let currentProtectedEquityCents: number | null = null;
  let projectedProtectedEquityCents: number | null = null;
  let currentOpenRiskCents: number | null = null;
  let projectedOpenRiskCents: number | null = null;
  let maximumOpenRiskCents: number | null = null;
  let reductionRealizedPnlCents: number | null = reductionUnits === null ? null : 0;
  let reductionCostCents: number | null = reductionUnits === null ? null : 0;
  let venueRoundTripCostBps: number | null = null;
  let appliedExitCostBps: number | null = null;
  const executablePrice = current?.direction === "LONG" ? bestBid : bestAsk;
  const executableUnits = current?.direction === "LONG" ? bestBidUnits : bestAskUnits;

  if (
    current !== null && walletCents !== null && unrealizedPnlCents !== null &&
    currentQuantityUnits !== null && remainingUnits !== null && entryPriceUnits !== null &&
    markUnits !== null && executableUnits !== null && nextStopUnits !== null &&
    takerRateUnits !== null
  ) {
    equityCents = safeNumber(BigInt(walletCents) + BigInt(unrealizedPnlCents), "management equity");
    if (equityCents <= 0) blockers.push("positive_management_equity_not_proven");
    if (input.daily.highWaterEquityCents < equityCents) blockers.push("daily_state_not_reconciled_to_current_equity");

    venueRoundTripCostBps = ceilRatio(takerRateUnits * 2n, 10_000n, SCALE);
    appliedExitCostBps = Math.max(input.policy.estimatedRoundTripCostBps, venueRoundTripCostBps) +
      input.policy.stressedExitCostBps;
    const currentStopUnits = positiveScaled(current.stopPrice);
    if (currentStopUnits === null) {
      blockers.push("owned_current_stop_price_invalid");
    } else {
      currentProtectedEquityCents = walletCents +
        pnlCents(current.direction, entryPriceUnits, currentStopUnits, currentQuantityUnits) -
        costCents(currentStopUnits, currentQuantityUnits, appliedExitCostBps);

      let projectedWalletCents = walletCents;
      if (reductionUnits !== null) {
        reductionRealizedPnlCents = pnlCents(current.direction, entryPriceUnits, executableUnits, reductionUnits);
        reductionCostCents = costCents(executableUnits, reductionUnits, appliedExitCostBps);
        projectedWalletCents += reductionRealizedPnlCents - reductionCostCents;
      }
      projectedEquityCents = projectedWalletCents +
        pnlCents(current.direction, entryPriceUnits, markUnits, remainingUnits);
      if (projectedEquityCents <= 0) blockers.push("positive_projected_equity_not_proven");
      projectedProtectedEquityCents = projectedWalletCents +
        pnlCents(current.direction, entryPriceUnits, nextStopUnits, remainingUnits) -
        costCents(nextStopUnits, remainingUnits, appliedExitCostBps);
      currentOpenRiskCents = Math.max(0, equityCents - currentProtectedEquityCents);
      projectedOpenRiskCents = Math.max(0, projectedEquityCents - projectedProtectedEquityCents);
      usablePotCents = Math.min(
        projectedEquityCents,
        input.policy.usableBalanceLimitCents ?? projectedEquityCents,
      );
      dailyStartPotCents = Math.min(
        input.daily.startEquityCents,
        input.policy.usableBalanceLimitCents ?? input.daily.startEquityCents,
      );
      dailyTargetProfitCents = floorBps(dailyStartPotCents, input.policy.dailyLockTargetBps);
      const dailyTargetEquityCents = input.daily.startEquityCents + dailyTargetProfitCents;
      dailyLossBoundaryCents = input.daily.startEquityCents -
        floorBps(dailyStartPotCents, input.policy.maxDailyLossBps);
      if (
        currentProtectedEquityCents >= dailyTargetEquityCents ||
        projectedProtectedEquityCents >= dailyTargetEquityCents
      ) activeFloorCents = Math.max(activeFloorCents ?? 0, dailyTargetEquityCents);
      maximumOpenRiskCents = floorBps(Math.max(0, usablePotCents), input.policy.maxOpenRiskBps);

      if (projectedProtectedEquityCents < currentProtectedEquityCents) {
        blockers.push("revision_would_weaken_protected_equity");
      }
      if (projectedProtectedEquityCents <= dailyLossBoundaryCents) {
        blockers.push("projected_protected_equity_reaches_daily_loss_boundary");
      }
      if (activeFloorCents !== null && projectedProtectedEquityCents < activeFloorCents) {
        blockers.push("projected_protected_equity_violates_active_floor");
      }
      if (projectedOpenRiskCents > maximumOpenRiskCents) {
        blockers.push("projected_open_risk_exceeds_policy");
      }
    }
  }

  if (
    current !== null && nextStop !== null && nextTarget !== null && remainingUnits !== null &&
    (requestedReductionBps === null || reductionUnits !== null)
  ) {
    try {
      const validated = validateBinanceUsdmProtectionRevision({
        revisionIntentId: input.revisionIntentId,
        current: { ...current },
        reductionQuantity: reductionUnits === null ? null : scaledString(reductionUnits),
        nextStopPrice: nextStop,
        nextTargetPrice: nextTarget,
      });
      request = {
        revisionIntentId: validated.revisionIntentId,
        current: { ...validated.current },
        reductionQuantity: validated.reductionQuantity,
        nextStopPrice: validated.nextStopPrice,
        nextTargetPrice: validated.nextTargetPrice,
      };
    } catch {
      blockers.push("canonical_protection_revision_invalid");
    }
  }

  const uniqueBlockers = [...new Set(blockers)].sort();
  if (uniqueBlockers.length > 0) request = null;
  return deepFreeze({
    schema_version: "glitch.crypto.binance-usdm-protection-management-plan.v1",
    venue: "binance-usdm",
    environment: "testnet",
    status: uniqueBlockers.length === 0 && request !== null ? "ready" : "blocked",
    mutation_authority: false,
    engine_binding_authority: false,
    observed_utc: new Date(observedAtMs).toISOString(),
    binding_observed_utc: binding.observed_utc,
    evidence_observed_utc: evidence.observed_utc,
    binding_state_body_hash: binding.state_body_hash,
    binding_transition_sequence: binding.transition_sequence,
    request,
    account: {
      wallet_balance_cents: walletCents,
      unrealized_pnl_cents: unrealizedPnlCents,
      equity_cents: equityCents,
      projected_equity_cents: projectedEquityCents,
      leverage,
    },
    market: {
      mark_price: markPrice,
      best_bid: bestBid,
      best_ask: bestAsk,
      reduction_executable_price: executablePrice,
    },
    risk: {
      usable_pot_cents: usablePotCents,
      daily_start_pot_cents: dailyStartPotCents,
      daily_target_profit_cents: dailyTargetProfitCents,
      daily_loss_boundary_cents: dailyLossBoundaryCents,
      active_floor_cents: activeFloorCents,
      current_protected_equity_cents: currentProtectedEquityCents,
      projected_protected_equity_cents: projectedProtectedEquityCents,
      current_open_risk_cents: currentOpenRiskCents,
      projected_open_risk_cents: projectedOpenRiskCents,
      maximum_open_risk_cents: maximumOpenRiskCents,
      reduction_realized_pnl_cents: reductionRealizedPnlCents,
      reduction_cost_cents: reductionCostCents,
      venue_round_trip_cost_bps: venueRoundTripCostBps,
      applied_exit_cost_bps: appliedExitCostBps,
    },
    precision: {
      tick_size: tickUnits === null ? null : canonicalPositiveDecimal(rules.tick_size, "management tick size"),
      venue_quantity_step: venueStepUnits === null ? null : scaledString(venueStepUnits),
      effective_quantity_step: effectiveStepUnits === null ? null : scaledString(effectiveStepUnits),
      venue_minimum_quantity: venueMinimumQuantityUnits === null ? null : scaledString(venueMinimumQuantityUnits),
      venue_minimum_notional_cents: venueMinimumNotionalCents,
      effective_minimum_notional_cents: effectiveMinimumNotionalCents,
      requested_reduction_bps: requestedReductionBps,
      derived_reduction_quantity: reductionUnits === null ? null : scaledString(reductionUnits),
      remaining_quantity: remainingUnits === null ? null : scaledString(remainingUnits),
    },
    blockers: uniqueBlockers,
  });
}

function strictRecords(value: unknown, prefix: string, blockers: string[]): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    blockers.push(`${prefix}_invalid`);
    return [];
  }
  const records = value.map(record);
  if (records.some((item) => item === null)) blockers.push(`${prefix}_invalid`);
  return records.filter((item): item is Record<string, unknown> => item !== null);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveText(value: unknown): string | null {
  const result = nonNegativeText(value);
  return result !== null && !zeroDecimal(result) ? result : null;
}

function nonNegativeText(value: unknown): string | null {
  return typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) ? value : null;
}

function signedText(value: unknown): string | null {
  return typeof value === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) ? value : null;
}

function unsignedAbsolute(value: string): string {
  return canonicalPositiveDecimal(value.startsWith("-") ? value.slice(1) : value, "position quantity");
}

function zeroDecimal(value: string): boolean {
  return /^-?0(?:\.0+)?$/.test(value);
}

function canonicalDecimalOrNull(value: unknown): string | null {
  try {
    return canonicalPositiveDecimal(String(value), "management price");
  } catch {
    return null;
  }
}

function positiveScaled(value: string): bigint | null {
  const result = nonNegativeScaled(value, "exact");
  return result !== null && result > 0n ? result : null;
}

function nonNegativeScaled(value: string, rounding: "exact" | "ceil"): bigint | null {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
  const [whole = "0", fraction = ""] = value.split(".");
  const kept = fraction.slice(0, SCALE_DIGITS).padEnd(SCALE_DIGITS, "0");
  const discarded = fraction.slice(SCALE_DIGITS);
  if (rounding === "exact" && /[1-9]/.test(discarded)) return null;
  let result = BigInt(whole) * SCALE + BigInt(kept || "0");
  if (rounding === "ceil" && /[1-9]/.test(discarded)) result += 1n;
  return result;
}

function decimalToCents(value: string, rounding: "floor" | "ceil"): number | null {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
  const [whole = "0", fraction = ""] = value.split(".");
  const kept = fraction.slice(0, 2).padEnd(2, "0");
  const discarded = fraction.slice(2);
  let result = BigInt(whole) * 100n + BigInt(kept || "0");
  if (rounding === "ceil" && /[1-9]/.test(discarded)) result += 1n;
  return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : null;
}

function signedDecimalToCentsFloor(value: string): number | null {
  const negative = value.startsWith("-");
  const absolute = negative ? value.slice(1) : value;
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(absolute)) return null;
  const [whole = "0", fraction = ""] = absolute.split(".");
  const kept = fraction.slice(0, 2).padEnd(2, "0");
  const discarded = fraction.slice(2);
  let magnitude = BigInt(whole) * 100n + BigInt(kept || "0");
  if (negative && /[1-9]/.test(discarded)) magnitude += 1n;
  const result = negative ? -magnitude : magnitude;
  return result >= BigInt(Number.MIN_SAFE_INTEGER) && result <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(result)
    : null;
}

function pnlCents(
  direction: BinanceUsdmOwnedProtection["direction"],
  entryPriceUnits: bigint,
  exitPriceUnits: bigint,
  quantityUnits: bigint,
): number {
  const difference = direction === "LONG"
    ? exitPriceUnits - entryPriceUnits
    : entryPriceUnits - exitPriceUnits;
  return floorSignedRatio(difference * quantityUnits * 100n, SCALE * SCALE);
}

function notionalCents(priceUnits: bigint, quantityUnits: bigint): number {
  return ceilRatio(priceUnits * quantityUnits, 100n, SCALE * SCALE);
}

function costCents(priceUnits: bigint, quantityUnits: bigint, bps: number): number {
  return ceilRatio(BigInt(notionalCents(priceUnits, quantityUnits)), BigInt(bps), 10_000n);
}

function floorBps(value: number, bps: number): number {
  return safeNumber(BigInt(value) * BigInt(bps) / 10_000n, "basis-point floor");
}

function ceilRatio(left: bigint, right: bigint, denominator: bigint): number {
  const numerator = left * right;
  return safeNumber((numerator + denominator - 1n) / denominator, "ceiling ratio");
}

function floorSignedRatio(numerator: bigint, denominator: bigint): number {
  const result = numerator >= 0n
    ? numerator / denominator
    : -((-numerator + denominator - 1n) / denominator);
  return safeNumber(result, "signed floor ratio");
}

function safeNumber(value: bigint, name: string): number {
  if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${name} exceeds safe integer range`);
  }
  return Number(value);
}

function scaledString(value: bigint): string {
  const whole = value / SCALE;
  const fraction = (value % SCALE).toString().padStart(SCALE_DIGITS, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function leastCommonMultiple(left: bigint, right: bigint): bigint {
  return left / greatestCommonDivisor(left, right) * right;
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function safeInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function checkFreshness(
  value: string,
  observedAtMs: number,
  maximumAgeMs: number,
  prefix: string,
  blockers: string[],
): void {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) blockers.push(`${prefix}_time_invalid`);
  else if (time > observedAtMs) blockers.push(`${prefix}_time_in_future`);
  else if (observedAtMs - time > maximumAgeMs) blockers.push(`${prefix}_stale`);
}

function integer(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
