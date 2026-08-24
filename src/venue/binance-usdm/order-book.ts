export type BinanceUsdmOrderBookStatus = "empty" | "buffering" | "ready" | "gapped";
export type BinancePriceLevel = readonly [price: string, quantity: string];

export interface BinanceDepthSnapshot {
  lastUpdateId: number;
  bids: BinancePriceLevel[];
  asks: BinancePriceLevel[];
}

export interface BinanceDepthDelta {
  U: number;
  u: number;
  pu?: number;
  b: BinancePriceLevel[];
  a: BinancePriceLevel[];
  E?: number;
  T?: number;
  s?: string;
}

export interface BinanceOrderBookView {
  schema_version: "glitch.crypto.binance-usdm-order-book.v1";
  status: BinanceUsdmOrderBookStatus;
  symbol: string | null;
  update_id: number | null;
  event_time: number | null;
  transaction_time: number | null;
  best_bid: BinancePriceLevel | null;
  best_ask: BinancePriceLevel | null;
  bids: BinancePriceLevel[];
  asks: BinancePriceLevel[];
  buffered_events: number;
  gap_reason: string | null;
}

export type BinanceDepthApplyResult = "buffered" | "applied" | "ignored" | "gapped";

export class BinanceUsdmOrderBook {
  private readonly bids = new Map<string, string>();
  private readonly asks = new Map<string, string>();
  private buffered: BinanceDepthDelta[] = [];
  private status: BinanceUsdmOrderBookStatus = "empty";
  private symbol: string | null = null;
  private updateId: number | null = null;
  private eventTime: number | null = null;
  private transactionTime: number | null = null;
  private gapReason: string | null = null;

  ingest(input: BinanceDepthDelta): BinanceDepthApplyResult {
    const delta = validateDelta(input);
    if (this.status === "gapped") {
      return "gapped";
    }
    if (this.updateId === null) {
      this.status = "buffering";
      this.buffered.push(delta);
      return "buffered";
    }
    return this.applyLive(delta);
  }

  loadSnapshot(input: BinanceDepthSnapshot): BinanceOrderBookView {
    const snapshot = validateSnapshot(input);
    this.bids.clear();
    this.asks.clear();
    applyLevels(this.bids, snapshot.bids);
    applyLevels(this.asks, snapshot.asks);
    this.updateId = snapshot.lastUpdateId;
    this.eventTime = null;
    this.transactionTime = null;
    this.gapReason = null;
    this.status = "ready";

    const pending = this.buffered;
    this.buffered = [];
    let firstApplied = false;
    for (const delta of pending) {
      if (delta.u <= snapshot.lastUpdateId) {
        continue;
      }
      if (!firstApplied) {
        if (delta.U > snapshot.lastUpdateId + 1) {
          this.markGap(
            `snapshot_update_gap:${snapshot.lastUpdateId}->${delta.U}`,
          );
          break;
        }
        if (delta.u < snapshot.lastUpdateId + 1) {
          continue;
        }
        this.applyLevelsAndAdvance(delta);
        firstApplied = true;
        continue;
      }
      if (this.applyLive(delta) === "gapped") {
        break;
      }
    }
    return this.view();
  }

  reset(): void {
    this.bids.clear();
    this.asks.clear();
    this.buffered = [];
    this.status = "empty";
    this.symbol = null;
    this.updateId = null;
    this.eventTime = null;
    this.transactionTime = null;
    this.gapReason = null;
  }

  view(depth = 20): BinanceOrderBookView {
    if (!Number.isInteger(depth) || depth < 1 || depth > 5_000) {
      throw new Error("order-book depth must be an integer between 1 and 5000");
    }
    const bids = sortedLevels(this.bids, "desc", depth);
    const asks = sortedLevels(this.asks, "asc", depth);
    return {
      schema_version: "glitch.crypto.binance-usdm-order-book.v1",
      status: this.status,
      symbol: this.symbol,
      update_id: this.updateId,
      event_time: this.eventTime,
      transaction_time: this.transactionTime,
      best_bid: bids[0] ?? null,
      best_ask: asks[0] ?? null,
      bids,
      asks,
      buffered_events: this.buffered.length,
      gap_reason: this.gapReason,
    };
  }

  private applyLive(delta: BinanceDepthDelta): BinanceDepthApplyResult {
    const current = this.updateId;
    if (current === null) {
      throw new Error("order-book live application requires a snapshot");
    }
    if (delta.u <= current) {
      return "ignored";
    }
    if (delta.pu !== undefined && delta.pu !== current) {
      this.markGap(`previous_update_mismatch:${current}->${delta.pu}`);
      return "gapped";
    }
    if (delta.U > current + 1) {
      this.markGap(`first_update_gap:${current}->${delta.U}`);
      return "gapped";
    }
    this.applyLevelsAndAdvance(delta);
    return "applied";
  }

  private applyLevelsAndAdvance(delta: BinanceDepthDelta): void {
    if (delta.s && this.symbol !== null && this.symbol !== delta.s) {
      this.markGap(`symbol_changed:${this.symbol}->${delta.s}`);
      return;
    }
    applyLevels(this.bids, delta.b);
    applyLevels(this.asks, delta.a);
    this.updateId = delta.u;
    this.eventTime = delta.E ?? this.eventTime;
    this.transactionTime = delta.T ?? this.transactionTime;
    if (delta.s) {
      this.symbol = delta.s;
    }
    this.status = "ready";
  }

  private markGap(reason: string): void {
    this.status = "gapped";
    this.gapReason = reason;
  }
}

function validateSnapshot(input: BinanceDepthSnapshot): BinanceDepthSnapshot {
  return {
    lastUpdateId: positiveSafeInteger(input.lastUpdateId, "snapshot lastUpdateId"),
    bids: validateLevels(input.bids, "snapshot bids"),
    asks: validateLevels(input.asks, "snapshot asks"),
  };
}

function validateDelta(input: BinanceDepthDelta): BinanceDepthDelta {
  const first = positiveSafeInteger(input.U, "delta first update ID");
  const final = positiveSafeInteger(input.u, "delta final update ID");
  if (first > final) {
    throw new Error("delta first update ID cannot exceed final update ID");
  }
  const previous = input.pu === undefined
    ? undefined
    : nonNegativeSafeInteger(input.pu, "delta previous update ID");
  return {
    U: first,
    u: final,
    ...(previous === undefined ? {} : { pu: previous }),
    b: validateLevels(input.b, "delta bids"),
    a: validateLevels(input.a, "delta asks"),
    ...(input.E === undefined ? {} : { E: nonNegativeSafeInteger(input.E, "event time") }),
    ...(input.T === undefined ? {} : { T: nonNegativeSafeInteger(input.T, "transaction time") }),
    ...(input.s === undefined ? {} : { s: nonEmptyString(input.s, "symbol") }),
  };
}

function validateLevels(levels: BinancePriceLevel[], name: string): BinancePriceLevel[] {
  if (!Array.isArray(levels)) {
    throw new Error(`${name} must be an array`);
  }
  return levels.map((level, index) => {
    if (!Array.isArray(level) || level.length < 2) {
      throw new Error(`${name}[${index}] must contain price and quantity`);
    }
    const price = positiveDecimal(level[0], `${name}[${index}] price`);
    const quantity = nonNegativeDecimal(level[1], `${name}[${index}] quantity`);
    return [price, quantity] as const;
  });
}

function applyLevels(book: Map<string, string>, levels: readonly BinancePriceLevel[]): void {
  for (const [price, quantity] of levels) {
    if (Number(quantity) === 0) {
      book.delete(price);
    } else {
      book.set(price, quantity);
    }
  }
}

function sortedLevels(
  book: Map<string, string>,
  direction: "asc" | "desc",
  depth: number,
): BinancePriceLevel[] {
  return [...book.entries()]
    .sort(([left], [right]) => {
      const comparison = Number(left) - Number(right);
      return direction === "asc" ? comparison : -comparison;
    })
    .slice(0, depth)
    .map(([price, quantity]) => [price, quantity] as const);
}

function positiveSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value as number;
}

function nonNegativeSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value as number;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function positiveDecimal(value: unknown, name: string): string {
  const result = nonNegativeDecimal(value, name);
  if (Number(result) <= 0) {
    throw new Error(`${name} must be positive`);
  }
  return result;
}

function nonNegativeDecimal(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new Error(`${name} must be a non-negative decimal string`);
  }
  return value;
}
