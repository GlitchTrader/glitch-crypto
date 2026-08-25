# GC-002 Phase G Specification — protected-position close and cleanup

## Purpose

Complete the deterministic Binance USDⓈ-M lifecycle by proving a reduce-only
position close before removing exact native stop and target orders. This is a
dormant source contract, not runtime or mutation authorization.

## Official contract facts

Observed from the official Binance USDⓈ-M trade API on 2026-08-25:

- exact conditional-order cancellation uses signed
  `DELETE /fapi/v1/algoOrder` with `clientAlgoId`;
- a successful response identifies the canceled `clientAlgoId` and code `200`;
- exact Algo query reports `algoStatus`, including `NEW` and `CANCELED`;
- network loss, HTTP 408, and execution-unknown HTTP 503 remain ambiguous for
  mutation requests.

Source:

- https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade

## Functional requirements

### FR-G001 Close before cleanup

The coordinator MUST submit one deterministic reduce-only market close for the
exact proven entry quantity while native protection remains active. It MUST NOT
cancel stop or target before the close fill is proven from direct or exact-query
evidence.

### FR-G002 Exact cleanup identity

After close proof, cleanup MUST address only the deterministic stop and target
`clientAlgoId` values derived from the immutable intent UUID. It MUST NOT use a
symbol-wide cancel-all endpoint.

### FR-G003 Ambiguous close

An ambiguous or unprovable close MUST return `close_visibility_pending`, preserve
all native protection, and perform no cancellation.

### FR-G004 Ambiguous cancellation

An ambiguous cancellation is complete only if exact query proves the order
`CANCELED`. Active, unavailable, or immediately not-found results for a
previously proven order remain cleanup-pending.

### FR-G005 GET-only restart reconciliation

Restart reconciliation MUST query the deterministic close, stop, and target
identities without mutation and report whether closure and cleanup are proven.

### FR-G006 Evidence

Every DELETE MUST retain sanitized before-transport and result evidence under
the same ambiguity and credential-redaction rules as POST mutation.

## Safety invariants

- Production and non-loopback origins remain rejected.
- A reduce-only close cannot be replaced by an ordinary market order.
- Native stop is retained until close proof.
- No blind close or cancel retry follows a timeout or immediate not-found query.
- `closed` means close fill plus stop/target inactivity are all proven.

## Acceptance

1. Tests prove close-fill evidence precedes every DELETE.
2. Ambiguous close produces no DELETE.
3. Ambiguous cancellation remains nonterminal unless exact cancellation is proven.
4. Restart reconciliation is GET-only.
5. DELETE evidence is credential- and signature-free.
6. The complete repository gate passes.

## Non-goals

- CLI exposure, engine wiring, credentials, Testnet execution, production use,
  or profitability acceptance.
