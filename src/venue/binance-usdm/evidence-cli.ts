import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  verifyBinancePublicEvidence,
  writeBinancePublicEvidenceManifest,
} from "./public-evidence.js";
import { JsonlBinanceStreamEvidenceSink } from "./stream-evidence.js";
import { BinanceUsdmShadowClient } from "./shadow-client.js";
import { BinanceUsdmStreamSupervisor } from "./stream-supervisor.js";

const [command = "verify-public", argument, pathArgument] = process.argv.slice(2);
const evidencePath = resolve(
  pathArgument ??
    (command === "verify-public" ? argument : undefined) ??
    process.env.GLITCH_BINANCE_USDM_EVIDENCE_PATH ??
    "./artifacts/binance-usdm-public.jsonl",
);
const minimumMessages = optionalBoundedInteger(
  process.env.GLITCH_BINANCE_USDM_EVIDENCE_MIN_MESSAGES,
  1,
  1_000_000,
  10,
  "minimum public messages",
);

if (command === "capture-public") {
  if (existsSync(evidencePath) || existsSync(`${evidencePath}.1`)) {
    throw new Error(
      `refusing to overwrite Binance evidence at ${evidencePath}; choose a new path`,
    );
  }
  const durationSeconds = boundedInteger(
    argument === undefined ? 15 : Number(argument),
    5,
    300,
    "capture duration seconds",
  );
  const client = new BinanceUsdmShadowClient({
    baseUrl: process.env.GLITCH_BINANCE_USDM_BASE_URL,
    symbol: process.env.GLITCH_BINANCE_USDM_SYMBOL,
    timeoutMs: optionalBoundedInteger(
      process.env.GLITCH_BINANCE_USDM_TIMEOUT_MS,
      100,
      120_000,
      10_000,
      "Binance timeout milliseconds",
    ),
  });
  const evidence = new JsonlBinanceStreamEvidenceSink(evidencePath, {
    maxBytes: optionalBoundedInteger(
      process.env.GLITCH_BINANCE_USDM_EVIDENCE_MAX_BYTES,
      1_024,
      512 * 1024 * 1024,
      32 * 1024 * 1024,
      "evidence maximum bytes",
    ),
  });
  const supervisor = new BinanceUsdmStreamSupervisor(client, null, {
    symbol: process.env.GLITCH_BINANCE_USDM_SYMBOL,
    streamsBaseUrl: process.env.GLITCH_BINANCE_USDM_STREAMS_URL,
    evidence,
  });

  await supervisor.start(false);
  await delay(durationSeconds * 1_000);
  const finalStatus = await supervisor.stop();
  const report = writeBinancePublicEvidenceManifest(
    evidencePath,
    `${evidencePath}.manifest.json`,
    { minimumMessages },
  );
  console.log(JSON.stringify({
    command,
    duration_seconds: durationSeconds,
    evidence_path: evidencePath,
    final_status: finalStatus,
    report,
  }, null, 2));
  if (!report.accepted_for_public_replay) {
    process.exitCode = 1;
  }
} else if (command === "verify-public") {
  const report = verifyBinancePublicEvidence(evidencePath, { minimumMessages });
  console.log(JSON.stringify(report, null, 2));
  if (!report.accepted_for_public_replay) {
    process.exitCode = 1;
  }
} else {
  throw new Error(
    "Usage: npm run binance:evidence -- <capture-public [seconds] [path]|verify-public [path]>",
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
