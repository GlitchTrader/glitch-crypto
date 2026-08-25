# GC-002 Phase D Specification — Binance USD-M protected mutation contract

**Rail item**: `GC-002`
**Created**: 2026-08-25
**Status**: Active
**Input**: GitHub issue #5 and the consolidated build brief

## Outcomes and non-goals

- **Outcome**: Glitch can construct, submit, query, and reconcile one Binance
  USD-M Testnet market entry plus exact native stop and target identities without
  turning transport uncertainty into duplicate exposure.
- **Outcome**: Missing or unprovable stop protection enters an explicit
  reduce-only emergency-close lifecycle.
- **Non-goal**: Production URL access, real-capital arming, operator integration,
  authenticated runtime acceptance, or a profitability claim.

## Official contract facts

Observed from the official Binance USD-M documentation on 2026-08-24:

- Testnet REST uses `https://demo-fapi.binance.com`.
- Ordinary orders use signed `POST /fapi/v1/order`; exact lookup uses signed
  `GET /fapi/v1/order` with `origClientOrderId`.
- Conditional TP/SL orders use signed `POST /fapi/v1/algoOrder`; exact lookup
  uses signed `GET /fapi/v1/algoOrder` with `clientAlgoId`.
- `newClientOrderId` and `clientAlgoId` accept 1-36 characters matching the
  venue-declared identifier pattern.
- One-way reduce-only conditional orders may carry exact quantity, trigger price,
  `workingType`, `priceProtect`, and deterministic client identity.
- HTTP 408, network loss, and Binance's execution-unknown 503 variant cannot prove
  mutation failure. Exact query or user-stream evidence must resolve them before
  any retry.

Sources:

- https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/general-info
- https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade

## Requirements

- **FR-001**: The mutation client MUST reject every non-Testnet, non-loopback base URL.
- **FR-002**: No CLI, HTTP route, engine binding, or production configuration MAY expose this phase.
- **FR-003**: Entry, stop, target, and emergency-close client IDs MUST derive deterministically from the immutable intent UUID.
- **FR-004**: Signed transport MUST record sanitized evidence before every mutation request.
- **FR-005**: Network failure, abort, HTTP 408, and execution-unknown HTTP 503 MUST return a nonterminal ambiguous result.
- **FR-006**: Ambiguous entry MUST be queried by exact client ID and MUST NOT be resubmitted from elapsed time or absence in one query.
- **FR-007**: Exact executed entry quantity MUST be protected by a reduce-only `STOP_MARKET` Algo order before target submission.
- **FR-008**: Stop ownership MUST be queried and proven from native identity, side, quantity, trigger, reduce-only state, and active status.
- **FR-009**: Unprovable stop ownership MUST submit one deterministic reduce-only market emergency close and return a nonterminal state until its fill is proven.
- **FR-010**: Target failure MUST leave a proven stop in place and report `open_protected_target_pending`; it MUST NOT mislabel the position unprotected.
- **FR-011**: Retained evidence and errors MUST exclude API key, secret, signature, and signed URL/body.
- **FR-012**: Tests MUST prove stop-before-target ordering, query-before-retry, no duplicate mutation, emergency close, restart-compatible identities, and production URL rejection.

## State contract

```text
entry_submission
  -> entry_visibility_pending
  -> rejected_before_exposure
  -> filled_unprotected
       -> stop_visibility_pending
       -> emergency_flatten_pending
       -> emergency_flatten_confirmed
       -> open_protected_target_pending
       -> open_protected
```

No state in this phase means production-accepted.

## Edge cases

- A successful HTTP response with zero executed quantity is still visibility-pending.
- A not-found response immediately after ambiguity does not prove the mutation never existed.
- A stop that exists with the wrong side, quantity, trigger, client ID, or
  reduce-only state is not owned protection.
- An emergency-close timeout remains nonterminal and blocks new exposure.
- A target may be absent while the position remains stop-protected.

## Measurable success criteria

- **SC-001**: Every test scenario emits at most one POST per deterministic client ID.
- **SC-002**: Target POST is impossible before native stop proof.
- **SC-003**: All transport evidence remains credential- and signature-free.
- **SC-004**: The full strict TypeScript and deterministic test gate passes.
