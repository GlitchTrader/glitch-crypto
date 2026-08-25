# ADR 0007 — retain exact public depth frames before parsing

**Status**: Accepted
**Date**: 2026-08-25
**Rail item**: GC-002

## Context

The accepted public depth fixture proves snapshot/delta continuity and derived
book replay, but it contains version-1 parsed payloads. Parsed evidence cannot
prove the exact provider frame, socket identity, receive order, or whether a
later parser discarded unknown fields. Rewriting that historical fixture would
invent facts that were not retained.

## Decision

Generalize the existing version-2 public raw-frame envelope to
`public-depth`. The socket callback records the exact decoded frame, SHA-256,
configured authority, connection ID, wall-clock and monotonic receive times,
`E`/`T`/`U`/`u`/`pu` provider identity, and depth inspection version before
strict parsing or order-book application.

The verifier exposes separate claims:

- `accepted_for_public_replay` means the parsed snapshot and delta sequence
  reconstructs a ready, non-crossed book;
- `accepted_for_depth_frame_replay` additionally means every depth message is
  an integrity-checked, connection-attributed version-2 raw frame in strict
  receive order and the session has no error or reconnect boundary.

Current public capture and verification CLI success requires both claims. The
REST snapshot remains parsed evidence; no byte-exact snapshot claim is made.

## Consequences

- Malformed JSON and malformed provider identity remain attributable before
  fail-closed reconnect.
- Historical version-1 fixtures remain readable and accepted for their original
  parsed replay claim, but are explicitly legacy for exact-frame replay.
- Evidence files are larger, while the existing rotation bound remains in
  force.
- This adds no credential, private-state, account, mutation, production, or
  profitability authority.
