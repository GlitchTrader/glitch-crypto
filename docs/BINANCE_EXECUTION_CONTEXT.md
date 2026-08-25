# Binance USD-M Testnet execution context

GC-002 Phase K compiles current Testnet account and market facts into one
immutable `ready|blocked` object before any engine binding is considered.

## Inputs

The pure compiler accepts:

- a fresh authenticated GET-only Testnet preflight report;
- supervised public depth and private account status;
- current aggregate-trade and mark-price recorder status;
- an explicit observation clock and bounded freshness policy.

It performs no network request and imports no signer or mutation client.

## Ready envelope

`ready` requires:

- one BTCUSDT identity across every source;
- a fresh accepted preflight;
- running public depth, public market, and private lanes;
- a fresh ready non-crossed order book;
- fresh aggregate-trade and mark-price summaries from the current connection;
- a fresh private REST reconciliation and unexpired user stream;
- positive reconciled USDT wallet and available balances;
- no native exposure or active order;
- accepted fee, leverage, precision, quantity, and notional inputs.

Every failed observation is returned as a stable blocker code. The output is
deeply frozen and serializable. It contains no credential, socket, client,
callback, signer, or mutation handle.

## Capability boundary

The context reports the current source capability truth:

- protected entry, full protected close, and restart reconciliation exist;
- partial reduction and stop/target amendment do not yet exist in the Binance
  coordinator.

Even a ready context declares:

```text
mutation_authority = false
engine_binding_authority = false
```

It is a prerequisite object, not a venue selector or trading command. No CLI,
HTTP route, environment switch, or engine integration is exposed by Phase K.
