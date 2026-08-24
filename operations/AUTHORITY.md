# Authority contract

## Roles

```text
Human operator = configures scope, objectives, credentials, promotion, and emergency controls
Hermes         = probabilistic market and position-management operator
Numerical layer= calibrated fill, path, cost, slippage, and uncertainty evidence
Glitch Crypto  = deterministic identity, policy, execution, protection, recovery, and evidence
Venue          = native account, order, fill, position, margin, and protection truth
Builder        = changes and verifies source; never participates in the trading loop
```

## Hermes owns

- whether current evidence supports long, short, management, or no trade;
- competing hypotheses, current setup, next transition, objective, and invalidation;
- whether imperfect evidence is sufficient;
- requested risk below the configured ceiling;
- supported stop, target, partial, hold, and exit judgment;
- evidence-linked review and hypothesis proposals.

Hermes does not own final quantity, credentials, native identity, order mutation, policy mutation, or factual claims about execution.

## Glitch owns

- authenticated venue connectivity and exact account/instrument binding;
- input schema, precision, minimum notional, leverage, margin, fee, and stop-defined sizing;
- hard configured risk and protected-equity boundaries;
- UUID/body-hash identity and evidence-before-mutation persistence;
- exact native protection ownership;
- reduction, flatten, reconciliation, restart recovery, receipts, trades, and journal;
- truthful degradation when a fact cannot be proven.

## Permitted rejection

Glitch may reject:

- malformed or conflicting identity;
- unsupported action or capability;
- wrong account, instrument, position, or tranche;
- venue-invalid quantity/price geometry;
- missing or unprovable native protection;
- stale, disconnected, contradictory, or unreconciled venue state;
- planned loss, open risk, daily loss, margin, or active floor violation;
- duplicate mutation ambiguity;
- a stopped or disabled runtime.

Every rejection is attributable evidence available to learning.

## Forbidden hidden strategy

Glitch must not encode:

- a directional thesis;
- a fixed setup or indicator checklist;
- a trade quota or minimum activity rate;
- a fixed take-profit derived from the daily target;
- a rule that incomplete optional evidence automatically forbids thought;
- a martingale, grid, revenge, or loss-recovery schedule;
- a confidence threshold masquerading as calibrated probability;
- automatic production promotion from a winning sample.

## Operator controls

Start, stop, flatten, mode, usable-pot limit, and risk policy require the separate operator token. The model token can read sanitized state and submit strict trading intents but cannot change operator policy.
