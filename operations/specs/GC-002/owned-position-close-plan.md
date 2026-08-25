# GC-002 Phase M Plan — generic owned-position close

## Architecture

```text
current owned stop + target ─ exact GET proof
             ↓
deterministic exact reduce-only market close
             ↓ POST result / exact GET reconciliation
          FILLED proof
             ↓
current target cleanup → current stop cleanup
             ↓
attributable closed | cleanup-pending result
```

## Work sequence

1. Define close request, identity, result, and states.
2. Reuse exact current-pair proof from protection revision.
3. Submit/query one deterministic exact reduce-only close.
4. Preserve close-before-cleanup and target-before-stop ordering.
5. Implement GET-only restart reconstruction.
6. Prove ambiguity, rejection, partial fill, ordering, and redaction.
7. Update capability truth, ontology, Rail, and issue evidence.

## Boundary

This is dormant Testnet/loopback source. No engine import, environment loader,
route, CLI, credential, deployment, or production origin is added.
