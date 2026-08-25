# GC-002 Venue Decision — Phase A

## Decision

Use **Binance USDⓈ-M as the first read-only shadow benchmark**. Do not yet accept any venue for production mutation.

## Why this is the next reversible step

The official Binance JavaScript USDⓈ-M connector exposes REST, WebSocket API, and WebSocket Streams surfaces for market data, exchange information, account state, positions, open orders, commission rates, and user events. The official generated contract includes depth update identifiers `U`, `u`, and `pu`, exchange filters, account configuration, user commission rate, and user-data event types.

This gives GC-002 enough declared surface area to prove:

- deterministic HMAC identity;
- exact BTCUSDT precision and minimums;
- public book continuity and gap recovery;
- private state reduction and restart reconciliation;
- credential-safe evidence capture.

It does not prove that the user's account can access Binance derivatives, that the actual fee tier is economically acceptable, or that Binance is the best production venue.

## Capability matrix

| Capability | Binance USDⓈ-M | OKX | Hyperliquid |
|---|---|---|---|
| Official direct API contract | Declared; official connector inspected at commit `092e4f289e9047114fb8ec66256510cc207e16bb` | Pending GC-002 comparison | Pending GC-002 comparison |
| BTC linear perpetual | Declared | Pending | Pending |
| Public REST market/depth | Declared | Pending | Pending |
| Public diff-depth stream | Declared; `U`, `u`, `pu` fields | Pending | Pending |
| Signed read-only account endpoints | Declared | Pending | Pending |
| Authenticated commission rate | Declared | Pending | Pending |
| Position and margin-mode discovery | Declared | Pending | Pending |
| Open-order reconciliation | Declared | Pending | Pending |
| Native conditional protection | Declared in API surface; not accepted | Pending | Pending |
| Account/jurisdiction access | Runtime evidence required | Runtime evidence required | Runtime evidence required |
| Actual maker/taker fee tier | Runtime evidence required | Runtime evidence required | Runtime evidence required |
| Observed latency/depth/fills | Runtime evidence required | Runtime evidence required | Runtime evidence required |
| Production mutation acceptance | **Not accepted** | Not accepted | Not accepted |

## Phase-A acceptance boundary

Accepted in this branch:

- public market and exchange-information capture;
- signed read-only account capture;
- exact endpoint allowlisting;
- secret redaction and forbidden-value checks;
- precision parsing;
- deterministic local order-book replay;
- private account/order event replay;
- REST restart reconciliation.

Not accepted in this branch:

- API keys with trade permission as a requirement;
- order placement or cancellation;
- leverage, margin-type, or position-mode mutation;
- user-data listen-key lifecycle;
- live WebSocket transport supervision;
- production arming.

## Promotion evidence still required

1. Confirm account and jurisdiction access.
2. Capture authenticated commission rate and symbol configuration using a read-only key.
3. Run continuous public/private shadow observation with bounded sanitized evidence.
4. Prove reconnect, gap, duplicate, out-of-order, and restart behavior against observed fixtures.
5. Compare OKX and Hyperliquid against the same matrix.
6. Only then specify the mutation/protection phase.

## Mutation contract update — 2026-08-24

The current official USD-M contract declares separate ordinary
`/fapi/v1/order` and conditional `/fapi/v1/algoOrder` surfaces, deterministic
client identities and exact query endpoints. Phase D specifies this declared
contract behind a Testnet/loopback-only boundary in `mutation-spec.md`.
Declaration and deterministic tests do not accept production mutation.
