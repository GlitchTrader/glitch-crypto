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

Execution-context version 3 reports the current source capability truth:

- protected entry, exact partial reduction, stop-first stop/target replacement,
  exact full close for the currently owned protection pair, and restart
  reconciliation exist;
- Binance still has no native untriggered conditional-order amendment, so
  protection movement uses attributable replacement;
- private position/account binding and asynchronous engine integration remain
  separate readiness gates.

Even a ready context declares:

```text
mutation_authority = false
engine_binding_authority = false
```

It is a prerequisite object, not a venue selector or trading command. No CLI,
HTTP route, environment switch, or engine integration is exposed by Phase K.

## Durable management binding

Phase N adds a separate `OwnedProtectionState` and
`OwnedProtectionBinding`. The state persists the current position-management
pointer and the complete canonical request for a nonterminal entry, revision,
or close using integrity-checked compare-and-set storage. Typed staging must be
saved before transport; same-body replay is idempotent and a changed body is a
conflict. The binding compares
that pointer with a fresh one-way private position and exact active reduce-only
stop/target Algo proofs.

`ready` means those supplied management facts agree; `flat` means the durable
pointer and native position are both absent; either can become `blocked` on
staleness, stream degradation, pending reconciliation, unowned exposure/order,
or any symbol, direction, quantity, geometry, or identity mismatch. The output
is deeply frozen, selected-field only, credential-free, and still declares
`mutation_authority=false` and `engine_binding_authority=false`.
