# GC-002 Phase L Specification — protected revision and partial reduction

## Purpose

Add deterministic Binance USD-M Testnet source contracts for moving protected
position geometry and taking a partial while preserving native reduce-only
protection throughout every provable transition.

Binance states that untriggered conditional Algo orders cannot be modified.
Glitch therefore uses stop-first cancel-and-replace; it does not call the
ordinary-order amend endpoint for conditional protection.

Source:

- Binance USD-M Futures change log, conditional-order Algo migration:
  https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/Change-Log

## Functional requirements

### FR-L001 Explicit current ownership

A revision request MUST identify the current symbol, direction, remaining
quantity, stop/target geometry, and exact current stop/target `clientAlgoId`
values. Both current orders MUST be queried and proven active with exact
identity, side, type, quantity, trigger, and reduce-only truth before mutation.

### FR-L002 Deterministic revision identity

One canonical revision UUID MUST derive separate venue-valid identities for the
optional reduce-only partial, replacement stop, and replacement target. Replays
of the same revision derive the same identities; roles never share an identity.

### FR-L003 Exact decimal reduction

An optional reduction MUST be positive and strictly smaller than current
quantity. Remaining quantity MUST be derived by exact decimal subtraction, not
binary floating-point arithmetic or a caller-provided claim.

### FR-L004 Query-before-retry partial

A partial MUST use an exact-quantity reduce-only market order. Ambiguous
transport MUST query the deterministic ordinary client identity once and MUST
NOT resubmit blindly. Rejected, partial, malformed, or unproven fill evidence
MUST stop the revision while current protection remains untouched.

### FR-L005 Stop-first replacement

After an optional reduction is proven, the replacement reduce-only stop MUST be
submitted and proven active for the exact remaining quantity before a
replacement target is submitted. Failure or ambiguity MUST retain the old
protection pair and expose nonterminal reconciliation state.

### FR-L006 Target proof before cleanup

The old protection pair MUST NOT be canceled until both replacement stop and
replacement target are proven active. Cleanup MUST cancel the old target before
the old stop. Cancellation ambiguity MUST be queried by exact `clientAlgoId` and
remain pending unless canceled/absent state is proven.

### FR-L007 GET-only restart reconciliation

Restart reconciliation MUST reconstruct reduction, replacement stop/target,
and old cleanup state using GET only. It MUST never infer position quantity from
requested quantity or retry a mutation.

### FR-L008 Attributable result

Every result MUST retain current and next geometry, derived identities,
reduction evidence, replacement evidence, cleanup dispositions, stable state,
and stable reason. It MUST not contain credentials or signatures.

## State model

```text
current_protection_not_proven
  ↓ both old orders exact and active
reduction_visibility_pending / reduction_rejected
  ↓ optional exact reduce-only fill proven
replacement_stop_pending
  ↓ new stop exact and active
replacement_target_pending
  ↓ new target exact and active
revision_protected_cleanup_pending
  ↓ old target then old stop canceled/absent
revision_protected
```

## Safety invariants

- No reduction occurs unless the current stop and target are proven.
- The old stop remains active until the new stop and target are both proven.
- Every ordinary and Algo mutation is evidence-before-transport.
- All conditional protection is reduce-only, so overlapping old/new protection
  cannot create reverse exposure.
- Unknown visibility is nonterminal and blocks further management mutation.
- Reconciliation is observation only.

## Acceptance

1. Pure geometry replacement proves new stop then target before old cleanup.
2. Partial reduction proves exact fill and exact remaining quantity before
   replacement.
3. Ambiguous reduction is queried once and never duplicated.
4. Rejected/partial/unproven reduction leaves old protection untouched.
5. Missing new stop prevents target submission and every old cancellation.
6. Missing new target prevents every old cancellation while new/old stops stay.
7. Cleanup occurs target-before-stop only after the new pair is proven.
8. Restart reconciliation is GET-only and reconstructs terminal/pending state.
9. The complete repository gate passes.

## Non-goals

Credentials, authenticated execution, position-stream binding, engine/API/CLI
integration, venue selection, production, direct conditional-order amendment,
mainnet capital, or profitability claims.
