import test from "node:test";
import assert from "node:assert/strict";

import { limitOf, spentOf, balanceWindow, planOf, BALANCE_SPAN_S } from "../src/quota.mjs";

test("limitOf reads the dollar ceiling from a subscription", () => {
  assert.equal(limitOf({ hard_limit_usd: 100.003142, soft_limit_usd: 100.003142 }), 100.003142);
});

test("limitOf ignores a zero or negative hard limit and falls back", () => {
  assert.equal(limitOf({ hard_limit_usd: 0, soft_limit_usd: 50 }), 50);
  assert.equal(limitOf({ hard_limit_usd: -1 }), null);
  assert.equal(limitOf({}), null);
  assert.equal(limitOf(null), null);
});

test("limitOf unwraps a data wrapper", () => {
  assert.equal(limitOf({ data: { hard_limit_usd: 20 } }), 20);
});

test("spentOf converts one-api cents into dollars", () => {
  assert.equal(spentOf({ total_usage: 4.4232 }), 0.044232);
  assert.equal(spentOf({ total_usage: 0 }), 0);
  assert.equal(spentOf({}), null);
  assert.equal(spentOf(null), null);
});

test("spentOf unwraps a data wrapper", () => {
  assert.equal(spentOf({ data: { total_usage: 100 } }), 1);
});

test("balanceWindow turns the two routes into a dollar window with a percentage", () => {
  const w = balanceWindow({ hard_limit_usd: 100 }, { total_usage: 442.32 }); // 442.32c = $4.4232
  assert.equal(w.name, "Balance");
  assert.equal(w.unit, "usd");
  assert.equal(w.span, BALANCE_SPAN_S);
  assert.equal(w.limit, 100);
  assert.equal(w.amount, 4.42);
  assert.equal(Math.round(w.used * 1000) / 1000, 4.423);
  assert.match(w.display, /\$95\.58 left of \$100/);
  // A cumulative balance has no reset instant.
  assert.equal("resetsAt" in w, false);
});

test("balanceWindow derives the spend from a real account shape", () => {
  const w = balanceWindow(
    { hard_limit_usd: 100.003142, soft_limit_usd: 100.003142 },
    { total_usage: 4.4232 },
  );
  assert.equal(w.limit, 100);
  assert.equal(w.amount, 0.04);
  assert.ok(w.used > 0 && w.used < 0.1);
});

test("balanceWindow leaves used out when the spend is unknown", () => {
  const w = balanceWindow({ hard_limit_usd: 100 }, null);
  assert.equal(w.limit, 100);
  assert.equal("used" in w, false);
  assert.equal(w.amount, undefined);
  assert.match(w.display, /\$100 limit/);
});

test("balanceWindow leaves used out when the limit is unknown", () => {
  const w = balanceWindow(null, { total_usage: 500 });
  assert.equal("used" in w, false);
  assert.equal(w.amount, 5);
  assert.match(w.display, /\$5 spent/);
});

test("balanceWindow says nothing when both routes said nothing", () => {
  assert.equal(balanceWindow(null, null), undefined);
});

test("balanceWindow allows the percentage to pass 100 on a negative balance", () => {
  const w = balanceWindow({ hard_limit_usd: 10 }, { total_usage: 1500 }); // $15 spent of $10
  assert.equal(w.used, 150);
  assert.match(w.display, /\$0 left of \$10/);
});

test("planOf names the relay", () => {
  assert.equal(planOf({ limit: 1 }), "eazydata");
  assert.equal(planOf(undefined), "eazydata");
});
