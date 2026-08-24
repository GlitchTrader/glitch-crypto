import { BinanceUsdmShadowClient } from "./shadow-client.js";

const [command = "capture-public"] = process.argv.slice(2);
const client = new BinanceUsdmShadowClient({
  baseUrl: process.env.GLITCH_BINANCE_USDM_BASE_URL,
  symbol: process.env.GLITCH_BINANCE_USDM_SYMBOL,
  apiKey: process.env.GLITCH_BINANCE_USDM_API_KEY,
  apiSecret: process.env.GLITCH_BINANCE_USDM_API_SECRET,
  recvWindow: optionalInteger(process.env.GLITCH_BINANCE_USDM_RECV_WINDOW_MS),
  timeoutMs: optionalInteger(process.env.GLITCH_BINANCE_USDM_TIMEOUT_MS),
});

try {
  const result = command === "capture-public"
    ? await client.capture(false)
    : command === "capture-account"
      ? await client.capture(true)
      : command === "rules"
        ? (await client.publicSnapshot()).symbol_rules
        : undefined;
  if (result === undefined) {
    throw new Error("Usage: npm run binance:shadow -- <capture-public|capture-account|rules>");
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
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
