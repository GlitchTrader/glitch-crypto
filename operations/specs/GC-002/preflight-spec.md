# GC-002 Phase E Specification — authenticated Testnet preflight

**Rail item**: `GC-002`
**Created**: 2026-08-25
**Status**: Active

## Outcome and boundary

Produce one sanitized `ready|blocked` report from authenticated Binance USD-M
Futures Testnet GET evidence before any mutation or engine integration is
considered. The preflight reports unsafe venue settings; it never changes them.

Production access, account reconfiguration, order mutation, credential creation,
capital transfer, and live acceptance are non-goals.

## Requirements

- **FR-001**: The preflight MUST reject every non-Testnet, nonnumeric-loopback origin before transport.
- **FR-002**: The preflight MUST use the existing explicit GET-only shadow client.
- **FR-003**: Both Testnet API key and secret MUST be present for authenticated capture, but neither MAY enter output or errors.
- **FR-004**: BTCUSDT MUST be a trading perpetual supporting market, stop-market, and take-profit-market orders.
- **FR-005**: One-way position mode, single-asset margin, isolated BTCUSDT margin, disabled auto-add margin, and leverage at or below the configured ceiling MUST be proven.
- **FR-006**: Account trading permission, USDT wallet and available balance, and maker/taker commission rates MUST be proven.
- **FR-007**: Pre-existing BTCUSDT exposure or any pre-existing open order MUST block readiness.
- **FR-008**: Missing or malformed position and order snapshots MUST block readiness rather than appearing empty.
- **FR-009**: The report MUST retain exact tick, market quantity step/minimum, minimum notional, and configured leverage ceiling.
- **FR-010**: A blocked report MUST use deterministic blocker codes and MUST NOT mutate venue state.

## Readiness meaning

`ready` means only that the observed Testnet account and instrument satisfy the
declared preconditions for a later bounded mutation exercise. It does not mean:

- a mutation was attempted;
- protection or reconciliation was observed;
- the engine is wired to Binance;
- production or profitability is accepted.

## Success criteria

- Safe authenticated evidence produces `ready` with no blockers.
- Hedge mode, multi-asset/cross margin, excess leverage, auto-add margin, absent
  permission/balance, exposure, orders, or malformed snapshots produce `blocked`.
- A production origin causes a pre-transport exception.
- The full strict build and deterministic suite pass.
