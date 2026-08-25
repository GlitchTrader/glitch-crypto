# Feature Specification: Venue-exact Binance protected-entry plan

**Rail item**: `GC-002`
**Created**: `2026-08-25`
**Status**: Accepted for implementation
**Input**: Consolidated Glitch Crypto build brief and accepted execution-context/ownership gates

## Outcomes and non-goals

- **Outcome**: Deterministic code derives the only venue-valid BTCUSDT protected-entry quantity and risk proof from fresh account/market facts, operator policy, daily state, and requested geometry.
- **Non-goal**: The plan does not authorize or submit an order, select credentials/runtime, invent a setup, or use the daily target as entry geometry.

## User scenarios and independent tests

### User Story 1 - Scale bounded risk with the usable pot (Priority: P1)

The same policy scales conservatively across a 100, 1,000, or 10,000 USDT usable pot while respecting venue quantity steps and minimums.

**Independent test**: Ready contexts at each balance produce deterministic step-aligned quantities whose planned loss never exceeds the configured risk budget.

### User Story 2 - Preserve an earned daily floor (Priority: P1)

No new entry plan may surrender the active protected-equity floor or reach the daily loss boundary.

**Independent test**: A plan that would cross either boundary compiles blocked even when market geometry is otherwise valid.

### User Story 3 - Reject stale or venue-invalid geometry (Priority: P1)

The model owns direction and proposed stop/target, while deterministic code owns freshness, executable price, precision, quantity, cost, margin, and hard policy.

**Independent test**: Stale contexts, wrong-side stop/target, off-tick prices, leverage mismatch, below-minimum notional, and inconsistent daily state compile blocked without a request.

## Requirements

- **FR-001**: The compiler MUST require a fresh `ready` Binance execution context and preserve its `mutation_authority=false` and `engine_binding_authority=false` boundary.
- **FR-002**: LONG sizing MUST use current best ask and SHORT sizing current best bid as the executable reference.
- **FR-003**: Stop and target MUST be on the accepted tick and on the correct side of the executable reference.
- **FR-004**: Quantity MUST be rounded down to a step valid for both operator policy and the venue contract and meet venue/policy minimums.
- **FR-005**: Planned loss MUST include adverse stop distance, estimated round-trip cost, and stressed exit cost and remain within trade/open-risk, available-margin, daily-loss, and active-floor boundaries.
- **FR-006**: The configured venue leverage MUST be accepted by policy; a requested different leverage MUST block because this slice cannot mutate leverage.
- **FR-007**: The daily target MAY be reported but MUST NOT determine stop, target, quantity geometry, or activity.
- **FR-008**: Ready and blocked outputs MUST be deeply immutable, serializable, credential-free, and non-authorizing.

## Edge cases and failure states

- Conservative cents rounding floors wallet/available balances and risk budget, while notional, margin, and planned loss round upward.
- A usable-balance limit caps sizing without changing venue equity.
- A venue quantity step incompatible with the policy step uses their least common multiple.
- Current Phase O supports the accepted single BTCUSDT one-way flat-entry scope only.

## Key entities and ontology changes

- `ProtectedEntryPlan`: non-authorizing exact request plus attributable risk proof and blockers.

## Measurable success criteria

- **SC-001**: Tests prove pot scaling, step/tick validity, deterministic replay, conservative loss, leverage/margin caps, floor/loss rejection, and stale-context rejection.
- **SC-002**: The complete Windows build/test gate passes without credentials or venue mutation.

## Assumptions and open questions

- **Assumption**: BTCUSDT quote prices and the accepted contract tick are cent-exact or coarser; the compiler fails closed otherwise.
- **Question**: None for this slice. Runtime promotion must revalidate the observed contract.
