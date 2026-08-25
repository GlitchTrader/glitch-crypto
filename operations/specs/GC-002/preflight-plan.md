# GC-002 Phase E Implementation Plan

**Rail item**: `GC-002` | **Date**: 2026-08-25 | **Spec**: `preflight-spec.md`

## Design

Reuse the signed GET-only `BinanceUsdmShadowClient`; do not add another signer or
endpoint allowlist. Place a pure evaluator over its sanitized capture and a thin
Testnet-only runner in front of it. Expose the runner as a dedicated CLI whose
exit status distinguishes ready, blocked, and execution error.

## Affected paths

- `testnet-preflight.ts`: origin gate, pure evaluator, deterministic report.
- `preflight-cli.ts`: environment binding and exit status only.
- `package.json`: operator command.
- `binance-testnet-preflight.test.ts`: safe and unsafe envelope evidence.
- `BINANCE_TESTNET_PREFLIGHT.md`: operator procedure and interpretation.

## Verification

- Deterministic fixtures prove all policy blockers with no transport.
- An injected production client proves rejection before fetch.
- Existing shadow tests continue proving GET-only authority and redaction.
- Full repository gate and Architectonic Rail validation remain mandatory.

## Promotion boundary

Running this command with Testnet credentials is a separate evidence action. A
ready report is a prerequisite, not authorization, for the later bounded Testnet
mutation and reconciliation exercise.
