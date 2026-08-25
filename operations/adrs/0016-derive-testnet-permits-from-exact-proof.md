# ADR 0016 — derive Testnet permits from exact proof

**Status**: Accepted
**Date**: 2026-08-25
**Rail**: GC-002 dormant authority/effect composition

## Decision

A Testnet mutation permit will be minted only by an operator-secret capability and only from one complete fresh ready proof. The issuer derives action, intent, BTCUSDT identity, maximum quantity, and SHA-256 itself. It does not accept those authority-bearing fields from the caller.

The orchestrator effect port will be implemented by a policy-free adapter that delegates entry/reconciliation to the protected-entry coordinator and revision/close/reconciliation to the protection-revision coordinator. Runtime construction remains absent.

## Why

Letting a caller assemble a permit would allow authority fields to drift from the risk proof. Letting the adapter add retry or fallback policy would duplicate the already accepted state-machine semantics and could turn ambiguity into a second mutation.

## Consequences

- Model authorization cannot mint a permit.
- Every permit is attributable to one immutable proof and expires quickly.
- Coordinator behavior remains the single mutation/reconciliation implementation.
- Startup, routes, credentials, and runtime selection remain visibly unimplemented and require later acceptance.

## Rejected alternatives

- Caller-supplied permit fields: rejected because they can contradict the proof.
- Shared model/operator token: rejected because cognition and mutation authority must remain separate.
- Adapter retry policy: rejected because ambiguous outcomes require exact query reconciliation, not blind resubmission.
