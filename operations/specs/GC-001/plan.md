# GC-001 Implementation plan

## Architecture

```text
CLI / Hermes plugin
        ↓ authenticated numeric loopback
HTTP control/read/intent API
        ↓
TradingEngine
  ├─ RiskEngine
  ├─ GlitchDatabase
  └─ VenueAdapter → PaperVenue
```

## Modules

- `src/domain/`: schemas, money/rate arithmetic, canonical identity, policy.
- `src/storage/`: single durable SQLite writer.
- `src/core/`: risk derivation and trading lifecycle.
- `src/venue/`: venue contract and deterministic paper implementation.
- `src/api/`: authenticated loopback routes.
- `src/cli.ts`: operator/read client.

## Data flow

1. Packet exposes current sanitized state, policy, risk, and supported actions.
2. Hermes/human submits a strict decision with UUID, packet identity, stop, target, and optional bounded risk request.
3. Gateway validates identity and claims UUID/body before mutation.
4. Risk engine calculates quantity from usable pot, stop, costs, leverage, margin, precision, open risk, daily loss, and floor.
5. Venue adapter returns exact entry/stop/target evidence.
6. Gateway persists protected position and receipt.
7. Mark/management events update or close exact quantity and append outcome/journal evidence.

## Failure modes

- Invalid schema/identity: explicit rejected receipt.
- Duplicate body conflict: 409/conflict without mutation.
- Missing protection: no terminal protected state.
- Partial dust: reject without mutation.
- Policy/floor violation: reject new exposure; retain reduction/flatten.
- Restart: replay stored receipt and reconstruct position/trade state.
- Wrong token: 401 before operation.

## Verification

- TypeScript strict compile.
- Unit tests for target math and usable limit.
- Integration tests for idempotency, protection, partial re-arm, floor, auth, and restart.
- CLI smoke transcript against a started paper gateway.
