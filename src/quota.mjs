// The account's allowance, read from the relay's OpenAI-style billing routes.
//
// eazydata is an one-api / new-api style relay. It sends no `x-quota-*` headers
// (not on /v1/models, not on /v1/chat/completions), so nothing about the
// allowance can be read from a normal response. What it does expose, to the
// signed-in key, is the OpenAI billing pair:
//
//   GET /v1/dashboard/billing/subscription
//     { object:"billing_subscription", hard_limit_usd: 100.003142,
//       soft_limit_usd: 100.003142, has_payment_method: true, access_until: 0 }
//
//   GET /v1/dashboard/billing/usage            (date params are ignored — the
//     { object:"list", total_usage: 4.4232 }   figure is cumulative)
//
// The allowance is a **dollar balance**, not a token bucket: `hard_limit_usd`
// is the ceiling in dollars, and `total_usage` is the spend so far **in cents**
// (4.4232 → $0.044232). There is no daily reset — `access_until: 0` means no
// expiry — so the window is an all-time balance and `resetsAt` is left out.
//
// Nothing here is invented: missing or unreadable figures leave the window
// without a percentage (magpie shows "unknown"), never a made-up 0%.

export const DAY_S = 86400;

// The balance is cumulative, so its span is large; magpie uses `span` only to
// describe how far the window looks back. Ten years reads as "all time".
export const BALANCE_SPAN_S = 10 * 365 * DAY_S;

const round2 = (n) => Math.round(n * 100) / 100;

// A finite non-negative number from a JSON value, or null.
function num(value) {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// A billing subscription's dollar limit, from either the top level or a
// wrapped `data` object. `hard_limit_usd` is the ceiling; `soft_limit_usd`
// falls back when the hard one is missing or zero (some relays send -1/0 for
// "unlimited", which is not a usable ceiling and is treated as unknown).
export function limitOf(subscription) {
  const body = subscription?.data ?? subscription;
  if (!body || typeof body !== "object") return null;
  for (const key of ["hard_limit_usd", "system_hard_limit_usd", "soft_limit_usd"]) {
    const n = num(body[key]);
    if (n !== null && n > 0) return n;
  }
  return null;
}

// The cumulative spend, converted from one-api's cents into dollars. A body
// that already looks like dollars (a value under a dollar-scale limit supplied
// alongside) is not re-divided: the conversion only leans on the documented
// "cents" convention and is applied once.
export function spentOf(usage) {
  const body = usage?.data ?? usage;
  if (!body || typeof body !== "object") return null;
  const cents = num(body.total_usage);
  if (cents === null) return null;
  // Dollars, kept to sub-cent precision: the relay reports cents (4.4232 →
  // $0.044232), and rounding the dollar result to 6 places drops binary noise.
  return Math.round(cents * 10000) / 1_000_000;
}

// One window for the dollar balance, or undefined when the relay reported
// nothing usable. `used` is a percentage; it is left out — never written as 0 —
// when either the limit or the spend is unknown.
export function balanceWindow(subscription, usage) {
  const limit = limitOf(subscription);
  const spent = spentOf(usage);
  if (limit === null && spent === null) return undefined;

  const window = {
    name: "Balance",
    span: BALANCE_SPAN_S,
    unit: "usd",
  };
  if (limit !== null) window.limit = round2(limit);
  if (spent !== null) window.amount = round2(spent);
  if (limit !== null && spent !== null) {
    if (limit > 0) {
      window.used = (100 * spent) / limit; // over 100 if a balance went negative
      window.display = `$${round2(Math.max(0, limit - spent))} left of $${round2(limit)}`;
    }
  } else if (spent !== null) {
    window.display = `$${round2(spent)} spent; the limit was not reported`;
  } else {
    window.display = `$${round2(limit)} limit; the spend was not reported`;
  }
  return window;
}

// The plan name magpie shows. The relay reports no tier name, only a balance.
export function planOf(window) {
  return window ? "eazydata" : "eazydata";
}
