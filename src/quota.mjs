// The plan allowance, read from the quota headers.
//
// eazydata documents no JSON route that reports an account's usage; the relay
// follows the common OpenAI-compatible convention of describing it in
// `x-quota-*` response headers (limit / used / remaining / reset). When those
// headers are present they are the source of truth; when they are absent — an
// upstream that sends none — nothing here invents a number, and the window is
// left without a percentage so magpie shows "unknown" rather than 0%.
//
// The allowance is not assumed to be a daily token bucket either: the reset
// instant carried in `x-quota-reset` decides the period, and the unit follows
// what the headers report. When nothing is said, it is a per-day token window
// that resets at the next 00:00 UTC, which is the convention this relay family
// uses.

export const DAY_S = 86400; // magpie's UsageWindow.span unit is seconds, not ms
export const DAY_MS = 86_400_000;

// A header value as a whole count, or null when the API did not send one.
function count(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

export function nextUtcMidnight(now = Date.now()) {
  return new Date((Math.floor(now / DAY_MS) + 1) * DAY_MS);
}

// An ISO instant from x-quota-reset, or the next 00:00 UTC when it is absent
// or unreadable.
export function resetInstant(value, now = Date.now()) {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? new Date(at) : nextUtcMidnight(now);
}

// One window for the allowance period, or undefined when the response said
// nothing about the allowance. `used` is left out — never written as 0 — when
// the spend is unknown, because magpie reads a missing percentage as "unknown"
// and a 0 as "nothing used".
export function quotaWindow(headers, now = Date.now()) {
  const limit = count(headers.get("x-quota-limit"));
  const used = count(headers.get("x-quota-used"));
  const remaining = count(headers.get("x-quota-remaining"));
  if (limit === null && used === null && remaining === null) return undefined;

  const total = limit ?? (used !== null && remaining !== null ? used + remaining : null);
  const spent =
    used !== null ? used : total !== null && remaining !== null ? Math.max(0, total - remaining) : null;

  const window = {
    name: "Plan allowance",
    span: DAY_S,
    unit: "tokens",
    resetsAt: resetInstant(headers.get("x-quota-reset"), now).toISOString(),
  };
  if (total !== null) window.limit = total;
  if (spent !== null) window.amount = spent;
  if (total !== null && spent !== null) {
    if (total > 0) window.used = (100 * spent) / total; // over 100 when the allowance is spent
    // amount / limit / unit is what magpie renders; no display line needed.
  } else if (spent !== null) {
    window.display = `${spent.toLocaleString("en-US")} tokens used; the limit was not reported`;
  } else if (total !== null) {
    window.display = `${total.toLocaleString("en-US")} tokens; the spend was not reported`;
  } else {
    window.display = `${remaining.toLocaleString("en-US")} tokens left`;
  }
  return window;
}

// The plan name magpie shows on the account. The relay reports no tier name, so
// say what it is rather than guess a subscription.
export function planOf(window) {
  return window ? "eazydata" : "eazydata";
}
