# GC-002 Phase I Plan — replay-grade public depth frames

## Design

Generalize the existing v2 record from one market channel to a public raw-frame
union. Keep channel-specific sequence identity explicit and share only generic
hash, payload, authority, connection, and monotonic-clock verification.

```text
depth socket callback
  → capture connection + wall/monotonic receive clocks
  → decode exact text frame
  → persist v2 raw frame + hash + best-effort provider identity
  → parse strict depth delta
  → buffer/apply or fail into reconnect
```

The public evidence report gains a separate depth-frame claim and metrics. The
existing parsed replay claim remains intact, preventing exact WebSocket evidence
from being confused with exact REST snapshot evidence.

## Affected source

- `stream-evidence.ts`: public raw-frame channel/version union and depth sequence.
- `stream-replay.ts`: strict generalized v2 parsing.
- `raw-frame-evidence.ts`: shared generic integrity verification.
- `market-evidence.ts`: use shared verifier without changing accepted market evidence.
- `public-stream-lane.ts`: exact frame retention before depth parse/application.
- `stream-supervisor.ts`: injectable clocks and connection IDs for deterministic tests.
- `public-evidence.ts` / CLI: separate depth-frame replay gate and metrics.
- deterministic and observed fixtures, docs, ontology, ADR, and Rail.

## Compatibility and rollback

No historical file is changed. Existing market v2 records retain their schema
and semantics. Reverting this phase makes new public-depth v2 files unsupported
instead of silently treating them as legacy.
