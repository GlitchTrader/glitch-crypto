# ADR 0014: Stage before every bounded Testnet effect

- **Status**: Accepted for implementation
- **Date**: 2026-08-25
- **Rail**: GC-002

## Context

The source now has proof-bearing entry plans, durable ownership, exact native coordinators, and GET-only reconciliation, but no component enforces their ordering. Calling a coordinator directly could mutate before the complete restart request is durably bound, and a ready non-authorizing context must not itself become permission.

## Decision

Introduce a dormant single-writer orchestrator. Require a fresh ready plan/binding plus a separate one-intent, exact-proof-hash-bound, expiring, quantity-bounded Testnet operator permit. Save staged ownership state through CAS before invoking entry or full-close effects. On interruption, retain pending state and dispatch only the exact GET-only reconcile method. Keep revision/partial effects unsupported until their management-risk plan exists.

## Alternatives rejected

- Treat `ready` as authorization: conflates factual readiness with operator authority.
- Persist after effect: loses exact restart intent during the most important crash window.
- Blind retry after timeout: violates ambiguity and idempotency rules.
- Wire the existing synchronous paper engine directly: mixes simulation state with authenticated async venue truth.

## Consequences

- Later runtime wiring has one explicit place to issue permits and attach real coordinator effects.
- An in-process busy guard plus storage CAS enforce single-writer behavior.
- This source can be fully tested without credentials or external requests.
