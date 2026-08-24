# Glitch Crypto ontology

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

### TradingIntent

Versioned decision with immutable UUID/body identity. It requests one supported action but contains no venue credential.

### ProtectedTranche

One attributable filled quantity with entry identity and exact native stop/target identities. A later addition is a new tranche, never an implicit average.

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

Lesson:
proposed → testing → confirmed/contradicted → active → revised/retired/expired
```
