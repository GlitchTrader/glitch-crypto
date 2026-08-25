# GC-002 Phase I Specification — replay-grade public depth frames

## Purpose

Extend the accepted exact-frame provenance contract to Binance USDⓈ-M diff-depth
WebSocket messages so future event-time replay can distinguish provider time,
receive time, socket continuity, and raw identity from derived order-book state.
This is credential-free observation only.

## Source facts

- The consolidated build brief requires raw market events to retain venue,
  instrument, channel, connection, exchange and receive clocks, provider
  sequence identity, raw hash, and normalization version.
- The retained public Testnet fixture proves USDⓈ-M depth fields `E`, `T`, `U`,
  `u`, and `pu`, snapshot bootstrap, and deterministic replay, but predates exact
  raw-frame provenance.
- Phase H already accepts the same envelope for aggregate-trade and mark-price
  frames.

Sources:

- consolidated Glitch Crypto build brief, section 13;
- `tests/fixtures/binance-usdm/observed-testnet-public.jsonl`;
- `operations/specs/GC-002/event-provenance-spec.md`;
- https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/Introduction

## Functional requirements

### FR-I001 Shared v2 envelope

Version-2 raw evidence MUST support both `public-market` and `public-depth`
messages while rejecting a channel/inspection-version mismatch. Existing market
records and all version-1 records MUST remain readable.

### FR-I002 Exact depth frame before parse

Every decodable depth WebSocket frame MUST be retained exactly, hashed, and
attributed before JSON parsing, delta validation, buffering, continuity checks,
or order-book application.

### FR-I003 Depth identity

Valid depth provenance MUST agree with the parsed provider event type, symbol,
event time, transaction time, first update ID, final update ID, and previous
final update ID. Missing optional provider fields remain explicit `null`; they
are never inferred from order-book state.

### FR-I004 Socket and receive ordering

Each message MUST bind to the connection ID emitted by its chronological socket
transition. Monotonic receive timestamps MUST strictly increase within the
evidence session, including buffered pre-snapshot messages.

### FR-I005 Fail-closed evidence

Invalid JSON, malformed identity, raw hash mismatch, payload mismatch,
unattributed connection, non-monotonic receive time, or provider-identity
mismatch MUST prevent the depth-frame replay claim. Runtime parse/continuity
failure MUST still enter the existing attributable reconnect lifecycle.

### FR-I006 Separate claims

`accepted_for_public_replay` continues to mean the parsed snapshot/delta session
reconstructs a ready non-crossed order book. A new
`accepted_for_depth_frame_replay` additionally requires all depth messages to be
verified version-2 raw frames. It does not claim that the REST snapshot response
was retained byte-for-byte.

### FR-I007 Current CLI gate

New public capture and verification command success MUST require both public
replay and depth-frame replay acceptance. The historical version-1 fixture MUST
remain readable and public-replay accepted but MUST be explicitly legacy for
depth-frame provenance.

## Safety invariants

- The public-depth lane has no credentials, account state, or mutation method.
- Raw evidence is retained before derived order-book state.
- A gap or identity fault triggers resynchronization; provenance never permits
  best-effort continuation.
- Historical evidence is not rewritten with unobserved facts.
- This sub-gate does not accept the REST snapshot as exact raw evidence, private
  transport, execution, GC-003, or profitability.

## Acceptance

1. Valid pre-snapshot and live deltas produce version-2 exact-frame evidence and
   replay into the same ready order book.
2. Invalid JSON is retained before error/backoff.
3. Hash, payload, connection, monotonic-clock, and depth-identity tampering fail
   the depth-frame replay claim.
4. Reconnects create distinct connection IDs and stale callbacks remain inert.
5. The historical v1 fixture preserves its prior public-replay result but is
   classified as legacy depth evidence.
6. A bounded external Testnet capture passes both claims.
7. The complete repository gate passes.

## Non-goals

- Exact raw REST snapshot bytes, private raw frames, features, labels, cost/fill
  models, candidates, credentials, order mutation, or production promotion.
