# ADR 0015 — prove management risk before a revision effect

**Status**: Accepted
**Date**: 2026-08-25
**Rail**: GC-002 management-risk planning

## Decision

Glitch will not execute a Binance protection revision from a bare management request. A fresh, authenticated, GET-only Testnet snapshot and the exact current `OwnedProtectionBinding` must compile a non-authorizing `ProtectionManagementPlan`. A separate short-lived permit must bind the complete plan body hash before orchestration may stage the revision.

The compiler derives partial quantity from a requested percentage, prices a LONG reduction at bid and a SHORT reduction at ask, applies conservative fee and stressed-exit costs, and proves that the resulting native stop protects at least as much equity as the current native stop while respecting the daily floor, daily-loss boundary, open-risk ceiling, tick, step, and remaining-position minimums.

## Why

The revision state machine proves safe transport ordering, but it does not decide whether proposed geometry is financially safe. Mixing those responsibilities would let an otherwise valid stop-first transport deterministically execute unsafe geometry.

## Consequences

- Model output remains a proposal; deterministic code owns final partial quantity and authorization eligibility.
- A stale or contradictory account, position, market, fee, or contract fact blocks before durable staging.
- Target-only changes are possible without weakening downside protection.
- Full close remains a separate risk-reducing path.
- Runtime permit issuance and real Testnet evidence remain explicit later gates.

## Rejected alternatives

### Execute the canonical revision request directly

Rejected because canonical identity and decimal validation do not prove risk safety.

### Let a model choose exact partial quantity

Rejected because quantity precision, minimums, cost, and surviving protection are deterministic venue/risk concerns.

### Treat transport ordering as sufficient protection

Rejected because stop-first replacement can still install economically unsafe geometry if no protected-equity proof precedes it.
