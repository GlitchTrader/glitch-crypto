# ADR 0009 — compile a fail-closed execution context before engine binding

**Status**: Accepted
**Date**: 2026-08-25
**Rail**: GC-002 Phase K

## Decision

Glitch Crypto will not substitute the asynchronous Binance protection
coordinator into the synchronous paper venue interface. It will first compile a
fresh, coherent, flat Testnet account-and-market context from separate accepted
truth sources.

The context is immutable data with no credentials, mutation authority, or
engine-binding authority. It exposes exact sizing inputs and explicit
capability gaps. Runtime selection remains absent.

## Why

The paper engine currently derives balance, mark, fees, fills, and management
identities from its local database and synchronous paper venue. Treating those
values as Binance truth would permit sizing against stale or fictional state,
and the Binance coordinator does not yet implement partial reduction or
stop/target amendment. A thin adapter would therefore look integrated while
violating the venue-authority and protected-management contracts.

## Consequences

- Engine work receives one deterministic readiness input instead of querying
  several mutable components ad hoc.
- Staleness, identity disagreement, exposure, and capability absence are
  attributable blockers.
- Private available balance becomes snapshot-scoped and is invalidated when a
  stream update cannot refresh it.
- Phase K cannot trade and does not itself satisfy authenticated or mutation
  acceptance.

## Rejected alternatives

### Wrap the coordinator in the existing `VenueAdapter`

Rejected because the interface is synchronous and assumes paper account,
fill, fee, and management behavior.

### Let the engine query clients directly

Rejected because it would mix transport, state reduction, risk inputs, and
mutation authority inside one control path.

### Treat preflight `ready` as lasting runtime readiness

Rejected because preflight is point-in-time evidence and cannot prove ongoing
stream continuity or current exposure.
