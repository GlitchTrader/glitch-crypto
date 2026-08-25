import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  verifyBinanceMarketEvidence,
  writeBinanceMarketEvidenceManifest,
} from "./market-evidence.js";
import { BinanceMarketStreamRecorder } from "./market-stream-recorder.js";
import { JsonlBinanceStreamEvidenceSink } from "./stream-evidence.js";
import {
  NativeBinanceWebSocketFactory,
  defaultBinanceStreamScheduler,
  normalizeBinanceStreamsBaseUrl,
  normalizeBinanceSymbol,
} from "./stream-common.js";

const [command = "verify", argument, pathArgument] = process.argv.slice(2);
const evidencePath = resolve(
  pathArgument ??
    (command === "verify" ? argument : undefined) ??
    process.env.GLITCH_BINANCE_USDM_MARKET_EVIDENCE_PATH ??
    "./artifacts/binance-usdm-market.jsonl",
);
const verification = {
  symbol: process.env.GLITCH_BINANCE_USDM_SYMBOL,
  minimumAggregateTrades: optionalBoundedInteger(
    process.env.GLITCH_BINANCE_USDM_MARKET_MIN_AGG_TRADES,
    1,
    1_000_000,
    10,
    "minimum aggregate trades",
  ),
  minimumMarkPrices: optionalBoundedInteger(
    process.env.GLITCH_BINANCE_USDM_MARKET_MIN_MARK_PRICES,
    1,
    1_000_000,
    5,
    "minimum mark prices",
  ),
};

if (command === "capture") {
  if (existsSync(evidencePath) || existsSync(`${evidencePath}.1`)) {
    throw new Error(
      `refusing to overwrite Binance market evidence at ${evidencePath}; choose a new path`,
    );
  }
  const durationSeconds = boundedInteger(
    argument === undefined ? 15 : Number(argument),
    5,
    300,
    "capture duration seconds",
  );
  const symbol = normalizeBinanceSymbol(
    process.env.GLITCH_BINANCE_USDM_SYMBOL ?? "BTCUSDT",
  );
  const evidence = new JsonlBinanceStreamEvidenceSink(evidencePath, {
    maxBytes: optionalBoundedInteger(
      process.env.GLITCH_BINANCE_USDM_EVIDENCE_MAX_BYTES,
      1_024,
      512 * 1024 * 1024,
      32 * 1024 * 1024,
      "evidence maximum bytes",
    ),
  });
  const recorder = new BinanceMarketStreamRecorder({
    symbol,
    streamsBaseUrl: normalizeBinanceStreamsBaseUrl(
      process.env.GLITCH_BINANCE_USDM_STREAMS_URL ??
        "wss://fstream.binance.com",
    ),
    reconnectBaseMs: 500,
    reconnectMaxMs: 30_000,
    socketFactory: new NativeBinanceWebSocketFactory(),
    scheduler: defaultBinanceStreamScheduler(),
    evidence,
  });

  recorder.start();
  await delay(durationSeconds * 1_000);
  const finalStatus = recorder.stop();
  const report = writeBinanceMarketEvidenceManifest(
    evidencePath,
    `${evidencePath}.manifest.json`,
    verification,
  );
  console.log(
    JSON.stringify(
      {
        command,
        duration_seconds: durationSeconds,
        evidence_path: evidencePath,
        final_status: finalStatus,
        report,
      },
      null,
      2,
    ),
  );
  process.exitCode = report.accepted_for_event_replay ? 0 : 1;
} else if (command === "verify") {
  const report = verifyBinanceMarketEvidence(evidencePath, verification);
  console.log(JSON.stringify(report, null, 2));
  if (!report.accepted_for_event_replay) {
    process.exitCode = 1;
  }
} else {
  throw new Error(
    "Usage: npm run binance:market-evidence -- <capture [seconds] [path]|verify [path]>",
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

function optionalBoundedInteger(
  value: string | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  return boundedInteger(Number(value), minimum, maximum, name);
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}
