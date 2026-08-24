import test from "node:test";
import assert from "node:assert/strict";
import { dailyTargetProfitCents, usablePot } from "../src/core/risk-engine.js";
import { DEFAULT_RISK_POLICY, mergePublicPolicy } from "../src/domain/policy.js";

 test("0.5% daily lock scales with the usable pot", () => {
  assert.equal(dailyTargetProfitCents(10_000, null, 50), 50);
  assert.equal(dailyTargetProfitCents(100_000, null, 50), 500);
  assert.equal(dailyTargetProfitCents(1_000_000, null, 50), 5_000);
});

test("usable balance limit caps policy calculations without changing equity", () => {
  assert.equal(usablePot(100_000, null), 100_000);
  assert.equal(usablePot(100_000, 50_000), 50_000);
  assert.equal(dailyTargetProfitCents(100_000, 50_000, 50), 250);
});

test("public policy patch keeps target separate from trade geometry", () => {
  const next = mergePublicPolicy(DEFAULT_RISK_POLICY, {
    daily_lock_target_pct: 0.75,
    usable_balance_limit_usd: 500,
  });
  assert.equal(next.dailyLockTargetBps, 75);
  assert.equal(next.usableBalanceLimitCents, 50_000);
  assert.equal(next.maxTradeRiskBps, DEFAULT_RISK_POLICY.maxTradeRiskBps);
});
