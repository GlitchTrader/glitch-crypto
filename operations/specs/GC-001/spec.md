# GC-001 Specification — Protected daily-lock control plane

## Purpose

Deliver the first independently useful Glitch Crypto vertical slice: a durable paper-venue gateway through which a human or Hermes can configure a usable pot and daily protected-profit objective, start/stop cognition, flatten exposure, submit strict protected intents, and inspect attributable performance evidence.

## Context

The broader system will combine market data, numerical probability models, Hermes cognition, and direct venue adapters. None of those layers can be trusted until the authority, identity, risk, protection, recovery, and evidence contracts are executable.

## User stories

1. As the operator, I can set a 0.5% daily lock and see the dollar objective scale with a $100, $1,000, or $10,000 usable pot.
2. As the operator, I can cap usable capital without altering the venue's true balance.
3. As the operator, I can start, stop, and flatten through a separate control credential.
4. As Hermes, I can read a sanitized packet and submit a strict intent without seeing credentials or selecting an unchecked quantity.
5. As the risk system, I can reject exposure that violates stop-defined loss, open risk, daily loss, margin, precision, or an active profit floor.
6. As the execution system, I can prove exact entry/stop/target ownership, preserve protection after a partial, and replay duplicate intent truth after restart.
7. As the reviewer, I can inspect PnL, trades, and an append-only journal.

## Functional requirements

### Policy

- Default daily lock: 0.5%.
- Null usable limit means current full equity.
- Initial maximum leverage: 3x.
- Initial planned-loss, open-risk, daily-loss, cost, quantity-step, and minimum-notional limits are explicit and editable only through operator control.
- Policy changes are journaled.

### Control

- Fresh runtime is stopped and shadow-safe.
- Start cannot operate in disabled mode.
- Stop prevents new entries but does not imply native order cancellation.
- Flatten stops the runtime and closes all paper positions.
- Model token cannot invoke controls.

### Intent

- Schema: `glitch.crypto.intent.v1`.
- UUID and canonical body hash are durable.
- Same UUID/body returns stored receipt.
- Same UUID/different body returns conflict.
- Supported actions: enter long/short, hold, nothing, move stop, move target, reduce, exit.
- Quantity is gateway-derived for entry.

### Risk and sizing

- Structural stop must be on the protective side.
- Target must be on the profit side.
- Planned loss includes stop distance plus cost reserve.
- Quantity is rounded down to venue step and satisfies minimum notional.
- Margin and open-risk capacity are checked.
- Active daily floor and daily loss boundary are checked before exposure.

### Protection and lifecycle

- Paper entry creates exact entry, stop, and target IDs.
- Entry terminal state is `open_protected` only after protection confirmation.
- Partial reduction creates a completed outcome and replacement protection IDs for the survivor.
- Mark updates trigger native-equivalent stop/target execution.
- Hard floor/loss breach flattens and stops.

### Evidence

- SQLite uses WAL and FULL sync.
- Intents, receipts, positions, trades, daily state, policy, and journal survive restart.
- Health, state, packet, policy, performance, trades, and journal are queryable.

## Non-goals

- Real venue mutation.
- Profitability claim.
- Numerical model training.
- Multi-instrument or multi-account execution.
- Public web dashboard.
- Autonomous prompt/model promotion.

## Acceptance criteria

The acceptance criteria in issue #2 are authoritative and must be represented by deterministic tests or explicit source evidence.

## Risks

- Paper execution cannot prove real venue semantics.
- Node's SQLite API is experimental in Node 22; the storage boundary must remain replaceable.
- A daily objective may bias cognition if repeated in prompts; the profile must describe it as portfolio context only.

## Open questions

The first live venue, operating host, and production model route remain Wayfinder questions and do not block GC-001.
