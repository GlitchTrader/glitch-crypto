# GC-002 Phase H Specification — replay-grade raw market provenance

## Purpose

Make every newly captured Binance USDⓈ-M market frame independently
attributable and integrity-checkable before GC-003 derives features, labels, or
execution models. This is a read-only evidence increment and grants no mutation
authority.

## Source facts

- The consolidated build brief requires venue, instrument, channel, connection
  identity, exchange time, local receive time, monotonic receive time,
  provider sequence identity, raw payload hash, and normalization version on
  raw market events.
- The retained 2026-08-24 fixture proves the observed provider payload and
  lifecycle but predates those provenance fields.
- Current Binance aggregate-trade payloads identify event time and aggregate,
  first, and last trade IDs; mark-price payloads identify event time.

Sources:

- consolidated Glitch Crypto build brief, section 13;
- `operations/evidence/GC-002/binance-mainnet-market-2026-08-24.jsonl`;
- https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/Introduction

## Functional requirements

### FR-H001 Exact raw frame

Every newly received decodable market WebSocket frame MUST be retained exactly
as received before strict event inspection. Its SHA-256 MUST be stored and
recomputable from the retained frame.

### FR-H002 Provenance envelope

Each new market-message record MUST carry:

- venue `BINANCE_USDM`;
- canonical instrument;
- evidence channel;
- unique socket connection ID;
- local wall-clock receive timestamp;
- monotonic receive timestamp;
- provider exchange timestamp when present;
- provider sequence identity when present;
- the raw-frame SHA-256;
- the strict inspection/normalization contract version.

### FR-H003 Record before inspect

A frame that is valid text but invalid JSON, has the wrong identity, or fails a
required-field check MUST still be retained before an error and reconnect
boundary is recorded. Unsupported non-text WebSocket data MAY be represented by
the attributable error because no exact text frame exists.

### FR-H004 Integrity verification

Verification MUST recompute every raw-frame hash, reparse the retained frame,
prove that its unwrapped provider payload equals the retained payload, verify
provenance identity against the strict event summary, and prove monotonic
receive ordering.

### FR-H005 Explicit legacy boundary

Version-1 market fixtures MUST remain readable and retain their earlier
`accepted_for_raw_replay` result. They MUST NOT be labeled replay-grade under
this phase because the missing receive-time and raw-frame facts cannot be
reconstructed after capture.

### FR-H006 Current CLI gate

New `capture` and `verify` command success MUST require replay-grade event
evidence. A legacy fixture remains inspectable but exits nonzero under the
current replay-grade gate.

## Safety invariants

- Raw-frame capture contains public market data only and never credentials,
  account state, order authority, or listen keys.
- The sink rejects a raw frame containing any configured forbidden credential;
  it does not silently rewrite the frame and call the result raw.
- A hash, timestamp, or connection ID is evidence, not a setup or trading edge.
- Historical evidence is never retrofitted with facts that were not observed.
- GC-003 remains blocked until its Rail dependency is actually accepted.

## Acceptance

1. A valid frame produces a version-2 record with exact bytes, stable SHA-256,
   complete provenance, and matching provider identity.
2. Invalid JSON is retained before the attributable error/backoff transition.
3. Hash, payload, timestamp, connection, or identity tampering fails the
   replay-grade verifier.
4. Multiple socket epochs have distinct connection IDs.
5. The historical version-1 fixture remains readable, raw-replay accepted, and
   explicitly not replay-grade.
6. The complete repository gate passes.

## Non-goals

- Feature engineering, model training, labels, simulated fills, candidate
  generation, private account evidence, order mutation, or profitability.
