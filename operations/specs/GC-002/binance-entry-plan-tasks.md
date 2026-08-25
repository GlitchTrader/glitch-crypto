# Tasks: Venue-exact Binance protected-entry plan

**Rail item**: `GC-002` | **Inputs**: `binance-entry-plan-spec.md`, `binance-entry-plan-plan.md`, ADR 0013

## Contract tests

- [x] O001 Add scaling, precision, margin, floor/loss, leverage, freshness, and determinism tests in `tests/binance-entry-plan.test.ts`.

## Implementation

- [x] O002 Implement the pure non-authorizing compiler in `src/venue/binance-usdm/entry-plan.ts`.
- [x] O003 Update ontology, ADR, and execution documentation.

## Verification and evidence

- [x] O004 Run `npm.cmd run check` and record factual output.
- [ ] O005 Update Rail and GitHub evidence, then push direct to `main`.

## Dependencies and stop lines

- Execution context v3 and durable ownership binding are accepted.
- Do not select credentials/runtime, submit a venue mutation, bind the engine, deploy, or claim live/profitability acceptance.
