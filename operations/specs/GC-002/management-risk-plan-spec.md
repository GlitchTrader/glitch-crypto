# Feature Specification: Protected-position management risk plan

**Rail item**: `GC-002`
**Created**: `2026-08-25`
**Status**: Accepted for implementation
**Inputs**: accepted owned-protection binding, read-only authenticated Testnet snapshot, operator policy, and UTC daily state

## Outcome and non-goals

- **Outcome**: deterministic code derives the only risk-valid stop/target revision and optional partial reduction from fresh venue truth.
- **Non-goal**: this plan does not authorize a mutation, choose a setup, load credentials, select a runtime, weaken native protection, or claim profitability.

## User scenarios and independent tests

### User Story 1 - Lock profit without weakening protection (Priority: P1)

A stop/target revision is ready only when the projected protected equity is no worse than the currently proven native stop and remains above every active floor and daily-loss boundary.

**Independent test**: a tighter stop passes; a looser total protection outcome is blocked before an effect.

### User Story 2 - Take a deterministic partial (Priority: P1)

A requested reduction percentage is converted to an exact venue/policy-aligned quantity. The compiler accounts conservatively for the reduction fill, fees, stressed exit cost, the remaining stop, and minimum remaining position.

**Independent test**: a 50 percent request produces one exact partial and a fully protected venue-valid remainder; dust or off-step outcomes block.

### User Story 3 - Fail closed on stale or contradictory truth (Priority: P1)

The plan requires a fresh ready ownership binding and a fresh authenticated read-only Testnet snapshot whose account, position, market, fee, contract, and account-envelope facts agree.

**Independent test**: stale evidence, production origin, public-only evidence, position mismatch, unsafe account mode, malformed market data, and unowned ordinary orders produce blockers and no request.

## Requirements

- **FR-001**: The compiler MUST require the exact current owned position and native stop/target pair from a fresh ready `OwnedProtectionBinding`.
- **FR-002**: The compiler MUST consume only credential-free retained output from a fresh authenticated GET-only Futures Testnet shadow snapshot and MUST preserve `mutation_authority=false`.
- **FR-003**: Position direction, quantity, entry price, account mode, margin type, leverage, trading permission, symbol, public contract, top of book, mark price, commission, and ordinary open-order truth MUST agree or fail closed.
- **FR-004**: A partial MUST be derived from an integer requested reduction basis-point value and rounded down to the least common venue/policy quantity step. Callers MUST NOT supply the final reduction quantity.
- **FR-005**: The remaining position MUST be positive, step-aligned, and at or above venue quantity and notional minimums.
- **FR-006**: New stop and target prices MUST be positive, tick-aligned, and on their safe sides of the current mark. The canonical revision validator MUST derive identities and exact remaining quantity.
- **FR-007**: Current and projected protected equity MUST include stop PnL and a conservative exit-cost envelope that cannot undercut authenticated taker fees, configured round-trip cost, or stressed exit cost.
- **FR-008**: A partial projection MUST include conservative realized PnL and exit costs at the executable bid for LONG or ask for SHORT.
- **FR-009**: Projected protected equity MUST not be lower than current protected equity, reach the daily-loss boundary, violate the active daily floor, or exceed maximum open risk.
- **FR-010**: The daily objective MAY activate a protected floor when already secured, but MUST NOT choose stop, target, reduction percentage, or trade activity.
- **FR-011**: Ready and blocked outputs MUST be deeply immutable, serializable, non-authorizing, and contain no credentials, signatures, or raw provider payloads.

## Edge cases and failure states

- Wallet and signed PnL round toward negative infinity; notional and costs round upward.
- A target-only revision is valid when downside protection is unchanged.
- A zero-step partial, full-position partial, or remainder below venue minimum blocks; full close uses the separate owned-close path.
- Existing protection remains the truth until the stop-first revision state machine proves its replacement pair.

## Key entity

- `ProtectionManagementPlan`: a non-authorizing canonical revision request plus exact venue/account provenance, risk projection, precision, and blockers.

## Measurable success criteria

- **SC-001**: Tests prove tightening, target-only change, deterministic partial derivation, conservative cost/floor/open-risk behavior, venue precision/minimums, source mismatch rejection, and immutable output.
- **SC-002**: The complete Windows build/test gate passes without credentials or venue mutation.

## Assumptions and open questions

- **Assumption**: the current accepted scope remains one-way isolated BTCUSDT on Binance USD-M Futures Testnet.
- **Question**: none for this source slice. Runtime permit issuance and authenticated mutation evidence remain separate gates.
