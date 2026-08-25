# Feature Specification: Bounded single-writer Testnet orchestrator

**Rail item**: `GC-002`
**Created**: `2026-08-25`
**Status**: Accepted for implementation
**Input**: Accepted protected-entry plan and durable ownership state/binding

## Outcomes and non-goals

- **Outcome**: One dormant async orchestrator can execute a proof-bearing Testnet protected entry or risk-reducing full close while durably preserving intent before transport and recovering pending work with GET-only reconciliation.
- **Non-goal**: This slice does not expose an HTTP/CLI route, load credentials, select the runtime, issue permits, execute revisions/partials, use capital, or claim mutation/live acceptance.

## User scenarios and independent tests

### User Story 1 - Persist before effect (Priority: P1)

An approved exact request is committed as pending before the first effect method can run.

**Independent test**: The fake effect observes the persisted pending request, and an effect failure leaves it restartable.

### User Story 2 - Recover without resubmission (Priority: P1)

After a process interruption, the next orchestrator queries exact deterministic identities and never blindly resubmits.

**Independent test**: Recovery calls only the matching reconcile method and advances durable state from its proof result.

### User Story 3 - Require fresh bounded operator authority (Priority: P1)

No plan or binding can reach an effect without a matching one-intent Testnet permit.

**Independent test**: Expired, future, wrong-action, wrong-intent, wrong-symbol, over-quantity, stale-plan, stale-binding, and concurrent requests fail before effects.

## Requirements

- **FR-001**: Entry MUST accept only a fresh ready `ProtectedEntryPlan` and a matching `protected_entry` permit.
- **FR-002**: Full close MUST accept only a fresh ready `OwnedProtectionBinding` and a matching `owned_position_close` permit.
- **FR-003**: A permit MUST be Testnet/BTCUSDT scoped, one-intent, action-specific, bound to the exact plan/binding SHA-256, time-bounded, and quantity-bounded.
- **FR-004**: The orchestrator MUST save staged state through compare-and-set before invoking any effect.
- **FR-005**: An effect error MUST leave the staged request nonterminal for restart reconciliation.
- **FR-006**: Recovery MUST invoke only GET-contract reconcile methods and MUST NOT require or manufacture a mutation permit.
- **FR-007**: One orchestrator instance MUST reject overlapping operations; storage CAS remains the cross-instance writer guard.
- **FR-008**: Revision/partial execution MUST remain unsupported until a separate management-risk plan is accepted.

## Edge cases and failure states

- A state/body changed after a binding compiled is rejected by body-hash comparison.
- A permit is not a credential and cannot be issued by the model-facing route; later operator runtime wiring owns issuance.
- Successful effect followed by storage conflict remains pending/ambiguous and requires factual reconciliation.

## Key entities and ontology changes

- `TestnetMutationPermit`: one-intent bounded operator authorization artifact.
- `TestnetExecutionOrchestrator`: single-writer state/effect/reconciliation coordinator.

## Measurable success criteria

- **SC-001**: Tests prove staging order, success, crash/restart recovery, permit/freshness boundaries, concurrency rejection, close, and GET-only recovery dispatch.
- **SC-002**: Full repository gate passes with fake effects only and no external transport.

## Assumptions and open questions

- **Assumption**: Later operator-token code issues permits; constructing the data shape alone is not an authorization boundary.
- **Question**: None for the dormant source slice.
