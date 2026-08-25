# Implementation Plan: Bounded single-writer Testnet orchestrator

**Rail item**: `GC-002` | **Date**: `2026-08-25` | **Spec**: `operations/specs/GC-002/testnet-orchestrator-spec.md`

## Summary

Add a dormant async coordinator over existing entry/close effect contracts and the durable ownership repository. Validate a per-intent permit and fresh proof object, stage through CAS, invoke one effect, apply the result through the proof-gated reducer, and dispatch pending restart recovery to GET-only reconcile methods.

## Source truth inspected

- Paper TradingEngine/server, execution context, entry plan, ownership reducer/repository/binding, protected-entry coordinator, revision/close coordinator, mutation client, authority contract, and Rail.

## Technical context

- **Runtime**: Strict TypeScript async class.
- **Storage**: Existing integrity-checked CAS ownership state.
- **Testing**: Fake effect port, file/in-memory SQLite, Node test runner, full check.
- **Constraints**: Testnet/BTCUSDT, one in-flight effect, exact UUID/quantity, no credential import, no public route.

## Constitution and authority check

- Operator permit is separate from model intent and non-reusable across intent IDs.
- Plan/binding remain factual prerequisites; the permit is the separate bounded authorization.
- State is staged and saved before effect.
- Unknown outcomes remain pending; recovery queries rather than resubmits.

## Design and affected paths

- Add `src/venue/binance-usdm/testnet-orchestrator.ts`.
- Add `tests/binance-testnet-orchestrator.test.ts`.
- Extend ontology, ADR 0014, and execution documentation.

## Acceptance evidence

- Deterministic fake-effect tests and full repository gate only.

## Promotion and rollback boundary

No runtime selects this class. Credential loading, permit issuance, operator routes, authenticated observation, mutation canary, revision planning, production, and profitability remain later gates.
