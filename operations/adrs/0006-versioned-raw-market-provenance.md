# ADR 0006 — version raw market provenance without rewriting history

**Status**: Accepted
**Date**: 2026-08-25
**Rail item**: GC-002

## Context

The first retained market fixture preserved parsed provider payloads, recorder
time, sequence, and lifecycle. The consolidated design additionally requires
exact raw frames, per-connection identity, local and monotonic receive clocks,
provider identity, and an integrity hash for event-time replay. Those facts
cannot be reconstructed truthfully for an old capture.

## Decision

New public-market messages use
`glitch.crypto.binance-usdm-stream-evidence.v2`. The record retains the exact
decoded text frame and SHA-256 plus a typed provenance envelope. Existing
depth, private, supervisor, transition, and historical market records remain
version 1.

The verifier exposes two different claims:

- `accepted_for_raw_replay` preserves the historical payload/lifecycle gate;
- `accepted_for_event_replay` additionally requires an all-v2 message set with
  verified raw integrity, payload equivalence, connection attribution, receive
  ordering, and provider identity.

Current capture/verify CLI success uses the stronger claim.

## Consequences

- Historical evidence remains immutable and readable but cannot masquerade as
  replay-grade.
- New evidence is larger because it retains exact frame text alongside the
  parsed payload.
- Rotation continues to bound storage.
- No credential, private state, feature, model, or mutation authority is added.
