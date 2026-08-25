import { BinanceUsdmShadowClient } from "./shadow-client.js";
import { BinanceUsdmTestnetPreflight } from "./testnet-preflight.js";

const client = new BinanceUsdmShadowClient({
  baseUrl: process.env.GLITCH_BINANCE_USDM_BASE_URL ?? "https://demo-fapi.binance.com",
  symbol: process.env.GLITCH_BINANCE_USDM_SYMBOL ?? "BTCUSDT",
  apiKey: process.env.GLITCH_BINANCE_USDM_API_KEY,
  apiSecret: process.env.GLITCH_BINANCE_USDM_API_SECRET,
  recvWindow: optionalInteger(process.env.GLITCH_BINANCE_USDM_RECV_WINDOW_MS),
  timeoutMs: optionalInteger(process.env.GLITCH_BINANCE_USDM_TIMEOUT_MS),
});

try {
  const preflight = new BinanceUsdmTestnetPreflight(
    client,
    optionalInteger(process.env.GLITCH_BINANCE_USDM_MAX_LEVERAGE) ?? 3,
  );
  const report = await preflight.run();
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "ready") {
    process.exitCode = 2;
  }
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
