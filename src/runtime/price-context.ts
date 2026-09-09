// Descriptive completed-bar evidence, never a strategy or probability model.
export interface Candle {
  open_time_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quote_volume: number;
  close_time_ms: number;
}

export function completedCandles(value: unknown, nowMs: number): Candle[] {
  if (!Array.isArray(value)) throw new Error("kline response must be an array");
  const result: Candle[] = [];
  for (const row of value) {
    if (!Array.isArray(row) || row.length < 8) throw new Error("invalid kline row");
    const [time, open, high, low, close, volume, end, quote] = row.slice(0, 8).map(Number);
    if ([time, open, high, low, close, volume, end, quote].some((n) => !Number.isFinite(n)) ||
        time! % 60_000 !== 0 || end! !== time! + 59_999 ||
        low! <= 0 || low! > Math.min(open!, close!) || high! < Math.max(open!, close!) ||
        volume! < 0 || quote! < 0) throw new Error("invalid kline values");
    if (end! >= nowMs) continue; // The current partial is not a completed candle.
    if (result.length && time! !== result.at(-1)!.open_time_ms + 60_000) {
      throw new Error("non-contiguous one-minute candles");
    }
    result.push({ open_time_ms: time!, open: open!, high: high!, low: low!, close: close!,
      volume: volume!, quote_volume: quote!, close_time_ms: end! });
  }
  return result.slice(-360);
}

export function describePriceContext(bars: readonly Candle[]): Record<string, unknown> {
  const windows = [15, 60, 360].map((minutes) => {
    const sample = bars.slice(-minutes);
    const first = sample[0];
    const last = sample.at(-1);
    const volume = sample.reduce((n, b) => n + b.volume, 0);
    let traveled = 0;
    let gains = 0;
    let losses = 0;
    const tr: number[] = [];
    for (let i = 0; i < sample.length; i++) {
      const b = sample[i]!;
      const previous = i ? sample[i - 1]!.close : b.open;
      const change = b.close - previous;
      traveled += Math.abs(change);
      tr.push(Math.max(b.high - b.low, Math.abs(b.high - previous), Math.abs(b.low - previous)));
      if (i >= sample.length - 14) {
        gains += Math.max(0, change);
        losses += Math.max(0, -change);
      }
    }
    return {
      minutes, observed_bars: sample.length,
      high: sample.length ? Math.max(...sample.map((b) => b.high)) : null,
      low: sample.length ? Math.min(...sample.map((b) => b.low)) : null,
      change_bps: first && last ? (last.close / first.open - 1) * 10_000 : null,
      directional_efficiency: first && last && traveled ? (last.close - first.open) / traveled : null,
      window_vwap: volume ? sample.reduce((n, b) => n + b.quote_volume, 0) / volume : null,
      atr14_simple: tr.length >= 14 ? tr.slice(-14).reduce((a, b) => a + b, 0) / 14 : null,
      rsi14_simple: sample.length >= 14 && gains + losses > 0 ? 100 * gains / (gains + losses) : null,
    };
  });
  // Use aligned, fully completed five-minute groups, not overlapping pseudo-bars.
  const groups = new Map<number, Candle[]>();
  for (const bar of bars) {
    const key = Math.floor(bar.open_time_ms / 300_000) * 300_000;
    groups.set(key, [...(groups.get(key) ?? []), bar]);
  }
  const five = [...groups.values()].filter((g) => g.length === 5).map((g) => ({
    open_time_ms: g[0]!.open_time_ms, open: g[0]!.open,
    high: Math.max(...g.map((b) => b.high)), low: Math.min(...g.map((b) => b.low)),
    close: g[4]!.close, volume: g.reduce((n, b) => n + b.volume, 0),
  }));
  return {
    schema_version: "glitch.crypto.price-context.v1", source: "Binance public 1m klines",
    completed_through_ms: bars.at(-1)?.close_time_ms ?? null,
    interpretation: "Observed ranges are context, not prescribed stops/targets. Window VWAP is not session VWAP. ATR/RSI use simple 14-bar averages, not Wilder smoothing. No probability estimate.",
    windows, completed_1m: bars.slice(-30), completed_5m: five.slice(-72),
  };
}
