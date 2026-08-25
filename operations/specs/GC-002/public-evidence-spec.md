# GC-002c Specification — Finite observed public evidence

## Purpose

Turn Binance public stream observation into a bounded, reviewable, checksum-bound artifact that can be replayed offline. Do not expand venue authority.

## Requirements

- Capture only the public BTCUSDT USD-M diff-depth lane plus its REST snapshot.
- Bound capture duration to 5-300 seconds and evidence storage to a configured maximum.
- Record explicit supervisor start and stop in the same session.
- Refuse evidence-path overwrite.
- Produce a SHA-256-bound manifest with counts, timing, continuity, warnings, replay result, and acceptance reasons.
- Reject mixed sessions, sequence gaps, decreasing timestamps, missing lifecycle evidence, private records, insufficient messages, replay gaps, missing top of book, and crossed/locked top of book.
- Keep live capture outside mandatory CI; deterministic verifier tests remain mandatory CI.
- Upload the initial observed artifact for review, then remove the branch-specific automatic trigger.
- Keep mutation authority false and require no credentials.

## Non-goals

- Authenticated account/private-stream evidence.
- Fee-tier or jurisdiction acceptance.
- Venue selection for mutation.
- Order placement, cancellation, amendment, or protection.
- Profitability or alpha claims.

## Acceptance

GC-002c public evidence is accepted only after an observed artifact and manifest are frozen in the branch, deterministic replay passes in CI, and the rail records the exact capture commit and workflow run. Authenticated private evidence remains a separate gate.
