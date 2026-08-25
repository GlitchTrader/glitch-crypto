# GC-002 Phase J Specification — exact public depth bootstrap provenance

## Purpose

Close the explicit boundary between exact diff-depth WebSocket frames and the
parsed-only REST bootstrap. A newly captured public session must retain the
successful `/fapi/v1/depth` response text before JSON and order-book parsing,
then prove that the immutable raw response is the source of the parsed snapshot
used for replay. This is credential-free observation only.

## Source facts

- The consolidated build brief requires raw market truth to precede derived
  state and deterministic replay.
- Phase I accepts exact version-2 depth WebSocket frames but explicitly does not
  claim byte-exact REST snapshot provenance.
- The public lane requests `/fapi/v1/depth` with the configured symbol and depth
  limit before entering `running`.
- Binance USDⓈ-M exposes public REST and WebSocket APIs for derivatives market
  data.

Sources:

- consolidated Glitch Crypto build brief, sections 13 and 16;
- `operations/specs/GC-002/depth-provenance-spec.md`;
- `operations/adrs/0007-exact-public-depth-frame-provenance.md`;
- https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/Introduction

## Functional requirements

### FR-J001 Exact successful response

The approved public REST client MUST be able to return the exact successful
response text without parsing it. The result MUST identify the bare origin,
path, canonical query, HTTP status, wall-clock receive time, and monotonic
receive time. It MUST expose no signed or credential-bearing endpoint.

### FR-J002 Persist before parse

The public lane MUST synchronously retain an immutable raw-snapshot evidence
record before JSON parsing, snapshot validation, order-book loading, or
promotion to `running`. The raw record MUST contain the exact response text and
SHA-256 plus venue, instrument, request identity, receive clocks, and snapshot
inspection version.

### FR-J003 Separate parsed record

After raw retention, the lane MUST parse and strictly validate the response,
then retain the existing parsed snapshot record. Raw and parsed records remain
separate facts; replay applies only the parsed snapshot.

### FR-J004 Proven pairing

Verification MUST prove that each parsed snapshot has one preceding raw record,
the raw hash matches, the raw response parses to the exact retained payload,
the request is `GET /fapi/v1/depth` for the expected symbol and configured
limit, the `lastUpdateId` identities agree, and receive time is attributable.

### FR-J005 Fail closed

Hash, response/payload, request, instrument, update-ID, receive-clock, ordering,
missing-pair, or duplicate-pair faults MUST prevent exact depth-session replay
acceptance. Runtime parse or snapshot validation failure MUST retain the raw
record and enter the existing attributable reconnect lifecycle.

### FR-J006 Three distinct claims

- `accepted_for_public_replay` means parsed snapshot/delta replay ends ready and
  non-crossed.
- `accepted_for_depth_frame_replay` additionally verifies every WebSocket depth
  frame.
- `accepted_for_depth_session_replay` additionally verifies the exact REST
  bootstrap response and its pairing to the parsed snapshot.

Current public capture and verification command success MUST require the
strongest claim. Historical fixtures retain their prior claims and become
explicitly legacy only for the new bootstrap claim.

## Safety invariants

- Only the approved public GET allowlist is reachable.
- The raw snapshot record contains no API key, secret, signature, account state,
  private event, or mutation authority.
- A raw response is immutable; parsed state never rewrites it.
- No evidence claim authorizes authenticated transport, venue mutation,
  production use, GC-003, or profitability.

## Acceptance

1. Exact raw response evidence precedes its parsed snapshot in record order.
2. Invalid JSON and malformed snapshots retain raw evidence before backoff.
3. Hash, payload, request, update-ID, clock, and pairing tampering fail the
   exact-session claim.
4. Existing version-1 and version-2 fixtures remain readable with unchanged
   original claims.
5. A bounded credential-free Testnet capture passes all three claims.
6. The complete repository gate passes.

## Non-goals

HTTP connection internals unavailable from `fetch`, private REST responses,
private WebSocket frames, features, labels, fills, credentials, mutation,
production promotion, or profitability.
