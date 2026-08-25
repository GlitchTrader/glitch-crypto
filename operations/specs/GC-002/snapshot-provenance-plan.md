# GC-002 Phase J Plan — exact public depth bootstrap provenance

## Design

Use a new evidence version for one new authority rather than changing the
meaning of version 2:

```text
approved public GET
  → receive exact successful response text + request/receive provenance
  → synchronously retain v3 raw-snapshot record (payload remains null)
  → JSON parse and strict depth-snapshot validation
  → retain existing v1 parsed snapshot record
  → load snapshot and buffered exact v2 deltas
```

The verifier pairs records in chronological order and exposes a third,
strongest claim. Replay ignores the raw record and continues to consume the
parsed snapshot, keeping source evidence separate from derived state.

## Affected source

- `stream-common.ts`: optional exact public REST response contract.
- `shadow-client.ts`: approved public raw-response transport.
- `stream-evidence.ts`: version-3 raw depth-snapshot record.
- `public-stream-lane.ts`: retain raw response before parse.
- `stream-replay.ts`: strict version-3 parsing and replay ignore rule.
- `public-evidence.ts` / CLI: pairing, integrity metrics, strongest claim.
- deterministic and observed fixtures, docs, ontology, ADR, and Rail.

## Compatibility and rollback

Version 1 and 2 records are unchanged. A reader that predates Phase J rejects
version 3 explicitly rather than silently interpreting it. Reverting Phase J
removes only exact snapshot support; the prior parsed and exact-frame claims
remain factual.
