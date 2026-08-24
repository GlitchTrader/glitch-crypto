# GC-002 Phase B Plan

## Architecture

```text
public diff-depth WebSocket ──buffer──┐
                                      ├─ REST snapshot overlap ─ local order book
signed REST account snapshot ─────────┤
private user-data WebSocket ──buffer──┘─ REST reconciliation ─ private state

all snapshots/events/transitions
        ↓ redact + bound + rotate
local JSONL evidence
        ↓ deterministic replay
reconstructed public/private state
```

## State ownership

- Binance owns native market, account, order, fill, and position truth.
- The supervisor owns connection epochs, synchronization state, reconnect policy, and local reducers.
- The evidence journal owns sanitized transport facts.
- Neither the stream supervisor nor replay owns trading mutation authority.

## Work sequence

1. Isolate listen-key session authority from signed account reads.
2. Define injectable WebSocket and scheduler boundaries.
3. Implement public bootstrap, continuity, and reconnect.
4. Implement private buffer/reconcile, keepalive, rotation, and stale-epoch rejection.
5. Implement bounded evidence and deterministic replay.
6. Add public/account/replay CLI modes.
7. Add focused deterministic state-machine tests.
8. Publish a stacked draft PR over GC-002a and run the full repository gate.
9. Capture sanitized observed fixtures before accepting phase B.

## Non-goals

- Trading WebSocket API requests.
- Order placement, cancellation, amendment, or protection.
- Automatic failover to another venue.
- Sending raw account evidence to Hermes.
- Treating green simulation tests as observed transport acceptance.
