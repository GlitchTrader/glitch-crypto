# Feature Specification: Durable owned-protection binding

**Rail item**: `GC-002`
**Created**: `2026-08-25`
**Status**: Accepted for implementation
**Input**: Consolidated Glitch Crypto build brief and accepted Phases K-M

## Outcomes and non-goals

- **Outcome**: After entry, revision, close, disconnect, or restart, deterministic code can recover the exact current protection request and prove whether one fresh native position is bound to the exact active stop and target identities.
- **Non-goal**: This slice does not select credentials, start a Binance runtime, authorize a mutation, bind the trading engine, or claim Testnet/production readiness.

## User scenarios and independent tests

### User Story 1 - Recover ownership after restart (Priority: P1)

The gateway persists current ownership and any nonterminal reconciliation request before a later process must decide what can safely happen next.

**Independent test**: A file-backed database reopened by a new process returns the same integrity-checked current pointer and pending request.

1. **Given** a protected entry or revision result, **When** it is durably recorded and the database restarts, **Then** exact current quantity, geometry, native identities, transition sequence, and pending reconciliation input survive.

### User Story 2 - Fail closed on contradictory venue truth (Priority: P1)

The gateway distinguishes a locally owned identity from current native position and protection facts.

**Independent test**: Fresh coherent private position truth and exact stop/target evidence compile ready, while quantity, direction, symbol, identity, activity, freshness, stream, pending-reconciliation, or integrity mismatches compile blocked.

1. **Given** a persisted current pointer, **When** the venue position or either native protection does not match exactly, **Then** management readiness is blocked without mutation authority.

### User Story 3 - Preserve ambiguity as restartable state (Priority: P1)

Every nonterminal entry, revision, or close result retains the canonical request needed for exact GET-only reconciliation.

**Independent test**: An ambiguous result cannot be replaced by a different request and a matching later reconciled result advances the same state.

1. **Given** a pending transition, **When** another body or identity attempts to advance ownership, **Then** compare-and-set and request-identity checks reject it.

## Requirements

- **FR-001**: The system MUST persist a single versioned Binance USD-M owned-protection state using canonical JSON, SHA-256 integrity, and compare-and-set versioning.
- **FR-002**: The state MUST stage and durably save the full canonical request before entry, revision, or close transport, then retain it through every nonterminal outcome.
- **FR-003**: Only proof-complete result evidence MAY create, replace, or clear the current owned-protection pointer.
- **FR-004**: A binding MUST require a fresh reconciled one-way private stream, exactly one matching nonzero native position, no unowned active ordinary order, and both exact active reduce-only Algo protections.
- **FR-005**: Flat is valid only when venue position truth is flat, the current pointer is null, and no reconciliation is pending.
- **FR-006**: The compiled binding MUST be deeply immutable, serializable, credential-free, and expose `mutation_authority=false` plus `engine_binding_authority=false`.
- **FR-007**: Corrupt durable JSON, a hash mismatch, stale/future state, or a version conflict MUST fail closed.

## Edge cases and failure states

- A reduction may fill before replacement protection is proven; the old pointer remains and the full revision request remains pending.
- A replacement pair may be proven while old cleanup is pending; the new pointer becomes current, but management stays blocked until cleanup reconciliation completes.
- A close may fill while protection cleanup is pending; the pointer and close request remain durable while the venue position is flat.
- Signed native position quantity determines direction; hedge-mode position sides are unsupported.
- Binance Algo orders are proved through the exact conditional-order query identity, not inferred from ordinary open-order snapshots.

## Key entities and ontology changes

- `OwnedProtectionState`: durable single-writer pointer plus restartable pending transition.
- `OwnedProtectionBinding`: immutable comparison of durable ownership identity with fresh native position and exact Algo protection facts.

## Measurable success criteria

- **SC-001**: Deterministic tests prove all three transition families, restart durability, CAS conflict, corruption rejection, exact ready binding, flat binding, and mismatch blockers.
- **SC-002**: The full Windows build and test gate passes with no credentials or external mutation.

## Assumptions and open questions

- **Assumption**: The accepted exact `GET /fapi/v1/algoOrder` proof remains the conditional-protection authority; validate again before any runtime promotion.
- **Question**: None. The constitution, accepted source contracts, and official venue contract determine this slice.
