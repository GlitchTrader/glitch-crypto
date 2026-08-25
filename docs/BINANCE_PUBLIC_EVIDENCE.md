# Binance USD-M public evidence

GC-002 uses finite, sanitized capture sessions rather than treating a continuously running process as acceptance evidence.

## Capture

```bash
npm run build
GLITCH_BINANCE_USDM_EVIDENCE_PATH=./artifacts/binance-usdm-public.jsonl \
  npm run binance:evidence -- capture-public 30
```

The capture command:

- starts only the read-only public depth lane;
- records supervisor start/stop, stream transitions, diff-depth messages, and the REST snapshot;
- runs for 5-300 seconds and terminates deterministically;
- refuses to overwrite an existing evidence file;
- writes a SHA-256-bound manifest beside the JSONL evidence; its digest uses
  canonical LF JSONL text so the same frozen session has one identity on every
  supported checkout platform;
- exits nonzero unless the frozen session passes the public replay contract;
- never reads an API key and has no mutation authority.

`GLITCH_BINANCE_USDM_EVIDENCE_MIN_MESSAGES` defaults to 10. Runtime acceptance jobs set a higher threshold appropriate to the capture duration.

## Verify an existing capture

```bash
GLITCH_BINANCE_USDM_EVIDENCE_MIN_MESSAGES=25 \
  npm run binance:evidence -- verify-public ./artifacts/binance-usdm-public.jsonl
```

Verification requires one session, contiguous record sequence, nondecreasing timestamps, explicit start and stop, an observed running state, at least one snapshot, sufficient public messages, no private records, and a deterministic replay ending in a non-crossed ready book. Stream errors remain visible as warnings.

## Observed runs

### Mainnet runner eligibility rejection

Run `32787342723` proved bounded capture termination but was rejected because the GitHub-hosted runner received HTTP 451 from the mainnet REST depth endpoint. The result is frozen in `operations/evidence/GC-002/binance-mainnet-run-32787342723.json`. It is runner-access evidence only, not market or production-readiness evidence.

### Testnet protocol diagnosis

Run `32787924187` reached Futures Testnet but exposed ten false reconnects. The implementation had applied Spot-style consecutive `U` rules after synchronization. USD-M Futures uses snapshot overlap for the first processed delta and `pu == previous u` continuity thereafter. The observed event chain was valid; the local book logic was not.

### Accepted Testnet public transport/replay

Commit `747e29bfd6544bdb16f86c913017c1010cd15a2a` corrected the continuity model. Run `32788614491` then produced an accepted session:

- duration: 30.037 seconds;
- records: 118;
- public depth messages: 111;
- REST snapshots: 1;
- reconnects: 0;
- stream errors: 0;
- replay result: ready BTCUSDT book, update ID `410623478212`;
- raw evidence SHA-256: `c78fd6e94b691a299d429f48ecd4e2e067cac6b55051f2ed5e5adce0adda4dbe`;
- artifact ZIP SHA-256: `77db5a72ecddd15ab1d2fd7c6f14f225e448addfc459c871b996235e6541184e`.

A compact observed fixture is frozen at `tests/fixtures/binance-usdm/observed-testnet-public.jsonl`. Its provenance and deterministic derivation are recorded in `operations/evidence/GC-002/binance-testnet-run-32788614491.json`.

## Workflow policy

`.github/workflows/binance-public-evidence.yml` is manual-only through `workflow_dispatch`. Live exchange availability is not a mandatory CI dependency. Mandatory CI uses the frozen fixture and deterministic verifier.

## Authority boundary

This evidence accepts only bounded public Futures Testnet transport and replay behavior. It does not establish production eligibility, mainnet market quality, authenticated account access, fee tier, precision discovery, private-stream recovery, native protection, fill behavior, mutation safety, or profitability.
