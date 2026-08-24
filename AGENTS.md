# Agent operating contract

## Read first

1. `.specify/memory/constitution.md`
2. `operations/AUTHORITY.md`
3. `operations/ontology.md`
4. `operations/ledger.json`
5. the active `operations/specs/<ID>/` set

## Rail

`operations/ledger.json` is current work authority. Work only an active or ready item whose dependencies are satisfied. Preserve evidence and provenance when changing status.

## Boundaries

- Hermes and models do not receive exchange credentials.
- Code may reject factual invalidity, identity ambiguity, unprotected exposure, hard risk boundaries, and unsupported venue capability. It must not embed a hidden directional strategy.
- Persist intent/evidence before venue mutation.
- Unknown mutation outcomes remain nonterminal until venue reconciliation.
- Every filled quantity must be natively protected or immediately enter an explicit emergency-flatten lifecycle.
- The daily target is portfolio policy, not market evidence.
- Infrastructure failures are operational evidence, never trading lessons.

## Delivery

- Work on a branch and open an unmerged PR.
- Update specs, tests, and rail in the same change when contracts move.
- Run `npm run check` before every push.
- Do not claim live readiness or profitability from green tests.
