# Binance USD-M public evidence

GC-002 uses finite, sanitized capture sessions rather than treating a continuously running process as acceptance evidence.

## Capture

```bash
npm run build
GLITCH_BINANCE_USDM_EVIDENCE_PATH=./artifacts/binance-usdm-public.jsonl \
  npm run binance:evidence -- capture-public 15
```

The capture command:

- starts only the read-only public depth lane;
- records the supervisor start, stream transitions, diff-depth messages, REST snapshot, and supervisor stop;
- runs for 5-300 seconds and then terminates deterministically;
- refuses to overwrite an existing evidence file;
- writes a SHA-256-bound manifest beside the JSONL evidence;
- exits nonzero unless the frozen session passes the public replay contract;
- never reads an API key and has no mutation authority.

`GLITCH_BINANCE_USDM_EVIDENCE_MIN_MESSAGES` defaults to 10. Runtime acceptance jobs should set a higher threshold appropriate to the capture duration.

## Verify an existing capture

```bash
GLITCH_BINANCE_USDM_EVIDENCE_MIN_MESSAGES=25 \
  npm run binance:evidence -- verify-public ./artifacts/binance-usdm-public.jsonl
```

Verification requires one session, contiguous record sequence, nondecreasing timestamps, explicit start and stop, an observed running state, at least one snapshot, sufficient public messages, no private records, and a deterministic replay ending in a non-crossed ready book. Stream errors remain visible as warnings.

## GitHub evidence job

`.github/workflows/binance-public-evidence.yml` provides a bounded evidence job and uploads the JSONL plus manifest as an artifact. The initial GC-002c branch push is intentionally enabled to obtain observed artifacts. After an artifact is reviewed and frozen, the branch-specific push trigger must be removed; long-term capture is manual through `workflow_dispatch`.

Mainnet run `32787342723` proved deterministic capture termination but was rejected because the GitHub-hosted runner's REST snapshot request received HTTP 451 for a restricted location. That exact runner-access result is retained under `operations/evidence/GC-002/` and is not treated as market evidence.

The temporary branch-triggered job now uses the exact Binance Futures Testnet endpoints:

```text
REST: https://testnet.binancefuture.com
WS:   wss://stream.binancefuture.com
```

Testnet evidence can validate public transport, synchronization, bounded capture, and deterministic replay. It cannot establish production market quality, production access, fees, fill behavior, authenticated account access, private-stream recovery, mutation safety, or profitability.
