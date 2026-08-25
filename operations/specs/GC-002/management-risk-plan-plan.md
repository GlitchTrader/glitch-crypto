# Implementation Plan: Protected-position management risk plan

**Rail item**: `GC-002` | **Spec**: `management-risk-plan-spec.md`

## Technical context

- TypeScript ESM, Node test runner, SQLite ownership repository.
- Inputs are an accepted ownership binding plus a redacted `BinanceUsdmShadowEvidence` GET snapshot.
- Existing canonical revision validation and stop-first state machine remain authoritative for venue identities and transition ordering.

## Constitution checks

- Deterministic execution owns final quantity and every hard risk boundary.
- Cognition may propose geometry and a reduction percentage only.
- No credential loader, endpoint call, runtime selector, permit issuer, or public mutation route is added.
- Source acceptance, authenticated runtime evidence, production readiness, and profitability remain separate claims.

## Implementation sequence

1. Freeze the plan contract and management-risk ontology.
2. Add a pure compiler that validates fresh Testnet account/market/contract truth and derives a canonical revision.
3. Prove precision, partial accounting, protected-equity monotonicity, daily boundaries, and fail-closed source matching.
4. Require the ready plan plus a proof-hash-bound revision permit in the dormant Testnet orchestrator.
5. Run the complete gate and record source-only evidence on GitHub and Rail.

## Stop lines

- Do not load credentials, call Binance, issue a permit, expose a route, select a runtime, deploy, or mutate venue/account state.
- Do not relax the existing stop-first state machine or GET-only restart reconciliation.
