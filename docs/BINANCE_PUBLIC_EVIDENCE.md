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
- runs for 5-300 seconds and then stops deterministically;
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

`.github/workflows/binance-public-evidence.yml` provides a bounded evidence job and uploads the JSONL plus manifest as an artifact. The initial GC-002c branch push is intentionally enabled to obtain the first observed artifact. After the artifact is reviewed and frozen, the branch-specific push trigger must be removed; long-term capture is manual through `workflow_dispatch`.

This job proves transport/replay behavior from the runner location only. It does not prove the user's authenticated account access, fee tier, jurisdiction eligibility, private stream recovery, fill quality, or mutation safety.
