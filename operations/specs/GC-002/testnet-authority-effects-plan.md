# Implementation Plan: Dormant Testnet authority and effect composition

**Rail item**: `GC-002` | **Spec**: `testnet-authority-effects-spec.md`

1. Add a proof-derived operator permit issuer with injected clock and UUID source.
2. Add a zero-policy effect adapter joining the existing protected-entry and protection-revision coordinators.
3. Prove authorization separation, proof freshness/identity, bounded validity, exact delegation, and secret-free output.
4. Update ontology and execution documentation.
5. Run the complete gate and record source-only evidence.

The implementation remains dormant: composition objects exist, but startup and the local server do not import or instantiate them.
