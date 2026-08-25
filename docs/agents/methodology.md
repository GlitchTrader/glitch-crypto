# Glitch Crypto delivery methodology

This repository uses Wayfinder for genuine decision fog, `to-spec` for outcome
contracts, `to-ticket`/`to-tickets` for GitHub tracker decomposition, GitHub Spec
Kit for `spec.md` -> `plan.md` -> `tasks.md`, Architectonic ontology for knowledge
classes, and Architectonic Rail for the single current-work state.

## Artifact authority

1. `.specify/memory/constitution.md` and `operations/AUTHORITY.md` define rules and authority.
2. `operations/ontology.md` defines stable concepts and distinctions.
3. ADRs record consequential technical decisions.
4. `operations/specs/<ID>/` records the outcome, implementation plan, and bounded task decomposition.
5. `operations/ledger.json` alone owns current work status, dependencies, claims, blockers, and acceptance evidence.
6. GitHub issues expose requests, decision maps, and review discussion. They do not replace Rail.
7. Source, venue evidence, and tests prove implementation facts.

## Lifecycle

1. Read the constitution, authority, ontology, Rail item, source, and active spec.
2. Grill only unresolved material questions. Record facts, assumptions, decisions, rules, questions, and risks explicitly.
3. Use Wayfinder only when multiple consequential decisions remain. A map issue points to child research or decision tickets with native dependencies.
4. Write or update `spec.md` with independently testable outcomes, edge cases, non-goals, and measurable acceptance. Do not hide an implementation choice in the requirement.
5. Write `plan.md` only after the constitution check and source inspection. Record the smallest design that satisfies the spec and the evidence required for promotion.
6. Write `tasks.md` with exact paths and independent tests. Its checkboxes decompose one Rail item; they are not a second project queue.
7. Implement directly on `main` in bounded commits. Preserve intent/evidence before mutation and keep live authority disabled unless separately approved.
8. Run the complete repository gate, attach factual evidence to Rail, then push `main`.
9. Update GitHub issues to match the source and Rail. Do not open a PR unless the human requests one.

## Promotion language

Keep these states separate: implemented, deterministically tested, replay-tested,
shadow-observed, mutation-tested, production-accepted, and empirically profitable.
No state implies the next one.
