# Implementation Plan: Durable owned-protection binding

**Rail item**: `GC-002` | **Date**: `2026-08-25` | **Spec**: `operations/specs/GC-002/owned-protection-binding-spec.md`

## Summary

Add an integrity-checked compare-and-set runtime-state row, a pure owned-protection transition reducer, and a non-authorizing compiler that binds the durable pointer to fresh private position truth and exact conditional stop/target evidence.

## Source truth inspected

- Constitution, authority contract, ontology, methodology, Rail, Phase K execution context, private-state replay, protected entry, protection revision, generic close, database restart tests, and official current Binance conditional-order/position contracts.

## Technical context

- **Runtime**: Node.js strict TypeScript, one process and one writer.
- **Storage**: Existing SQLite database with `synchronous=FULL`, canonical JSON, SHA-256, and optimistic version comparison.
- **Testing**: Node test runner plus `npm.cmd run check`.
- **Constraints**: One Testnet account, BTCUSDT, one-way mode, exact decimal identity, no signer/client/credential in retained state or compiled output.

## Constitution and authority check

- Native venue position and exact Algo queries remain factual authority.
- Local state owns only mutation/request identity and restart continuity.
- Ambiguous results remain nonterminal with their complete request.
- The compiler describes readiness but grants no effect or engine authority.

## Design and affected paths

- Add generic integrity-checked CAS runtime state to `src/storage/database.ts`.
- Add transition validation, repository wrapper, and binding compiler to `src/venue/binance-usdm/owned-protection-state.ts`.
- Export current-pointer canonical validation from `src/venue/binance-usdm/mutation-contract.ts`.
- Add focused restart, transition, corruption, and binding tests.
- Extend `operations/ontology.md`, add ADR 0012, and update Binance execution documentation.

## Acceptance evidence

- Exact deterministic tests plus the complete repository gate.
- No external request, credential, socket, or venue mutation is required or accepted by this source slice.

## Promotion and rollback boundary

This accepts only durable source semantics. Remove the new state/compiler and schema table to roll back. Runtime selection, authenticated observation, mutation testing, asynchronous engine binding, production, and profitability remain later gates.
