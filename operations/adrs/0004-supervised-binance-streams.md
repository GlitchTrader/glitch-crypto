# ADR 0004 — Supervise Binance streams before accepting mutation

## Status

Accepted for GC-002 phase B on 2026-08-24.

## Context

GC-002 phase A proved direct REST signing, precision discovery, credential isolation, deterministic public book replay, private-state reduction, and REST restart reconciliation. It did not prove continuous transport behavior.

A production venue adapter cannot safely infer state from one-shot calls alone. Public depth gaps, private-stream expiration, reconnect races, and events arriving while a REST snapshot is in flight must be explicit and replayable before any order mutation path is introduced.

Node 22 provides a stable browser-compatible `WebSocket`, so this phase can remain dependency-light and preserve the existing runtime boundary.

## Decision

Create a second stacked GC-002 branch that:

- uses the venue's public diff-depth stream and private user-data stream;
- buffers public deltas until a REST depth snapshot establishes an overlap point;
- invalidates and reconnects the public lane on malformed events, update gaps, or `pu` mismatch;
- creates, renews, and closes only the Binance user-data listen-key session endpoint;
- buffers private events while signed REST balances, positions, and open orders are reconciled;
- rotates the private session on expiration, keepalive failure, close, or malformed events;
- records bounded, rotating, credential-free JSONL evidence with deterministic replay;
- keeps every trading mutation endpoint absent.

## Consequences

- Continuous venue truth becomes observable without risking capital.
- Listen-key lifecycle introduces session-control `POST`, `PUT`, and `DELETE`, but no trading mutation authority.
- A reconnect never resumes from elapsed time or assumed continuity; it obtains a new snapshot/reconciliation boundary.
- Evidence I/O is local and bounded. It is not sent to Hermes by default.
- Green tests prove state-machine and replay contracts, not external uptime, account access, or production readiness.

## 2026-08-24 route migration amendment

Binance now partitions USDⓈ-M stream traffic under `/public`, `/market`, and
`/private`; unrouted connections receive only public data. Constructed depth,
regular-market, and user-data sockets therefore use their assigned route. A
credential-free Futures Testnet probe retained under `operations/evidence/GC-002/`
observed live events on the routed public and market endpoints. Private routing
remains source-tested but requires authenticated runtime evidence before
acceptance.
