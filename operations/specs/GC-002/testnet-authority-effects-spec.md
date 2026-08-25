# Feature Specification: Dormant Testnet authority and effect composition

**Rail item**: `GC-002`
**Created**: `2026-08-25`
**Status**: Accepted for implementation
**Inputs**: accepted entry/management/binding proofs, mutation permit contract, and existing Binance coordinators

## Outcome and non-goals

- **Outcome**: one operator-only source contract derives a short-lived permit from an exact ready proof, and one dormant adapter composes the accepted entry/revision/close coordinators behind the orchestrator effect port.
- **Non-goal**: this slice does not expose an API/CLI route, read environment credentials, instantiate a mutation client, select a runtime, issue a real permit, call Binance, deploy, or authorize capital.

## Requirements

- **FR-001**: Permit issuance MUST require the exact configured operator bearer secret; model or missing authorization MUST fail without returning or logging either secret.
- **FR-002**: The issuer MUST derive action, intent, symbol, maximum quantity, and proof SHA-256 from a fresh ready protected-entry plan, protection-management plan, or owned-position binding. Callers MUST NOT provide those authority fields independently.
- **FR-003**: The issuer MUST support only Futures Testnet BTCUSDT and the accepted `protected_entry`, `protection_revision`, and `owned_position_close` actions.
- **FR-004**: Permit IDs MUST be canonical UUIDs and validity MUST be positive and no more than five minutes; default validity is thirty seconds.
- **FR-005**: A close intent MUST be canonical and bound to the exact current owned protection proof.
- **FR-006**: The effect adapter MUST delegate every orchestration operation to the exact accepted coordinator method, including GET-only restart reconciliation, without adding retries, fallback, caching, or inference.
- **FR-007**: Neither contract may import configuration, environment state, HTTP routing, a signer, or a venue client constructor.

## Acceptance

1. Operator authorization produces the exact proof-derived permit; model/missing/wrong authority rejects.
2. Stale, blocked, malformed, wrong-symbol, or wrong-contract proof rejects before issuance.
3. Invalid lifetime and invalid generated UUID reject.
4. Entry, revision, close, and all three reconciliation calls delegate once to their exact ports.
5. The complete repository gate passes with no credentials or network effects.

## Stop lines

- No route, CLI command, runtime selection, environment credential read, mutation-client construction, deployment, live/Testnet venue call, or capital authorization.
