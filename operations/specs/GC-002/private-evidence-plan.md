# GC-002 Phase F Plan — authenticated private-stream evidence

## Architecture

```text
authenticated Testnet GET-only preflight
                 ↓ ready only
public depth + private listen-key supervisor
                 ↓ bounded credential-redacted JSONL (local)
finite private verifier → sanitized content-addressed manifest
```

The capture command composes existing accepted components: shadow client,
preflight, listen-key client, stream supervisor, evidence sink, and deterministic
replay. The new code owns only finite orchestration and sanitized acceptance.

## Work sequence

1. Specify private evidence eligibility and privacy boundaries.
2. Implement the sanitized verifier and manifest.
3. Implement Testnet-only preflight-gated finite capture.
4. Add deterministic acceptance and rejection tests.
5. Run the full repository gate and push the dormant source.
6. Await credentials and explicit runtime approval before external capture.

## Promotion boundary

Source acceptance proves only the gate implementation. Observed authenticated
private transport remains pending until a human-authorized Testnet run produces
accepted local evidence.
