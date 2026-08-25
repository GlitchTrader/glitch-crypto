# Implementation Plan: Venue-exact Binance protected-entry plan

**Rail item**: `GC-002` | **Date**: `2026-08-25` | **Spec**: `operations/specs/GC-002/binance-entry-plan-spec.md`

## Summary

Add a pure compiler that consumes the accepted non-authorizing execution context, operator risk policy, UTC daily state, and requested direction/geometry, then emits either stable blockers or one canonical Binance protected-entry request with conservative risk evidence.

## Source truth inspected

- Constitution, authority, ontology, existing paper RiskEngine/money/policy code, execution context v3, mutation contract, daily-state storage, and current Binance precision/minimum fields.

## Technical context

- **Runtime**: Strict TypeScript.
- **Storage**: Read-only input from existing policy/daily state; no writes in the compiler.
- **Testing**: Node test runner plus `npm.cmd run check`.
- **Constraints**: BTCUSDT, flat entry context, one-way isolated account, integer cents and 1e-8 BTC units, no credential/client/signer/effect.

## Constitution and authority check

- Market direction and geometry remain requested judgment; code checks only hard factual/policy validity.
- Venue context owns executable price, precision, balance, fees, and leverage facts.
- Daily target is not a setup, quota, target price, or loss allowance.
- Output remains non-authorizing and cannot reach transport.

## Design and affected paths

- Add `src/venue/binance-usdm/entry-plan.ts`.
- Add `tests/binance-entry-plan.test.ts`.
- Extend ontology, execution-context documentation, and ADR 0013.

## Acceptance evidence

- Deterministic scaling and blocker tests plus the complete repository gate.

## Promotion and rollback boundary

This accepts only source planning semantics. Runtime wiring, mutation permit, async orchestration, authenticated evidence, production, and profitability remain later gates.
