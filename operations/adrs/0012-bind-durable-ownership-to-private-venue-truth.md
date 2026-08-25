# ADR 0012: Bind durable ownership identity to private venue truth

- **Status**: Accepted for implementation
- **Date**: 2026-08-25
- **Rail**: GC-002

## Context

Protected entry, revision, partial reduction, and generic close now use exact native identities, but no durable current pointer survives restart and no compiler proves that pointer still matches the venue position and both active protections. Original-entry history cannot answer current quantity or replacement identity after revisions. Ordinary open-order snapshots are not the authority for Binance's migrated conditional Algo orders.

## Decision

Persist one versioned `OwnedProtectionState` with canonical JSON, an integrity hash, compare-and-set versioning, and the complete request staged before transport and retained for any nonterminal transition. Compile `OwnedProtectionBinding` separately from fresh reconciled private position state and exact stop/target Algo evidence. Only a proof-complete result may advance the current pointer; the compiler remains non-authorizing.

## Alternatives rejected

- Reconstructing current ownership from original entry: stale after reduction or replacement.
- Inferring protection from price proximity or ordinary open orders: identity-ambiguous and incompatible with the conditional Algo contract.
- Persisting only a status or intent ID: insufficient for exact GET-only restart reconciliation.
- Writing venue state into the local pointer: reverses authority; venue facts must remain independently observed.

## Consequences

- Restart recovery retains exact reconciliation inputs and rejects body drift.
- Local corruption and competing writers fail closed.
- A proven replacement pair may become the current pointer while old cleanup remains pending, but management stays blocked.
- This adds no authenticated transport, mutation, engine, production, or profitability authority.
