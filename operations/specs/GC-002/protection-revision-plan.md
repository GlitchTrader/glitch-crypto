# GC-002 Phase L Plan — protected revision and partial reduction

## Architecture

```text
current owned stop + target ── exact GET proof ───────────────┐
optional reduce-only partial ─ submit/query/exact fill ───────┤
                                                               ↓
derived remaining quantity ─ new stop POST → exact GET proof
                               ↓
                             new target POST → exact GET proof
                               ↓
                     old target DELETE/query
                               ↓
                     old stop DELETE/query
                               ↓
                   attributable revision result
```

## Work sequence

1. Freeze request, identity, exact-decimal, result, and state contracts.
2. Add a generic exact reduce-only market operation to the Testnet client.
3. Implement current-pair proof and optional partial fill proof.
4. Implement stop-first replacement and target-before-stop old cleanup.
5. Implement GET-only restart reconciliation.
6. Prove ordering, ambiguity, partial-fill, cleanup, and redaction behavior.
7. Update capability truth, ontology, Rail, and issue evidence.

## Boundary

This phase remains dormant Testnet/loopback source. It adds no environment
loader, route, CLI, engine import, account credential, or production origin.
