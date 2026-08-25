# GC-002 Phase G Plan — protected-position close and cleanup

## Sequence

```text
prove currently protected entry
        ↓
one deterministic reduce-only market close
        ↓ exact fill proof
cancel exact target identity
cancel exact stop identity
        ↓ direct or exact-query cancellation proof
closed / closed_protection_cleanup_pending
```

Closing while protection remains active prevents an avoidable unprotected
interval. Once close is proven, residual reduce-only conditionals cannot create
opposite exposure, but they still must be canceled and reconciled before cleanup
is accepted.

## Affected source

- `mutation-client.ts`: signed DELETE classification and exact Algo cancel.
- `protection-coordinator.ts`: close, cleanup, and GET-only reconciliation state.
- `binance-protection-coordinator.test.ts`: ordering, ambiguity, restart, and evidence.
- mutation spec/ADR/docs: expanded source contract and promotion boundary.

## Rollback

The change remains unreachable from CLI, HTTP, engine, and configuration. It can
be reverted without data migration or runtime impact.
