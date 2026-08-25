import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { BinanceUsdmListenKeyClient } from "./listen-key-client.js";
import {
  requireBinanceUsdmTestnetStreamsOrigin,
  verifyBinancePrivateEvidence,
  writeBinancePrivateEvidenceManifest,
} from "./private-evidence.js";
import { redactProviderEvidence } from "./redaction.js";
import { JsonlBinanceStreamEvidenceSink } from "./stream-evidence.js";
import { BinanceUsdmShadowClient } from "./shadow-client.js";
import { BinanceUsdmStreamSupervisor } from "./stream-supervisor.js";
import { normalizeBinanceStreamsBaseUrl } from "./stream-common.js";
import { BinanceUsdmTestnetPreflight } from "./testnet-preflight.js";

const [command = "verify", argument, pathArgument] = process.argv.slice(2);
const evidencePath = resolve(
  pathArgument ??
    (command === "verify" ? argument : undefined) ??
    process.env.GLITCH_BINANCE_USDM_PRIVATE_EVIDENCE_PATH ??
    "./artifacts/binance-usdm-private.jsonl",
);
const minimumPrivateMessages = optionalBoundedInteger(
  process.env.GLITCH_BINANCE_USDM_PRIVATE_MIN_MESSAGES,
  1,
  1_000_000,
  1,
  "minimum private messages",
);

if (command === "capture") {
  const apiKey = requiredEnvironment("GLITCH_BINANCE_USDM_API_KEY");
  const apiSecret = requiredEnvironment("GLITCH_BINANCE_USDM_API_SECRET");
  const baseUrl = requiredEnvironment("GLITCH_BINANCE_USDM_BASE_URL");
  if (existsSync(evidencePath) || existsSync(`${evidencePath}.1`)) {
    throw new Error(
      `refusing to overwrite Binance private evidence at ${evidencePath}; choose a new path`,
    );
  }
  const durationSeconds = boundedInteger(
    argument === undefined ? 60 : Number(argument),
    5,
    300,
    "capture duration seconds",
  );
  const streamsBaseUrl = requireBinanceUsdmTestnetStreamsOrigin(
    normalizeBinanceStreamsBaseUrl(
      process.env.GLITCH_BINANCE_USDM_STREAMS_URL ??
        "wss://fstream.binancefuture.com",
    ),
  );
  const timeoutMs = optionalBoundedInteger(
    process.env.GLITCH_BINANCE_USDM_TIMEOUT_MS,
    100,
    60_000,
    10_000,
    "Binance timeout milliseconds",
  );
  const client = new BinanceUsdmShadowClient({
    baseUrl,
    symbol: process.env.GLITCH_BINANCE_USDM_SYMBOL,
    apiKey,
    apiSecret,
    recvWindow: optionalBoundedInteger(
      process.env.GLITCH_BINANCE_USDM_RECV_WINDOW_MS,
      1,
      60_000,
      5_000,
      "Binance receive window milliseconds",
    ),
    timeoutMs,
  });
  const preflight = await new BinanceUsdmTestnetPreflight(
    client,
    optionalBoundedInteger(
      process.env.GLITCH_BINANCE_USDM_MAX_LEVERAGE,
      1,
      125,
      3,
      "maximum Testnet leverage",
    ),
  ).run();
  if (preflight.status !== "ready") {
    throw new Error(
      `Binance private evidence preflight blocked: ${preflight.blockers.join(",")}`,
    );
  }
  const listenKey = new BinanceUsdmListenKeyClient({
    baseUrl,
    apiKey,
    timeoutMs,
  });
  const evidence = new JsonlBinanceStreamEvidenceSink(evidencePath, {
    forbiddenValues: [apiKey, apiSecret],
    maxBytes: optionalBoundedInteger(
      process.env.GLITCH_BINANCE_USDM_EVIDENCE_MAX_BYTES,
      1_024,
      512 * 1024 * 1024,
      32 * 1024 * 1024,
      "evidence maximum bytes",
    ),
  });
  const supervisor = new BinanceUsdmStreamSupervisor(client, listenKey, {
    symbol: process.env.GLITCH_BINANCE_USDM_SYMBOL,
    streamsBaseUrl,
    evidence,
  });
  let captureFailure: string | null = null;
  try {
    await supervisor.start(true);
    await delay(durationSeconds * 1_000);
  } catch (error) {
    captureFailure = safeError(error, [apiKey, apiSecret]);
  } finally {
    try {
      await supervisor.stop();
    } catch (error) {
      captureFailure ??= safeError(error, [apiKey, apiSecret]);
    }
  }
  const report = writeBinancePrivateEvidenceManifest(
    evidencePath,
    `${evidencePath}.manifest.json`,
    { minimumPrivateMessages },
  );
  console.log(
    JSON.stringify(
      {
        command,
        duration_seconds: durationSeconds,
        evidence_path: evidencePath,
        preflight: {
          status: preflight.status,
          environment: preflight.environment,
          symbol: preflight.symbol,
          blocker_count: preflight.blockers.length,
        },
        capture_failure: captureFailure,
        report,
      },
      null,
      2,
    ),
  );
  if (captureFailure !== null || !report.accepted_for_private_replay) {
    process.exitCode = 1;
  }
} else if (command === "verify") {
  const report = verifyBinancePrivateEvidence(evidencePath, {
    minimumPrivateMessages,
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.accepted_for_private_replay) {
    process.exitCode = 1;
  }
} else {
  throw new Error(
    "Usage: npm run binance:private-evidence -- <capture [seconds] [path]|verify [path]>",
  );
}

function requiredEnvironment(name: string): string {
  const value = (process.env[name] ?? "").trim();
  if (!value) {
    throw new Error(`${name} is required for authenticated private evidence`);
  }
  return value;
}

function safeError(error: unknown, secrets: readonly string[]): string {
  const message = error instanceof Error ? error.message : String(error);
  return String(redactProviderEvidence(message, secrets));
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
