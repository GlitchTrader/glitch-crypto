# GC-002 Phase D Implementation Plan

**Rail item**: `GC-002` | **Date**: 2026-08-25 | **Spec**: `mutation-spec.md`

## Summary

Add an isolated asynchronous Binance USD-M mutation kernel that accepts only the
official Testnet origin or numeric loopback test infrastructure. Keep it outside
the existing paper engine and operator surfaces. Separate deterministic identity,
signed transport classification, native query proof, and stop-first coordination.

## Source truth inspected

- Current GC-001 paper venue and durable intent claim/finalization flow.
- Current Binance signing, redaction, symbol, private-state, stream, and replay code.
- Glitch NT intent, native-protection, partial-reduction, flatten, and learning evidence contracts.
- Official Binance USD-M Testnet, order, Algo order, exact-query, and HTTP ambiguity documentation.

## Constitution and authority check

- Production mutation remains unavailable: pass.
- Credentials remain gateway-only and absent from evidence: required by design and tests.
- Evidence precedes mutation: required by the client.
- Ambiguity remains nonterminal: required by result types and coordinator.
- Protection is part of entry: stop proof precedes target.
- This work claims deterministic contract behavior only: pass.

## Design and affected paths

- `mutation-contract.ts`: exact IDs, geometry, and request types.
- `mutation-client.ts`: Testnet-only signing, before-transport evidence, response classification, and exact lookup.
- `protection-coordinator.ts`: entry -> stop proof -> target, with emergency-close fallback.
- `tests/binance-mutation-*.test.ts`: independent transport and lifecycle scenarios.
- `0005-binance-testnet-protected-mutation.md`: decision and promotion boundary.

## Acceptance evidence

- Deterministic fake transport proves calls and failure states.
- Full repository gate proves no regression.
- Authenticated Testnet evidence remains a later explicit gate and is not fabricated.

## Promotion and rollback

The change is dormant source code with no runtime route. It can be removed without
data migration. Wiring it into the engine, supplying Testnet credentials, running
a mutation, and accepting production are separate later decisions.
