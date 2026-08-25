import { startServer } from "./api/server.js";
import { loadConfig } from "./config.js";
import { BinanceShadowRuntime } from "./runtime/binance-shadow-runtime.js";
import { ShadowTradingEngine } from "./runtime/shadow-trading-engine.js";
import { GlitchDatabase } from "./storage/database.js";
import { PaperVenue } from "./venue/paper-venue.js";

const config = loadConfig();
const database = new GlitchDatabase(
  config.databasePath,
  config.initialEquityCents,
  config.initialMarkPriceCents,
);
database.setGatewayMode(config.gatewayMode);
const engine = new ShadowTradingEngine(database, new PaperVenue());
const runtimeMode = config.runtimeMode ?? "paper";
let shadowRuntime: BinanceShadowRuntime | null = null;

try {
  if (runtimeMode === "binance-shadow") {
    if (!config.binanceShadow) {
      throw new Error("Binance shadow runtime configuration is missing");
    }
    shadowRuntime = new BinanceShadowRuntime(engine, config.binanceShadow);
    engine.attachRuntime(shadowRuntime);
    await shadowRuntime.start();
  }

  const server = await startServer(engine, config);
  console.log(
    `Glitch Crypto listening on ${config.host}:${server.port}; gateway=${config.gatewayMode}; runtime=${runtimeMode}.`,
  );

  let stopping = false;
  async function shutdown(signal: string): Promise<void> {
    if (stopping) {
      return;
    }
    stopping = true;
    console.log(`Received ${signal}; stopping Glitch Crypto.`);
    if (shadowRuntime) {
      await shadowRuntime.stop();
    }
    await server.close();
    database.close();
  }

  process.on("SIGINT", () => {
    void shutdown("SIGINT").then(() => { process.exitCode = 0; });
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM").then(() => { process.exitCode = 0; });
  });
} catch (error) {
  if (shadowRuntime) {
    await shadowRuntime.stop();
  }
  database.close();
  throw error;
}
