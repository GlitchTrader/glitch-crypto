# ADR 0011 — close current owned protection, not original entry geometry

**Status**: Accepted
**Date**: 2026-08-25
**Rail**: GC-002 Phase M

## Decision

Full close will consume the current owned-protection reference and its current
remaining quantity. It will not derive close quantity or cleanup identities
from the original entry after a protection revision.

The current pair is proven first, an exact reduce-only market close is proven
second, and the current target then stop are cleaned up last.

## Why

A partial reduction or geometry replacement changes current quantity and/or
native protection identities. Reusing the original entry contract after that
transition can query canceled protection and request the wrong close quantity.

## Consequences

- One close path works for original and revised positions.
- Stored current ownership becomes an explicit engine prerequisite.
- Reduce-only remains the venue backstop if position truth changed between
  proof and submission.
- Current private-position binding is still required before runtime selection.

## Rejected alternative

Updating the original entry request in place was rejected because it would
rewrite historical intent identity and blur entry evidence with current venue
ownership.
