# Binance USDⓈ-M raw market evidence

This GC-002 source gate captures venue facts for later replay without credentials
or mutation authority.

## Capture

Production public market data is the default:

```bash
npm run build
npm run binance:market-evidence -- capture 15 ./artifacts/binance-market.jsonl
```

For Futures Testnet, set the bare streams origin:

```text
GLITCH_BINANCE_USDM_STREAMS_URL=wss://fstream.binancefuture.com
```

The recorder constructs the `/market` route and subscribes to BTCUSDT
`aggTrade` and `markPrice@1s`. Capture duration is limited to 5-300 seconds, an
existing evidence file is never overwritten, and a `.manifest.json` report is
written beside accepted or rejected evidence.

## Verify

```bash
npm run binance:market-evidence -- verify ./artifacts/binance-market.jsonl
```

Optional minimum-count settings:

```text
GLITCH_BINANCE_USDM_MARKET_MIN_AGG_TRADES=10
GLITCH_BINANCE_USDM_MARKET_MIN_MARK_PRICES=5
```

## Claim boundary

An accepted capture is raw replay input. It does not prove fill behavior,
latency, costs, model calibration, opportunity, execution safety, or
profitability, and it does not unblock GC-003 by itself.

## Accepted source fixture

The 2026-08-24 local-date mainnet capture retained under
`operations/evidence/GC-002/` contains 245 aggregate trades and 12 mark-price
updates over 15.016 seconds with no error or reconnect boundary. Its canonical
evidence SHA-256 is
`07185347c6e1f6bdc0f2900b026f49d753d41c6de573904e4c7d8315669eb48c`.
