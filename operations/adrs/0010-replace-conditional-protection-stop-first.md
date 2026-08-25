# ADR 0010 — replace conditional protection stop-first

**Status**: Accepted
**Date**: 2026-08-25
**Rail**: GC-002 Phase L

## Decision

Glitch will implement Binance USD-M stop/target movement as deterministic
cancel-and-replace. It will prove the new reduce-only stop first, then the new
reduce-only target, before canceling the old target and finally the old stop.

An optional exact reduce-only partial may precede replacement. Old protection
remains active during the reduction and until the replacement pair is proven.

## Why

Binance's current Algo migration contract says modification of untriggered
conditional orders is unsupported. Ordinary `PUT /fapi/v1/order` amendment is
therefore not a valid protection primitive. Canceling old protection first
would introduce an avoidable unprotected interval.

## Consequences

- Overlapping old/new reduce-only orders are temporarily possible and are
  represented explicitly.
- Transport ambiguity increases protective duplication rather than removing the
  last proven stop.
- Exact cleanup becomes a separate attributable state.
- A position-stream reconciliation remains required before runtime engine
  binding, especially if protection triggers during a revision.

## Rejected alternatives

### Amend the Algo order in place

Rejected because the documented venue contract does not support it.

### Cancel old protection before placing replacement

Rejected because disconnect, rejection, or ambiguity could leave native
exposure unprotected.

### Cancel old stop immediately after proving only the new stop

Rejected because target submission can still fail or remain ambiguous; the old
pair remains useful until the complete replacement pair is proven.
