# GC-002 Phase F Specification — authenticated private-stream evidence

## Purpose

Turn the existing open-ended Binance account supervisor into a finite,
fail-closed Futures Testnet evidence gate for authenticated reconciliation and
user-data events, without granting trading mutation authority.

## Functional requirements

### FR-F001 Testnet and preflight gate

Capture MUST reject production REST or stream origins, missing credentials, and
any account state that fails the accepted authenticated Testnet preflight before
creating a listen-key session.

### FR-F002 Finite private capture

Capture MUST run for 5-300 seconds, refuse to overwrite evidence, use the bounded
credential-redacting JSONL sink, stop both stream lanes, and close the listen-key
session.

### FR-F003 Private replay eligibility

Verification MUST require one contiguous session, monotonic recorder timestamps,
supervisor start/stop, private connecting/synchronizing/running/stopped states,
at least one REST reconciliation, a configurable minimum number of user-data
messages, no private error/backoff boundary, and deterministic private-state
replay without stream expiry.

### FR-F004 Sanitized manifest

The content-addressed manifest MUST contain lifecycle/count/replay metadata but
MUST NOT serialize credentials, listen keys, signatures, exact balances,
quantities, position/order payloads, or raw private events.

## Safety invariants

- `mutation_authority` is always `false`.
- The command has listen-key session authority and GET-only account authority,
  but no order, cancel, leverage, margin, or position-mode mutation method.
- Raw authenticated evidence remains local and is not committed by default.
- A preflight-ready account does not prove that private events were delivered.
- Private evidence does not authorize the later Testnet mutation smoke test.

## Acceptance

1. Production origins and missing credentials fail before transport.
2. A synthetic private event buffered across reconciliation replays correctly.
3. Missing lifecycle, reconciliation, user events, or clean continuity rejects
   the evidence.
4. The manifest is content-addressed and contains no raw account values.
5. The full repository gate passes.

## Non-goals

- Generating an account/order event, placing an order, accepting mutation,
  committing private evidence, or claiming production readiness.
