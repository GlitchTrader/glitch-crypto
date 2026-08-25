# ADR 0005 — Isolate Binance protected mutation behind a Testnet-only boundary

## Status

Accepted for GC-002 phase D on 2026-08-25.

## Context

Public Futures Testnet transport and deterministic replay are accepted. The next
contract risk is not market direction; it is mutation identity, conditional-order
ownership, stop-first protection, and uncertainty after timeout or disconnect.

The official API separates ordinary orders from conditional Algo orders and gives
each an exact client-ID query surface. It also states that some 503 responses have
unknown execution status and must not be treated as failure.

The current gateway is synchronous and paper-backed. Wiring an unaccepted network
adapter into that engine would conflate source implementation with runtime
promotion and would weaken the default-safe boundary.

## Decision

- Add a dormant asynchronous mutation kernel with no CLI, HTTP, or engine binding.
- Permit only `https://demo-fapi.binance.com` and numeric loopback test origins.
- Derive four deterministic client identities from each intent UUID.
- Record sanitized evidence before transport.
- Submit one market entry, query ambiguity by identity, and protect the exact
  executed quantity with a queried reduce-only Algo stop before placing a target.
- If stop ownership cannot be proven, submit one deterministic reduce-only market
  emergency close and retain a nonterminal state until the close is proven.
- Do not retry a mutation from elapsed time or one not-found query.

## Consequences

- Source can prove the hard lifecycle before any credential or capital use.
- Testnet credentials and authenticated runtime evidence remain separate approval/evidence gates.
- A stop exists independently of Glitch connectivity once Binance accepts it.
- Target failure degrades to stop-protected state rather than false success or immediate duplicate mutation.
- Production URL access remains structurally unavailable in this phase.

## 2026-08-25 close lifecycle amendment

Protected-position close keeps exact native protection active until a
deterministic reduce-only market close is proven filled. Only then may the
coordinator cancel the derived target and stop `clientAlgoId` values. Cancellation
ambiguity remains nonterminal, and restart reconciliation is GET-only. Symbol-wide
cancel-all endpoints remain outside the contract.
