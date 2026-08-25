# GC-002 Phase K Plan — fail-closed Testnet execution context

## Architecture

```text
authenticated Testnet preflight ───────────────┐
public depth supervisor status ────────────────┤
private reconciled account status ─────────────┼─ deterministic compiler
market mark/trade recorder status ─────────────┤       ↓
explicit clock + freshness policy ─────────────┘  immutable ready|blocked context
                                                     mutation authority = false
                                                     engine binding = false
```

## Work sequence

1. Extend market status with the latest inspected summaries.
2. Correct private reconciliation time and available-balance semantics.
3. Implement the pure execution-context compiler and stable blockers.
4. Prove ready, stale, disconnected, contradictory, and exposed cases.
5. Update ontology, ADR, Rail, and issue evidence after the full gate.

## Safety boundary

- No source file in this phase imports a signer or mutation client.
- No environment variable, credential, network call, CLI, HTTP route, or engine
  selection is added.
- A ready context is data only and cannot place, cancel, or amend an order.
- Missing management capabilities remain explicit and prevent this phase from
  being described as engine parity.
