# GC-002 Phase A Plan

## Architecture

```text
Binance public/signed read-only REST
        ↓ exact allowlist + HMAC + clock offset
sanitized shadow evidence
        ├── exchange contract parser
        ├── depth snapshot/delta reducer
        └── private account/order reducer + REST reconciliation
        ↓
CLI output / replay fixtures / future observation service
```

## Work sequence

1. Freeze the venue decision and phase boundary.
2. Implement deterministic query encoding, HMAC signing, and recursive redaction.
3. Parse `exchangeInfo` into a fail-closed instrument contract.
4. Implement sequence-correct local depth state.
5. Implement idempotent private event state and REST reconciliation.
6. Implement a strict GET-only shadow client with injected clock/fetch for tests.
7. Add a one-shot CLI and environment contract.
8. Add deterministic tests and run the full GC-001 suite.
9. Publish as a stacked draft PR over `architect/gc-001-foundation`.
10. Gather authenticated runtime evidence before specifying mutation.

## Explicit non-goals

- No WebSocket connection supervisor in phase A.
- No user-data listen-key lifecycle in phase A.
- No order placement, cancellation, amendment, leverage, margin-mode, or position-mode mutation.
- No production arming.
- No claim that Binance is the final production venue.
