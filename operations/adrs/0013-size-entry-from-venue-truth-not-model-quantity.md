# ADR 0013: Size Binance entry from venue truth, never model quantity

- **Status**: Accepted for implementation
- **Date**: 2026-08-25
- **Rail**: GC-002

## Context

The existing paper engine owns quantity, but its account and integer fixtures are not authenticated venue truth. The Binance mutation contract accepts an exact quantity and therefore needs a deterministic bridge from fresh balances, executable price, precision, fees, leverage, daily state, and operator risk policy before any async adapter can safely use it.

## Decision

Compile a `ProtectedEntryPlan` from a fresh accepted execution context plus operator policy and daily state. Hermes/model input may request direction, stop, target, and risk below the ceiling, but never final quantity. Use best ask for LONG, best bid for SHORT, conservative rounding, both venue and policy steps/minimums, configured leverage, cost buffers, margin, daily loss, and active floor. The result remains non-authorizing.

## Alternatives rejected

- Accept model quantity: violates deterministic execution ownership.
- Reuse the paper account/database as live truth: conflates simulation and authenticated venue state.
- Size from mark alone: ignores the currently executable side of the spread.
- Derive target from the daily objective: turns portfolio policy into hidden strategy geometry.

## Consequences

- The later async orchestrator can accept only a proof-bearing canonical request.
- Small pots may correctly produce no venue-valid trade.
- Account leverage changes remain a separate explicitly authorized mutation capability.
