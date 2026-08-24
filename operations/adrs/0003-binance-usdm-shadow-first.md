# ADR 0003 — Binance USDⓈ-M shadow evidence before mutation

## Status

Accepted for GC-002 phase A on 2026-08-24.

## Context

The gateway needs real perpetual-market and account evidence before a production mutation adapter can be accepted. Implementing order placement before precision, fees, account mode, sequence continuity, private-state reconciliation, and credential isolation are proven would invert the safety order.

Binance USDⓈ-M is the initial observation benchmark because its official REST, WebSocket API, and WebSocket Streams contracts expose BTC perpetual market data, exchange filters, account configuration, positions, open orders, commission rates, and user events. This decision does not assert that Binance will receive the first real-money order.

## Decision

Create a stacked GC-002 branch that:

- contains no order placement, amendment, cancellation, leverage-change, margin-change, or position-mode mutation endpoint;
- permits only an explicit allowlist of public and signed `GET` endpoints;
- signs private reads inside the gateway process and never serializes credentials or signatures;
- parses exchange information into an exact symbol/precision contract;
- implements replayable depth snapshot/delta continuity with gap invalidation;
- implements idempotent private account/order event reduction and REST restart reconciliation;
- exposes a one-shot CLI for public or authenticated read-only evidence capture.

Production order mutation remains a separate acceptance phase inside GC-002.

## Consequences

- Real venue assumptions can be invalidated before capital is exposed.
- API credentials can be provisioned without trade permission for this phase.
- Green tests prove read-only contracts and replay behavior, not venue suitability, profitability, or live readiness.
- Actual jurisdiction access, authenticated fee tier, network latency, stream continuity, and testnet fidelity remain runtime evidence requirements.
