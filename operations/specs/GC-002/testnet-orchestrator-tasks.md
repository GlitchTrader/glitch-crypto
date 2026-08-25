# Tasks: Bounded single-writer Testnet orchestrator

**Rail item**: `GC-002` | **Inputs**: `testnet-orchestrator-spec.md`, `testnet-orchestrator-plan.md`, ADR 0014

## Contract tests

- [x] P001 Add staging, permit, freshness, concurrency, close, crash, and recovery tests in `tests/binance-testnet-orchestrator.test.ts`.

## Implementation

- [x] P002 Implement the dormant orchestrator and effect port in `src/venue/binance-usdm/testnet-orchestrator.ts`.
- [x] P003 Update ontology, ADR, and execution documentation.

## Verification and evidence

- [x] P004 Run `npm.cmd run check` and record factual output.
- [x] P005 Update Rail and GitHub evidence, then push direct to `main`.

## Dependencies and stop lines

- Protected-entry plan and durable ownership state/binding are accepted.
- Do not add runtime selection, credential loading, public mutation routes, real effects, revision/partial execution, deployment, or live/profitability claims.
