# Binance USDⓈ-M read-only shadow adapter

GC-002 phase A observes Binance USDⓈ-M without exposing any trading mutation method.

## Public capture

```bash
npm run build
npm run binance:shadow -- capture-public
```

The result contains server time, exchange information, the parsed BTCUSDT precision contract, book ticker, depth snapshot, and premium/mark information.

## Authenticated read-only capture

Configure a dedicated API key without trade permission:

```text
GLITCH_BINANCE_USDM_API_KEY=...
GLITCH_BINANCE_USDM_API_SECRET=...
```

Then run:

```bash
npm run binance:shadow -- capture-account
```

The result adds balances, position risk, open orders, commission rate, position mode, multi-asset mode, symbol configuration, and account configuration.

## Instrument contract only

```bash
npm run binance:shadow -- rules
```

## Safety boundary

- The client permits only an explicit allowlist of `GET` endpoints.
- It contains no order, cancel, amend, leverage-change, margin-change, or position-mode mutation method.
- API keys, secrets, signatures, and signed URLs are not emitted.
- `mutation_authority` is always `false`.
- This phase does not authorize production arming.
