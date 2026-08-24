import { resolve } from "node:path";
import { BinanceUsdmListenKeyClient } from "./listen-key-client.js";
import { JsonlBinanceStreamEvidenceSink } from "./stream-evidence.js";
import { readBinanceStreamEvidenceJsonl, replayBinanceStreamEvidence } from "./stream-replay.js";
import { BinanceUsdmShadowClient } from "./shadow-client.js";
import { BinanceUsdmStreamSupervisor } from "./stream-supervisor.js";

const [command = "public", argument] = process.argv.slice(2);

if (command === "replay") {
  const path = resolve(argument ?? process.env.GLITCH_BINANCE_USDM_EVIDENCE_PATH ?? "./data/binance-usdm-stream.jsonl");
  console.log(JSON.stringify(replayBinanceStreamEvidence(readBinanceStreamEvidenceJsonl(path)), null, 2));
} else if (command === "public" || command === "account") {
  const apiKey = (process.env.GLITCH_BINANCE_USDM_API_KEY ?? "").trim();
  const apiSecret = (process.env.GLITCH_BINANCE_USDM_API_SECRET ?? "").trim();
  const evidencePath = resolve(
    process.env.GLITCH_BINANCE_USDM_EVIDENCE_PATH ?? "./data/binance-usdm-stream.jsonl",
  );
  const client = new BinanceUsdmShadowClient({
    baseUrl: process.env.GLITCH_BINANCE_USDM_BASE_URL,
    symbol: process.env.GLITCH_BINANCE_USDM_SYMBOL,
    apiKey,
    apiSecret,
    recvWindow: optionalInteger(process.env.GLITCH_BINANCE_USDM_RECV_WINDOW_MS),
    timeoutMs: optionalInteger(process.env.GLITCH_BINANCE_USDM_TIMEOUT_MS),
  });
  const listenKey = command === "account"
    ? new BinanceUsdmListenKeyClient({
        baseUrl: process.env.GLITCH_BINANCE_USDM_BASE_URL,
        apiKey,
        timeoutMs: optionalInteger(process.env.GLITCH_BINANCE_USDM_TIMEOUT_MS),
      })
    : null;
  const evidence = new JsonlBinanceStreamEvidenceSink(evidencePath, {
    forbiddenValues: [apiKey, apiSecret],
    maxBytes: optionalInteger(process.env.GLITCH_BINANCE_USDM_EVIDENCE_MAX_BYTES),
  });
  const supervisor = new BinanceUsdmStreamSupervisor(client, listenKey, {
    symbol: process.env.GLITCH_BINANCE_USDM_SYMBOL,
    streamsBaseUrl: process.env.GLITCH_BINANCE_USDM_STREAMS_URL,
    evidence,
  });

  await supervisor.start(command === "account");
  console.log(JSON.stringify({
    status: "started",
    mode: command,
    mutation_authority: false,
    evidence_path: evidencePath,
  }, null, 2));

  const statusTimer = setInterval(() => {
    console.log(JSON.stringify(supervisor.status()));
  }, 30_000);

  const stop = async (signal: string): Promise<void> => {
    clearInterval(statusTimer);
    await supervisor.stop();
    console.log(JSON.stringify({ status: "stopped", signal }));
  };
  process.on("SIGINT", () => {
    void stop("SIGINT").then(() => { process.exitCode = 0; });
  });
  process.on("SIGTERM", () => {
    void stop("SIGTERM").then(() => { process.exitCode = 0; });
  });
} else {
  throw new Error("Usage: npm run binance:stream -- <public|account|replay> [evidence.jsonl]");
}

function optionalInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("Binance numeric environment settings must be safe integers");
  }
  return parsed;
}
