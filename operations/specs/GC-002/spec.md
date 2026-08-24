# GC-002 Phase A Specification — Binance USDⓈ-M read-only shadow evidence

## Purpose

Connect GC-001 to real venue evidence without creating any order mutation path. The result is a direct, dependency-light Binance USDⓈ-M observation adapter that can capture public data and signed read-only account state, replay sequence-sensitive market/private events, and fail closed on contract drift or gaps.

## Functional requirements

### FR-001 Endpoint authority

The adapter MUST expose only an explicit allowlist of public and signed `GET` endpoints. Unknown endpoints and every trading mutation endpoint MUST be rejected before transport.

### FR-002 Credential isolation

API key, API secret, signatures, listen keys, authorization headers, and configured forbidden values MUST be removed from evidence and errors. The CLI MUST never print credentials.

### FR-003 Deterministic signing

Signed read requests MUST use canonical query encoding, timestamp, bounded receive window, and HMAC-SHA256. Signature construction MUST be deterministic and unit-tested.

### FR-004 Clock discipline

The client MUST observe venue server time and apply an explicit local offset before signed requests.

### FR-005 Exact instrument contract

`exchangeInfo` MUST be parsed into an exact BTCUSDT perpetual contract containing status, contract type, assets, tick size, quantity steps, minimums, precision, order types, and time-in-force declarations. Missing or nontrading contracts MUST fail closed.

### FR-006 Public evidence

A public capture MUST include server time, exchange information, parsed symbol rules, book ticker, depth snapshot, and premium/mark information.

### FR-007 Signed read-only evidence

An authenticated capture MAY include balance, position risk, open orders, commission rate, position mode, multi-asset mode, symbol configuration, and account configuration. It MUST require both key and secret and MUST use no trading endpoint.

### FR-008 Depth continuity

The local order book MUST buffer deltas before a snapshot, discard stale events, accept the overlapping first event, require subsequent continuity, ignore duplicates, remove zero-quantity levels, and invalidate itself on update gaps or `pu` mismatch.

### FR-009 Private-state replay

The private reducer MUST idempotently apply account and order updates, detect stream expiration, and expose attributable balances, positions, and orders.

### FR-010 Restart reconciliation

REST balances, positions, and open orders MUST be able to reconstruct the private view after restart before incremental events resume.

### FR-011 Operator surface

`npm run binance:shadow -- capture-public` MUST capture public evidence. `capture-account` MUST add signed read-only evidence. `rules` MUST print the parsed instrument contract.

## Safety invariants

- `mutation_authority` is always `false`.
- No method in the adapter sends `POST`, `PUT`, `PATCH`, or `DELETE`.
- No route or CLI command can place, amend, cancel, or close an order.
- Provider errors never include signed URLs.
- A gapped book cannot silently return to ready state without a new snapshot.
- Tests and shadow evidence do not authorize production arming.

## Acceptance tests

1. Known HMAC vector matches exactly.
2. Sensitive keys, query values, and configured credential strings are redacted.
3. BTCUSDT fixture yields exact tick, step, and minimum-notional contract.
4. Missing/nontrading instrument fixtures fail closed.
5. Buffered depth fixture joins the snapshot and updates best bid/ask.
6. Duplicate depth update is ignored.
7. `pu` mismatch invalidates the book.
8. Duplicate private event is idempotent.
9. REST reconciliation reconstructs balances, positions, and open orders.
10. Captured evidence contains no configured credential and every transport call is `GET`.
11. A trading endpoint outside the allowlist is rejected before transport.
12. Full repository `npm run check` passes in CI.
