# Tasks: Protected-position management risk plan

**Rail item**: `GC-002` | **Inputs**: `management-risk-plan-spec.md`, `management-risk-plan-plan.md`, ADR 0015

## Contract and implementation

- [x] Q001 Add the pure `ProtectionManagementPlan` compiler.
- [x] Q002 Add deterministic management-risk fixtures and edge-case tests.
- [x] Q003 Require a ready proof-bound plan before the dormant orchestrator can execute a protection revision.
- [x] Q004 Update ontology, ADR, and execution documentation.

## Verification and evidence

- [x] Q005 Run `npm.cmd run check` and record factual output.
- [x] Q006 Update GitHub and Rail evidence, then push direct to `main`.

## Dependencies and stop lines

- Phase P orchestrator, durable ownership, exact binding, and stop-first revision are accepted.
- No credentials, network effects, runtime selection, permit issuance, deployment, live capital, production, or profitability claim.
