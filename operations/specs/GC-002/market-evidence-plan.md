# GC-002 Phase E Plan — raw Binance market evidence

## Architecture

```text
/market/ws/<symbol>@aggTrade/<symbol>@markPrice@1s
                 ↓ raw payload first
bounded credential-free JSONL evidence
                 ↓ strict identity/schema inspection
finite lifecycle + content hash verification manifest
```

The recorder reuses the existing injectable Node WebSocket, scheduler, routed
URL builder, evidence schema, redaction, rotation, and JSONL reader. It is a
separate read-only process from depth/account supervision and all mutation code.

## Work sequence

1. Add the `public-market` evidence channel and strict event inspector.
2. Add one fail-closed routed recorder for aggregate trades and mark price.
3. Add finite capture and verification with content identity.
4. Add deterministic event, route, lifecycle, and rejection tests.
5. Capture a short credential-free external session and retain the manifest.
6. Run the full gate, record Rail evidence, commit, and push `main`.

## Promotion boundary

Passing this phase admits the raw capture as input evidence only. GC-003 owns
feature definitions and replay semantics; no strategy or profitability claim is
promoted here.
