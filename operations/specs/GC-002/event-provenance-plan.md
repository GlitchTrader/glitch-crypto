# GC-002 Phase H Plan — replay-grade raw market provenance

## Design

Add a version-2 stream-evidence record only when the public-market recorder
supplies an exact raw-frame envelope. Existing depth, private, supervisor, and
historical market records remain version 1.

```text
WebSocket callback
  → capture wall and monotonic receive clocks
  → decode exact text frame
  → retain v2 raw frame + SHA-256 + provenance
  → strict identity inspection
  → running counters or attributable error/backoff
```

The market verifier reads both versions. Version 1 can satisfy the historical
raw-replay contract. Only a clean all-v2 message set with verified hashes,
payload equivalence, connection attribution, receive ordering, and provider
identity can satisfy `accepted_for_event_replay`.

## Affected source

- `stream-evidence.ts`: v1/v2 record union and exact raw-frame construction.
- `stream-replay.ts`: strict v2 parsing and backwards-compatible reading.
- `market-stream-recorder.ts`: capture clocks, connection identity, and raw
  frames before inspection.
- `market-evidence.ts`: integrity and provenance verification.
- `market-evidence-cli.ts`: current replay-grade exit gate.
- tests and evidence documentation.

## Compatibility and rollback

No historical artifact is rewritten. Removing this increment restores the
earlier capture format without data migration; version-2 evidence would then be
unsupported rather than misread.
