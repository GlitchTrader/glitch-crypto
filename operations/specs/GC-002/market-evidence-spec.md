# GC-002 Phase E Specification — raw Binance market evidence

## Purpose

Retain finite, replay-eligible BTCUSDT aggregate-trade and mark-price facts from
the selected venue before GC-003 defines features, labels, costs, or candidates.

## Functional requirements

### FR-E001 Routed transport

The recorder MUST connect through the Binance USDⓈ-M `/market` route and request
exactly `<symbol>@aggTrade` plus `<symbol>@markPrice@1s` on one read-only socket.

### FR-E002 Raw-before-derived evidence

The full provider payload MUST be retained before strict inspection. Required
identity, event-time, symbol, price, quantity, side, funding, and trade fields
MUST be validated while unknown provider extensions remain intact in evidence.

### FR-E003 Fail-closed identity

Wrong symbols, unsupported event families, malformed required fields,
non-increasing aggregate-trade IDs, and backwards per-family event time MUST
close the current socket and enter bounded reconnect backoff.

### FR-E004 Finite capture

The CLI MUST bound capture duration to 5-300 seconds, refuse to overwrite prior
evidence, use the bounded rotating JSONL sink, stop the socket, and write a
content-addressed verification manifest.

### FR-E005 Replay eligibility

A finite capture is replay-eligible only when it contains exactly one contiguous
session, monotonic recorder timestamps, complete connecting/running/stopped
lifecycle evidence, configured minimum counts for both event families, no
malformed events, no error records, and no reconnect/backoff boundary.

## Safety invariants

- `mutation_authority` is always `false`.
- The recorder has no credentials, REST client, account state, or order method.
- Raw market evidence is not a setup, decision, fill, outcome, or profitability claim.
- Aggregate-trade ID gaps are retained but not interpreted as missing events
  until the venue contract or observed reconciliation proves that inference.
- GC-003 remains blocked until its Rail dependencies are satisfied.

## Acceptance

1. Strict event inspection accepts the observed current Testnet payload shape
   while preserving provider extensions.
2. Constructed sockets use `/market` and the exact two requested streams.
3. Invalid identity or ordering enters backoff and is attributable.
4. A clean finite fixture produces a stable SHA-256 manifest and passes replay
   eligibility; errors or incomplete lifecycle evidence fail it.
5. A bounded external capture proves both event families on the selected route.
6. The full repository gate passes.

## Non-goals

- Features, labels, opportunity ranking, fill models, target-before-stop models,
  costs, shadow decisions, execution, or automatic learning.
