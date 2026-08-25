# Binance USDⓈ-M supervised shadow streams

GC-002 phase B continuously observes Binance without exposing trading mutation authority.

## Public depth observation

```bash
npm run build
npm run binance:stream -- public
```

The supervisor retains each exact diff-depth WebSocket frame and receive
provenance before strict identity parsing, buffers valid deltas, obtains a REST
snapshot, establishes sequence continuity, and reconnects from a new snapshot
after any gap or malformed identity. For clients supporting exact public REST
capture, the successful response text and request/receive provenance are
retained before JSON parsing, followed by a separate normalized snapshot record.

## Public plus private account observation

Use a dedicated API key without trade permission:

```text
GLITCH_BINANCE_USDM_API_KEY=...
GLITCH_BINANCE_USDM_API_SECRET=...
```

Then run:

```bash
npm run binance:stream -- account
```

The private lane creates and renews a user-data listen key, buffers events while REST balances/positions/open orders reconcile, then applies buffered events in arrival order.

## Evidence

Default path:

```text
./data/binance-usdm-stream.jsonl
```

Configuration:

```text
GLITCH_BINANCE_USDM_STREAMS_URL=wss://fstream.binance.com
GLITCH_BINANCE_USDM_EVIDENCE_PATH=./data/binance-usdm-stream.jsonl
GLITCH_BINANCE_USDM_EVIDENCE_MAX_BYTES=33554432
```

The configured value is a bare origin. Glitch constructs the current Binance
routes itself: depth under `/public`, regular market streams under `/market`,
and listen-key user data under `/private`. Do not put a route path in the
environment value.

The writer maintains one active file and one `.1` backup. Every record has a
session ID and sequence. Public depth WebSocket messages use version 2 with the
exact frame, SHA-256, connection ID, dual receive clocks, provider sequence,
and inspection version. Exact REST depth bootstrap responses use version 3 and
remain distinct from their version-1 parsed snapshot. Credentials, signatures,
tokens, sensitive-key fields, and active listen keys are redacted.

## Replay

```bash
npm run binance:stream -- replay ./data/binance-usdm-stream.jsonl
```

Replay reads the backup first and then the active file, preserving recorded order and synchronization boundaries.

## Safety boundary

- `mutation_authority` is always `false`.
- The listen-key client can touch only `/fapi/v1/listenKey`.
- No order, cancel, amend, leverage, margin, or position-mode mutation method exists.
- No gapped public book or unreconciled private state is reported as running.
- Green tests do not authorize production execution.
