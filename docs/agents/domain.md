# Domain-modeling and grilling context

Use `operations/ontology.md` as the canonical model. Extend that file when a
concept is stable; use an ADR when the change selects an architecture or venue
contract. Do not create a competing context model.

Before a material design change, answer only the questions that affect the
contract:

- Which statements are venue facts, derived state, probabilistic evidence, or assumptions?
- Which actor owns the decision, mutation, reconciliation, and operator override?
- What identity makes retries idempotent, and what remains ambiguous after timeout?
- How is every filled quantity proven natively protected during partial fill, reduction, restart, and disconnect?
- Which loss, floor, usable-pot, and exposure boundaries must deterministic code enforce?
- What evidence promotes this slice, and what evidence would contradict or roll it back?
- Is the daily objective being misused as market evidence, geometry, quota, or loss allowance?

If the answer is already authoritative in source or evidence, cite it instead of
asking the human again.
