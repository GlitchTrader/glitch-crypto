# Tasks: Durable owned-protection binding

**Rail item**: `GC-002` | **Inputs**: `owned-protection-binding-spec.md`, `owned-protection-binding-plan.md`, ADR 0012

Checkboxes decompose this one Rail item. `operations/ledger.json` remains the only current-work state.

## Contract tests

- [x] N001 Add entry, revision, close, restart, conflict, corruption, ready, flat, and mismatch tests in `tests/binance-owned-protection-state.test.ts`.

## Implementation

- [x] N002 Add canonical current-pointer validation in `src/venue/binance-usdm/mutation-contract.ts`.
- [x] N003 Add integrity-checked compare-and-set runtime storage in `src/storage/database.ts`.
- [x] N004 Implement the transition reducer and repository in `src/venue/binance-usdm/owned-protection-state.ts`.
- [x] N005 Implement the non-authorizing native binding compiler in `src/venue/binance-usdm/owned-protection-state.ts`.
- [x] N006 Update ontology, ADR, and execution documentation.

## Verification and evidence

- [x] N007 Run `npm.cmd run check` and record factual output.
- [ ] N008 Update Rail and GitHub evidence, then push direct to `main`.

## Dependencies and stop lines

- Phase M generic current-owned close is accepted at Rail commit `422ce54`.
- Do not use credentials, start an authenticated runtime, submit any venue mutation, bind the engine, deploy, or claim live/profitability acceptance.
