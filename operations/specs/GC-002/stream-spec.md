# GC-002 Phase B Specification — supervised Binance USDⓈ-M streams

## Purpose

Continuously observe Binance USDⓈ-M public depth and private account/order truth while preserving the phase-A no-trading boundary. Every reconnect, gap, snapshot, reconciliation, and event must be attributable and deterministically replayable.

## Functional requirements

### FR-B001 Native transport and routing

The runtime MUST use the Node 22 browser-compatible `WebSocket` through an injectable socket factory. Production defaults MUST use the official Binance USDⓈ-M streams origin. Diff-depth MUST use `/public`, aggregate-trade and mark-price MUST use `/market`, and listen-key events MUST use `/private`. Private subscriptions MUST explicitly request the order, account, and listen-key-expiry events understood by the reducer. Nonsecure `ws:` MUST be accepted only for loopback test infrastructure.

### FR-B002 Public stream bootstrap

The public lane MUST connect to the BTCUSDT diff-depth stream, buffer deltas, fetch a REST depth snapshot, discard stale events, and establish a valid overlap before entering `running`.

### FR-B003 Public continuity

After synchronization, a duplicate or already-applied event MUST be ignored. A malformed event, missing update range, or `pu` mismatch MUST invalidate the book, close the socket, and schedule a bounded exponential reconnect. No gapped book may report `running`.

### FR-B004 Listen-key authority

The private lane MAY call only `/fapi/v1/listenKey` using `POST`, `PUT`, and `DELETE` with the API-key header. This authority is session management only. No trading endpoint or signature is allowed in the listen-key client.

### FR-B005 Private synchronization

After the private socket opens, user events MUST be buffered while signed REST balances, positions, and open orders are fetched. REST state MUST be installed first, then buffered events applied in arrival order, before the private lane enters `running`.

### FR-B006 Private continuity

Private socket error/close, listen-key expiration, keepalive failure, malformed event, reconciliation failure, or buffer overflow MUST rotate the private session. Stale callbacks from prior epochs MUST have no effect.

### FR-B007 Keepalive

The active listen key MUST be renewed on a configurable interval shorter than the venue timeout. Keepalive success and failure MUST be recorded without serializing the listen key.

### FR-B008 Bounded evidence

Snapshots, reconciliations, provider messages, transitions, keepalives, and
errors MUST be written to a rotating local JSONL journal. Public depth messages
MUST retain the exact decoded WebSocket frame, hash, connection identity, dual
receive clocks, provider sequence, and inspection version before parsing. The
public REST depth response MUST be retained exactly with request and receive
provenance before JSON parsing, followed by a distinct parsed snapshot record.
The journal MUST redact configured credentials, signatures, tokens, listen
keys, and sensitive-key fields. A single active file plus one backup bounds
disk use.

### FR-B009 Replay

Replay MUST consume evidence in recorded file order. It MUST reproduce public
buffering across snapshot boundaries and private buffering across
reconciliation boundaries. Exact public depth replay acceptance additionally
MUST verify raw hash, parsed-payload equivalence, provider identity, connection
attribution, and strictly increasing monotonic receive time. Supervisor-only
records MAY be ignored but counted. Exact depth-session replay MUST additionally
pair each raw REST bootstrap to its parsed snapshot and verify response hash,
normalized payload, update identity, request identity, and receive ordering.

### FR-B010 Operator surface

`npm run binance:stream -- public` MUST run public depth observation. `account` MUST additionally supervise private state and requires read-only credentials. `replay` MUST reconstruct state from the bounded journal.

### FR-B011 Stop behavior

An operator stop MUST cancel reconnect/keepalive timers, invalidate old epochs, close sockets, close the current listen-key session, and create no restart.

## Safety invariants

- `mutation_authority` is always `false`.
- No order, cancel, amend, leverage, margin-type, or position-mode method exists.
- Private WebSocket URLs and listen keys never enter evidence or status.
- Unrouted production WebSocket URLs are forbidden in constructed connections.
- REST synchronization precedes promotion to `running`.
- Gaps cause resynchronization, never best-effort continuation.
- Failed evidence persistence cannot authorize exposure.
- This phase cannot select or arm a production execution venue.

## Acceptance tests

1. Listen-key lifecycle uses only `POST`, `PUT`, and `DELETE` on `/fapi/v1/listenKey`.
2. Listen-key errors redact the API key.
3. Public messages arriving before the snapshot are applied after a valid overlap.
4. `pu` continuity loss moves the public lane to backoff and creates a new socket epoch.
5. Private events arriving during reconciliation are applied after REST state.
6. Keepalive failure closes the old session and creates a new listen key.
7. Active listen keys are redacted from diagnostics.
8. Evidence rotates at the configured bound and contains no forbidden values.
9. Replay preserves message-before-snapshot and message-before-reconciliation semantics.
10. Operator stop leaves both lanes stopped with no pending restart.
11. Full repository CI passes.
