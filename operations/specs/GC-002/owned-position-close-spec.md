# GC-002 Phase M Specification — generic owned-position close

## Purpose

Close any currently owned protected position—including a position whose
stop/target pair was produced by one or more revisions—without depending on the
original entry quantity or original protection identities.

## Functional requirements

### FR-M001 Current owned reference

The request MUST contain one exact current owned-protection reference: position
intent, symbol, direction, remaining quantity, stop/target geometry, and exact
current stop/target `clientAlgoId` values.

### FR-M002 Current-pair proof

Both current reduce-only Algo orders MUST be queried and proven active with
exact identity, side, type, quantity, and trigger before any close mutation.
Missing or contradictory current protection MUST cause no mutation.

### FR-M003 Deterministic full-close identity

One canonical close intent UUID MUST derive a venue-valid role-specific
ordinary client order ID. The close MUST be an exact-current-quantity
reduce-only market order.

### FR-M004 Query-before-retry ambiguity

Ambiguous close transport MUST query the deterministic close identity once and
MUST NOT blindly resubmit. Rejected, partial, malformed, or unproven close
evidence MUST leave both current protections untouched and remain nonterminal.

### FR-M005 Close before cleanup

The close MUST be proven `FILLED` for the exact current quantity before any
protection cancellation. Cleanup MUST cancel the exact current target before
the exact current stop. Cancellation ambiguity MUST remain attributable and
nonterminal unless cancellation/absence is proven.

### FR-M006 GET-only restart reconciliation

Restart reconciliation MUST query the close and both current protection
identities using GET only. It MUST not retry or infer a mutation.

## State model

```text
owned_protection_not_proven
  ↓ current stop and target exact and active
close_visibility_pending
  ↓ exact reduce-only FILLED close proven
closed_cleanup_pending
  ↓ current target then stop canceled/absent
closed
```

## Acceptance

1. A revised protection reference closes exact current quantity.
2. Close proof precedes both cleanup mutations.
3. Target cleanup precedes stop cleanup.
4. Ambiguous close performs one exact query and no duplicate POST.
5. Rejected/partial/unproven close performs no DELETE.
6. Restart reconciliation is GET-only.
7. Evidence excludes credentials and signatures.
8. The complete repository gate passes.

## Non-goals

Credentials, authenticated execution, account-stream position proof,
engine/API/CLI binding, deployment, production, or profitability claims.
