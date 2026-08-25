# Agent operating contract

## Read first

1. `.specify/memory/constitution.md`
2. `operations/AUTHORITY.md`
3. `operations/ontology.md`
4. `docs/agents/methodology.md`
5. `operations/ledger.json`
6. the active `operations/specs/<ID>/` set

## Rail

`operations/ledger.json` is the sole current-work authority. Use Architectonic Rail states exactly. Work only an assigned `in_progress` item or a dependency-clear `ready` item. Preserve evidence and provenance when changing status.

## Agent skills

- Wayfinder and `to-ticket`/`to-tickets`: read `docs/agents/issue-tracker.md`.
- Grilling and domain modeling: read `docs/agents/domain.md` and update `operations/ontology.md` or an ADR when knowledge changes.
- `to-spec` and GitHub Spec Kit artifacts: read `docs/agents/methodology.md` and use `.specify/templates/`.

## Boundaries

- Hermes and models do not receive exchange credentials.
- Code may reject factual invalidity, identity ambiguity, unprotected exposure, hard risk boundaries, and unsupported venue capability. It must not embed a hidden directional strategy.
- Persist intent/evidence before venue mutation.
- Unknown mutation outcomes remain nonterminal until venue reconciliation.
- Every filled quantity must be natively protected or immediately enter an explicit emergency-flatten lifecycle.
- The daily target is portfolio policy, not market evidence.
- Infrastructure failures are operational evidence, never trading lessons.

## Delivery

- Work directly on `main`; pull/fetch first, keep commits bounded, and push only after the full gate passes.
- Do not open a PR unless the human explicitly requests one.
- Update specs, tests, and rail in the same change when contracts move.
- Run `npm.cmd run check` before every push on Windows.
- Do not claim live readiness or profitability from green tests.
