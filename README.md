# Glitch Crypto

Glitch Crypto is an event-driven trading gateway for probabilistic crypto cognition inside deterministic, venue-native execution and risk controls.

```text
market/account evidence
        ↓
calibrated numerical evidence + Hermes judgment
        ↓ strict glitch.crypto.intent.v1
Glitch Crypto
  identity · sizing · risk · protection · execution · reconciliation · journal
        ↓
venue-native orders, fills, positions, and protection
```

## Current state

`main` contains the executable protected-control-plane and the first Binance
USD-M evidence/execution contracts:

- strict Node 22/TypeScript gateway;
- SQLite WAL/FULL-sync control and evidence store;
- deterministic paper venue;
- stop-defined position sizing;
- protected entry, exact stop/target identity, partial reduction, and protection re-arming;
- UUID/body-hash idempotency;
- configurable 0.5% daily protected-profit objective;
- usable-pot limit, start/stop, flatten-all, PnL, trades, and journal;
- authenticated numeric-loopback API and CLI;
- shadow-safe fresh state;
- sequence-correct public Testnet capture and deterministic replay;
- GET-only authenticated account discovery and supervised stream contracts;
- a dormant Testnet/loopback-only protected mutation and restart-reconciliation kernel;
- a Testnet-only authenticated preflight that reports unsafe account settings without changing them.

The gateway still runs the paper venue only. Binance mutation has no engine, HTTP,
or general operator binding. No production exchange mutation is available, and
the repository makes no profitability or live-readiness claim.

## Authority

```text
Hermes judges.
Glitch validates, persists, protects, executes, reconciles, and journals.
The venue owns native account, order, fill, position, and protection truth.
```

See [`operations/AUTHORITY.md`](operations/AUTHORITY.md).

## Daily lock semantics

`daily_lock_target_pct=0.5` means 0.5% of the UTC day's starting usable pot:

```text
$100 pot    → $0.50 target
$1,000 pot  → $5.00 target
$10,000 pot → $50.00 target
```

The setting is a portfolio objective and protected-equity floor. It is never:

- evidence that a trade exists;
- a fixed trade take-profit;
- a trade-count quota;
- a quantity formula;
- permission to trade ordinary noise.

Entry quantity is derived independently:

```text
risk budget = usable pot × permitted trade-risk percentage
notional    = risk budget ÷ (structural stop distance + cost reserve)
margin      = notional ÷ leverage
```

After the objective is reached, new exposure is admitted only when worst-case protected equity remains at or above the active floor. Reductions and flatten remain available.

## Requirements

- Node.js 22.5 or newer; Node 22 LTS is recommended.
- npm.

`node:sqlite` is currently marked experimental by Node 22, but its database contract is isolated behind `GlitchDatabase`; a later storage replacement does not change domain contracts.

## Install and verify

```bash
cp .env.example .env
npm install
npm run check
```

Generate two different long random tokens for `.env`:

```text
GLITCH_LOCAL_TOKEN=<model/read/intent token>
GLITCH_OPERATOR_TOKEN=<operator control token>
```

The gateway rejects nonnumeric loopback binds and identical tokens.

For Binance Futures Testnet account readiness, see
[`docs/BINANCE_TESTNET_PREFLIGHT.md`](docs/BINANCE_TESTNET_PREFLIGHT.md).

## Run

```bash
npm start
```

Default origin:

```text
http://127.0.0.1:8791
```

Health is intentionally unauthenticated and contains no credentials:

```bash
curl http://127.0.0.1:8791/health
```

All other routes require a bearer token.

## CLI

The CLI uses `GLITCH_GATEWAY_URL`, `GLITCH_LOCAL_TOKEN`, and `GLITCH_OPERATOR_TOKEN` from the process environment.

```bash
npm run cli -- status
npm run cli -- policy
npm run cli -- pnl
npm run cli -- trades 50
npm run cli -- journal 50
npm run cli -- start
npm run cli -- stop
npm run cli -- flatten "operator requested flat"
npm run cli -- set-lock 0.5
npm run cli -- set-usable-limit 500
npm run cli -- clear-usable-limit
npm run cli -- set-mode shadow
npm run cli -- paper-price 61200
```

Submit a strict intent:

```bash
npm run cli -- intent ./intent.json
```

Example protected entry:

```json
{
  "schema_version": "glitch.crypto.intent.v1",
  "intent_id": "d9aa43f5-78f0-4e2e-b6f7-c53b15285768",
  "packet_id": "immutable-packet-id",
  "account": "paper-main",
  "instrument": "BTCUSDT-PERP",
  "action": "ENTER_LONG",
  "stop_price": 59400,
  "target_price": 61200,
  "requested_risk_pct": 0.5,
  "requested_leverage": 3,
  "reason": "Bounded current-zone asymmetry survives modeled costs and ordinary noise."
}
```

Quantity is intentionally absent. The gateway owns factual quantity construction from current account state, stop geometry, costs, venue step, minimum notional, leverage, open risk, daily loss boundary, and active profit floor.

## Local API

| Route | Token | Purpose |
|---|---|---|
| `GET /health` | none | Nonsecret runtime health |
| `GET /state` | model | Account, market, positions, and risk |
| `GET /packet` | model | Sanitized Hermes decision packet |
| `GET /policy` | model | Current risk policy |
| `GET /performance` | model | Daily PnL and performance summary |
| `GET /trades` | model | Durable completed trade records |
| `GET /journal` | model | Append-only operational/performance journal |
| `POST /intent` | model | Strict intent submission |
| `POST /control/start` | operator | Start the runtime |
| `POST /control/stop` | operator | Stop new cognition/exposure |
| `POST /control/flatten` | operator | Stop and flatten every paper position |
| `PUT /control/policy` | operator | Update bounded policy fields |
| `PUT /control/mode` | operator | Select disabled/shadow/armed state |
| `POST /paper/mark` | operator | Advance deterministic paper mark price |

`armed` is only a control state in GC-001. There is no real venue adapter, so it cannot create real exposure.

## Project method

- Wayfinder map: [issue #1](https://github.com/GlitchTrader/glitch-crypto/issues/1)
- Frontier ticket: [issue #2](https://github.com/GlitchTrader/glitch-crypto/issues/2)
- Spec Kit constitution: [`.specify/memory/constitution.md`](.specify/memory/constitution.md)
- Architectonic rail: [`operations/ledger.json`](operations/ledger.json)
- GC-001 spec set: [`operations/specs/GC-001/`](operations/specs/GC-001/)

The canonical lifecycle is:

```text
concern → specification → plan → tasks → implementation → verification → evidence → evolution
```
