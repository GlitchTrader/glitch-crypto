import test from "node:test";
import assert from "node:assert/strict";
import {
  binanceMarketStreamUrl,
  binancePrivateStreamUrl,
  normalizeBinanceStreamsBaseUrl,
} from "../src/venue/binance-usdm/stream-common.js";

test("Binance stream URLs use the current routed endpoint contract", () => {
  const origin = normalizeBinanceStreamsBaseUrl(
    "wss://fstream.binancefuture.com",
  );

  assert.equal(
    binanceMarketStreamUrl(origin, "public", ["btcusdt@depth@100ms"]),
    "wss://fstream.binancefuture.com/public/ws/btcusdt@depth@100ms",
  );
  assert.equal(
    binanceMarketStreamUrl(origin, "market", [
      "btcusdt@aggTrade",
      "btcusdt@markPrice@1s",
    ]),
    "wss://fstream.binancefuture.com/market/ws/btcusdt@aggTrade/btcusdt@markPrice@1s",
  );
  assert.equal(
    binancePrivateStreamUrl(origin, "key+/=?"),
    "wss://fstream.binancefuture.com/private/ws?listenKey=key%2B%2F%3D%3F&events=ORDER_TRADE_UPDATE/ACCOUNT_UPDATE/listenKeyExpired",
  );
});

test("Binance stream URL builders reject unroutable input", () => {
  assert.throws(
    () => normalizeBinanceStreamsBaseUrl("wss://fstream.binance.com/public"),
    /bare origin/,
  );
  assert.throws(
    () => binanceMarketStreamUrl("wss://fstream.binance.com", "market", []),
    /1-1024/,
  );
  assert.throws(
    () =>
      binanceMarketStreamUrl("wss://fstream.binance.com", "market", [
        "btcusdt@aggTrade?bad=1",
      ]),
    /invalid Binance stream name/,
  );
  assert.throws(
    () => binancePrivateStreamUrl("wss://fstream.binance.com", "  "),
    /listen key is required/,
  );
});
