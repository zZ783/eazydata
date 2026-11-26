import test from "node:test";
import assert from "node:assert/strict";

import { quotaWindow, planOf, resetInstant, nextUtcMidnight } from "../src/quota.mjs";

const headers = (pairs) => new Headers(pairs);

test("quotaWindow reads the quota headers into one window", () => {
  const now = Date.parse("2026-11-25T10:00:00Z");
  const w = quotaWindow(
    headers({
      "x-quota-limit": "100000000",
      "x-quota-used": "25000000",
      "x-quota-remaining": "75000000",
      "x-quota-reset": "2026-11-26T00:00:00Z",
    }),
    now,
  );
  assert.equal(w.name, "Plan allowance");
  assert.equal(w.span, 86400);
  assert.equal(w.unit, "tokens");
  assert.equal(w.limit, 100_000_000);
  assert.equal(w.amount, 25_000_000);
  assert.equal(w.used, 25);
  assert.equal(w.resetsAt, "2026-11-26T00:00:00.000Z");
});

test("quotaWindow derives the spend from limit and remaining", () => {
  const w = quotaWindow(
    headers({ "x-quota-limit": "2000000", "x-quota-remaining": "500000" }),
    Date.parse("2026-11-25T10:00:00Z"),
  );
  assert.equal(w.limit, 2_000_000);
  assert.equal(w.amount, 1_500_000);
  assert.equal(w.used, 75);
});

test("quotaWindow leaves used out rather than reporting zero when the spend is unknown", () => {
  const w = quotaWindow(headers({ "x-quota-limit": "100000000" }));
  assert.equal(w.limit, 100_000_000);
  assert.equal("used" in w, false);
  assert.equal(w.amount, undefined);
  assert.match(w.display, /100,000,000 tokens/);
});

test("quotaWindow reports a spend without a limit as a display line, not a percentage", () => {
  const w = quotaWindow(headers({ "x-quota-used": "1234" }));
  assert.equal("used" in w, false);
  assert.equal(w.amount, 1234);
  assert.match(w.display, /1,234 tokens used/);
});

test("quotaWindow says nothing when the response said nothing", () => {
  assert.equal(quotaWindow(headers({ "x-qos": "full" })), undefined);
});

test("quotaWindow allows the percentage to pass 100 once the allowance is spent", () => {
  const w = quotaWindow(headers({ "x-quota-limit": "1000", "x-quota-used": "1500" }));
  assert.equal(w.used, 150);
});

test("quotaWindow ignores unreadable counts instead of turning them into zero", () => {
  const w = quotaWindow(headers({ "x-quota-limit": "lots", "x-quota-used": "10" }));
  assert.equal(w.limit, undefined);
  assert.equal(w.amount, 10);
  assert.equal("used" in w, false);
});

test("resetInstant falls back to the next 00:00 UTC", () => {
  const now = Date.parse("2026-11-25T23:59:59Z");
  assert.equal(resetInstant(undefined, now).toISOString(), "2026-11-26T00:00:00.000Z");
  assert.equal(resetInstant("not a date", now).toISOString(), "2026-11-26T00:00:00.000Z");
  assert.equal(resetInstant("2026-11-27T00:00:00Z", now).toISOString(), "2026-11-27T00:00:00.000Z");
});

test("nextUtcMidnight always moves forward", () => {
  assert.equal(nextUtcMidnight(Date.parse("2026-11-25T00:00:00Z")).toISOString(), "2026-11-26T00:00:00.000Z");
  assert.equal(nextUtcMidnight(Date.parse("2026-11-25T00:00:01Z")).toISOString(), "2026-11-26T00:00:00.000Z");
});

test("planOf names the relay", () => {
  assert.equal(planOf({ limit: 1 }), "eazydata");
  assert.equal(planOf(undefined), "eazydata");
});
