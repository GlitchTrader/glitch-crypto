import { loadConfig } from "./config.js";
import { TradingEngine } from "./core/trading-engine.js";
import { GlitchDatabase } from "./storage/database.js";
import { PaperVenue } from "./venue/paper-venue.js";
import { startServer } from "./api/server.js";

const config = loadConfig();
const database = new GlitchDatabase(
  config.databasePath,
  config.initialEquityCents,
  config.initialMarkPriceCents,
);
database.setGatewayMode(config.gatewayMode);
const engine = new TradingEngine(database, new PaperVenue());
const server = await startServer(engine, config);
console.log(`Glitch Crypto listening on ${config.host}:${server.port} in ${config.gatewayMode} mode.`);

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}; stopping HTTP server.`);
  await server.close();
  database.close();
}

process.on("SIGINT", () => {
  void shutdown("SIGINT").then(() => { process.exitCode = 0; });
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM").then(() => { process.exitCode = 0; });
});
