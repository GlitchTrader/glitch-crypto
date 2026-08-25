# GitHub issue-tracker contract

Repository: `GlitchTrader/glitch-crypto`.

- `operations/ledger.json` is the status authority.
- GitHub issues are the durable request, decision-map, research, and discussion surface.
- Direct delivery is to `main`; pull requests are created only on explicit request.
- Use the user's `to-ticket` name as an alias of upstream `to-tickets`.
- A Wayfinder map is labeled `wayfinder` and links only unresolved child decisions.
- Child issues use native sub-issue and dependency relationships where GitHub supports them.
- Close completed or superseded issues with a source commit and Rail item reference.
- Do not encode dependencies only in title prefixes or duplicate Rail status in issue prose.

Use Wayfinder only when the implementation path contains consequential fog. If
the source, ADRs, and accepted evidence already determine the next slice, update
the existing Rail item and implement it without ticket theater.
