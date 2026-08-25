# Binance USDⓈ-M authenticated private evidence

This GC-002 gate turns account supervision into a finite, replay-verified local
capture. It is dormant until Futures Testnet credentials are provided and use is
explicitly approved.

## Required environment

```text
GLITCH_BINANCE_USDM_BASE_URL=https://demo-fapi.binance.com
GLITCH_BINANCE_USDM_STREAMS_URL=wss://fstream.binancefuture.com
GLITCH_BINANCE_USDM_API_KEY=...
GLITCH_BINANCE_USDM_API_SECRET=...
```

The command rejects production origins, missing credentials, an unsafe account
preflight, and existing evidence before creating the listen-key session.

## Capture

```bash
npm run build
npm run binance:private-evidence -- capture 60 ./artifacts/binance-private.jsonl
```

Duration is limited to 5-300 seconds. The JSONL contains sanitized but private
account evidence and stays local by default. Do not commit it. The adjacent
manifest contains only content identity, lifecycle/count data, and replay state
counts—never exact balances, quantities, position/order payloads, credentials,
listen keys, or raw events.

At least one supported user-data event is required. A quiet account can pass
preflight but will correctly fail private transport acceptance until an
explicitly approved Testnet action generates attributable account/order events.

## Verify

```bash
npm run binance:private-evidence -- verify ./artifacts/binance-private.jsonl
```

The source gate does not authorize a Testnet order, production credential use,
or live-capital mutation.
