# Glitch Crypto ontology

## Architectonic knowledge classes

| Class | Repository form | Rule |
|---|---|---|
| Fact | source, official venue contract, or retained evidence | Cite provenance and observation time. |
| Assumption | spec or ADR assumption | Name the validation path; never present it as fact. |
| Decision | ADR | Record alternatives, consequences, and reversibility. |
| Rule | constitution, authority contract, schema, or invariant | Use mandatory language and name the authority. |
| Question | active spec or Wayfinder decision ticket | Resolve it or keep it visible; do not silently choose. |
| Risk | Rail item, spec edge case, or evidence gate | Name likelihood, consequence, mitigation, and stop line when material. |

Authority descends from the constitution and human instruction to official venue
truth, accepted runtime evidence, source contracts and ADRs, tests, and finally
inference. A lower class cannot overwrite a higher-authority fact.

## Distinctions

| Kind | Meaning | Examples |
|---|---|---|
| Raw fact | Direct venue or clock evidence | book delta, fill, balance, native order state |
| Derived state | Deterministic calculation from facts | equity, open risk, protected equity, daily objective |
| Probabilistic evidence | Calibrated estimate with uncertainty | fill probability, target-before-stop probability |
| Decision | Human/Hermes requested course of action | enter long, move stop, reduce, nothing |
| Effect | Attempted or observed native mutation | order submitted, fill received, stop amended |
| Evidence | Durable attribution of fact/decision/effect | packet, intent, receipt, trade, journal event |
| Policy | Human-configured deterministic boundary | usable pot, risk caps, daily lock target |
| Memory | Evidence-linked interpretation | hypothesis, lesson, contradiction, overlay |

These categories never silently substitute for one another.

## Entities

### TradingAccount

Venue-bound account identity with balance and native position/order state. Equity is venue truth plus deterministically valued open exposure.

### VenuePreflight

Sanitized point-in-time proof that a named Testnet account, instrument contract,
mode, leverage, collateral, fee, position, and order envelope meets declared
prerequisites. It reports readiness but owns no mutation authority.

### VenueExecutionContext

Immutable point-in-time compilation of an accepted preflight, continuous public
depth, public market, and reconciled private account state. It exposes exact
risk inputs plus stable blockers, but contains no credential, transport client,
signer, mutation handle, or engine-binding authority. `ready` means its supplied
Testnet observations are coherent and fresh; it does not authorize an effect.

### ProtectedEntryPlan

Immutable non-authorizing compilation of a fresh `VenueExecutionContext`, UTC
daily risk state, operator policy, and requested direction/stop/target into one
exact protected-entry request plus attributable risk evidence. Deterministic
code owns executable-side price, final quantity, venue precision/minimums,
leverage, fees, cost stress, margin, daily loss, and active-floor enforcement.
The daily objective is reported and may activate a floor, but never supplies
trade geometry or a reason to trade.

### ProtectionManagementPlan

Immutable non-authorizing compilation of a fresh `OwnedProtectionBinding`, a
fresh authenticated GET-only Testnet shadow snapshot, UTC daily state,
operator policy, proposed stop/target geometry, and an optional requested
reduction percentage. It derives the final partial quantity, executable-side
price, remaining position, conservative costs, and current/projected protected
equity. `ready` proves the revision does not weaken total native protection and
respects venue precision/minimums, maximum open risk, daily loss, and the active
floor; it is still not a mutation permit.

### TestnetMutationPermit

Operator-issued, one-intent authorization artifact scoped to Testnet, BTCUSDT,
one supported action, the exact plan/binding body hash, maximum quantity, and a
short validity interval. It is neither a venue credential nor model authority;
later operator-token runtime code owns issuance.

### TestnetExecutionOrchestrator

Dormant single-writer coordinator that validates a fresh proof plus permit,
durably stages the complete request before an entry, protection-revision, or full-close effect, and
applies only proof-complete outcomes. Effect interruption leaves pending state;
restart recovery dispatches the exact GET-only reconciliation contract and does
not resubmit. Revision execution requires a `ProtectionManagementPlan`; a bare
canonical revision request is never sufficient.

### UsablePot

A sizing cap:

```text
min(current equity, configured usable balance limit)
```

Null limit means current full equity. It does not change venue-reported equity.

### DailyEpoch

UTC reporting/risk interval with immutable starting equity, high-water equity, derived target equity, and optional active floor.

### RiskPolicy

Versioned operator policy containing daily target, usable limit, leverage, planned-loss, open-risk, daily-loss, cost, precision, and minimum-notional limits.

### MarketPacket

Immutable sanitized point-in-time evidence supplied to cognition. It is not an order and cannot mutate state.

### RawMarketEvent

Immutable provider payload retained before derived features or labels. A strict
inspection may reject its identity or required fields but does not discard
unknown provider extensions from evidence. Replay-grade evidence also binds the
exact raw frame and hash to venue, instrument, channel, socket connection,
exchange time, local wall-clock receive time, monotonic receive time, provider
sequence identity, and the versioned inspection contract. Missing historical
provenance remains explicit and is never reconstructed by inference. For a
depth event, `E`, `T`, `U`, `u`, and `pu` are provider identity. The exact REST
response and its hash/request/receive provenance are an immutable bootstrap
fact; the normalized snapshot applied to the book is a separate derived record
that must prove its pairing to that response.

### TradingIntent

Versioned decision with immutable UUID/body identity. It requests one supported action but contains no venue credential.

### ProtectedTranche

One attributable filled quantity with entry identity and exact native stop/target identities. A later addition is a new tranche, never an implicit average.

### ProtectionRevision

Attributable transition from one exact owned stop/target pair to another. An
optional exact reduce-only fill determines the new quantity. Because the venue
cannot amend an untriggered conditional order, the new stop and target are
proven before the old target and stop are cleaned up. Ambiguity retains the last
proven protection and becomes reconciliation state.

### OwnedProtection

Current exact position-management reference: originating position intent,
remaining quantity, direction, geometry, and active native stop/target
identities. Entry history is immutable; revisions replace this current pointer.
Partial, replacement, and full-close mutations must prove this reference rather
than derive current truth from original entry geometry.

### OwnedProtectionState

Durable single-writer state containing the current `OwnedProtection` pointer,
a monotonic transition sequence, and the complete canonical request for any
nonterminal entry, revision, or close. Canonical JSON, an integrity hash, and
compare-and-set storage preserve restart identity; the state does not replace
venue position or order truth.

### OwnedProtectionBinding

Immutable comparison between `OwnedProtectionState`, fresh reconciled one-way
private position truth, and exact active reduce-only stop/target Algo evidence.
`ready` means the supplied management facts agree. `flat` means no local pointer
and no native exposure. Both remain non-authorizing; any pending, stale,
contradictory, unowned, or identity-ambiguous fact is `blocked`.

### NativeOrder

Venue-owned mutation identity. Entry, stop, target, amendment, reduction, and exit identities are never inferred from price proximity when the venue provides explicit relations.

### IntentReceipt

Durable result of validation, execution, or reconciliation. `ambiguous` is nonterminal.

### TradeOutcome

Attributable closed quantity with prices, fees, PnL, reason, duration, and evidence identity. Only complete attributable outcomes are learning-eligible.

### JournalEvent

Append-only operational or performance observation. Corrections are new linked events, not history rewrites.

### CognitiveLesson

Evidence-linked, condition-bounded, expiring and reversible interpretation. It cannot mutate policy or source.

## Aggregates and invariants

### AccountExecution aggregate

Owns account, positions, native orders, mutation identity, and reconciliation.

Invariants:

- one active execution signer;
- no duplicate mutation for the same UUID/body;
- every filled quantity is protected or explicitly flattening;
- risk-reducing actions remain available when new exposure is blocked.
- stale, disconnected, contradictory, or unreconciled context cannot authorize
  new exposure;

### DailyRisk aggregate

Owns daily start, target, high water, floor, loss boundary, open risk, and protected equity.

Invariants:

- target is derived from starting usable pot;
- target does not determine trade geometry;
- after lock activation, new exposure cannot project protected equity below the floor;
- daily loss boundary cannot be increased by cognition.

### Learning aggregate

Owns episodes, hypotheses, lessons, contradictions, evaluations, and promotion history.

Invariants:

- raw evidence is immutable;
- one outcome cannot activate a lesson;
- operational defects and market lessons remain separate;
- every active influence has version, evidence, metric, expiry, and rollback.

## State transitions

```text
Intent:
received → validated → persisted → submission_started → visibility_pending
         → open_partial → open_protected → reducing → closed
         ↘ rejected / canceled / failed_before_mutation

Unknown venue outcome:
visibility_pending ↔ reconciling → terminal evidence

Protected entry:
entry_visibility_pending → filled_unprotected → stop_visibility_pending
                          → emergency_flatten_pending → closed
                          → open_protected_target_pending → open_protected

Protection revision:
management_plan_ready → current_pair_proven → reduction_visibility_pending → replacement_stop_pending
                    → replacement_target_pending → old_cleanup_pending
                    → revision_protected

Owned-position close:
current_pair_proven → close_visibility_pending → closed_cleanup_pending → closed

Durable ownership:
flat → entry_pending → owned → revision_pending → owned
                              → close_pending → flat

Native binding:
durable_pointer + private_position + exact_stop + exact_target
                                      → ready / blocked

Lesson:
proposed → testing → confirmed/contradicted → active → revised/retired/expired
```
