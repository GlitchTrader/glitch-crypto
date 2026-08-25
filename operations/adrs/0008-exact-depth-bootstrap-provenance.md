# ADR 0008 — separate exact depth bootstrap from parsed replay state

**Status**: Accepted
**Date**: 2026-08-25
**Rail item**: GC-002

## Context

Version-2 depth messages preserve exact WebSocket frames, but the initial book
still came from a version-1 parsed REST snapshot. Storing parsed levels alone
cannot prove the original HTTP response, unknown provider fields, request
identity, or receive time. Changing the version-1 snapshot record would rewrite
the meaning of historical evidence.

## Decision

Add a version-3 `public-depth/raw_snapshot` record. It contains a null payload
and immutable provenance for the exact successful `/fapi/v1/depth` response:
origin, canonical public query, HTTP status, dual receive clocks, inspection
version, response text, and SHA-256. The public lane writes this record before
JSON parsing, then writes the existing normalized version-1 snapshot.

The verifier pairs the two records in chronological order. It keeps three
claims distinct:

- parsed public replay;
- exact WebSocket depth-frame replay;
- exact depth-session replay, including the REST bootstrap.

Current capture and verify command success requires the third claim. Replay
applies only the normalized snapshot and treats the raw record as source
evidence.

## Consequences

- Unknown snapshot response fields remain available without entering derived
  book state.
- Invalid JSON or snapshot shape is durably attributable before reconnect.
- Historical fixtures retain their original parsed/frame claims and are
  explicitly legacy for exact bootstrap provenance.
- Evidence is larger but remains within the existing rotation bound.
- No credential, account state, mutation, production, or profitability
  authority is added.
