import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSignedBinanceQuery,
  encodeBinanceQuery,
  signBinanceQuery,
} from "../src/venue/binance-usdm/query.js";
import {
  assertProviderEvidenceIsSecretFree,
  redactProviderEvidence,
} from "../src/venue/binance-usdm/redaction.js";

test("Binance query encoding and HMAC signing are deterministic", () => {
  const query = encodeBinanceQuery({ timestamp: 1_700_000_000_000, symbol: "BTCUSDT", recvWindow: 5_000 });
  assert.equal(query, "recvWindow=5000&symbol=BTCUSDT&timestamp=1700000000000");
  assert.equal(
    signBinanceQuery("test-secret", query),
    "0d90f16f7356bb8fcf3ca4e5d43d1a9768d14daa3720f9e22788780ce8cf6c7a",
  );
  assert.equal(
    buildSignedBinanceQuery({ symbol: "BTCUSDT" }, "test-secret", 1_700_000_000_000),
    `${query}&signature=0d90f16f7356bb8fcf3ca4e5d43d1a9768d14daa3720f9e22788780ce8cf6c7a`,
  );
});

test("provider evidence recursively removes credentials and signed query values", () => {
  const redacted = redactProviderEvidence({
    apiKey: "key-value",
    nested: {
      message: "https://example.test/path?signature=abc123&symbol=BTCUSDT",
      safe: "key-value must not survive",
    },
  }, ["key-value"]);
  const serialized = JSON.stringify(redacted);
  assert.match(serialized, /\[REDACTED\]/);
  assert.equal(serialized.includes("key-value"), false);
  assert.equal(serialized.includes("abc123"), false);
  assertProviderEvidenceIsSecretFree(redacted, ["key-value", "abc123"]);
});
