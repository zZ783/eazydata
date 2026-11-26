import test from "node:test";
import assert from "node:assert/strict";

import { EazyDataPlugin, PROVIDER, BASE, ORIGIN, LINES, keyOf } from "../src/index.mjs";
import { DEFAULT_MODEL } from "../src/models.mjs";

const SUBSCRIPTION = { object: "billing_subscription", hard_limit_usd: 100.003142, soft_limit_usd: 100.003142, access_until: 0 };
const USAGE = { object: "list", total_usage: 4.4232 };

// A fetch double that records what was sent and answers with a scripted reply.
function recorder(reply) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const call = { url: String(url), init };
    calls.push(call);
    return typeof reply === "function" ? reply(call) : reply;
  };
  return { calls, fetchImpl };
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const account = { type: "api", key: "sk-test-key" };

test("keyOf reads every shape magpie stores a key in", () => {
  assert.equal(keyOf({ type: "api", key: "sk-a" }), "sk-a");
  assert.equal(keyOf({ type: "api", key: "  sk-a  " }), "sk-a");
  assert.equal(keyOf({ apiKey: "sk-b" }), "sk-b");
  assert.equal(keyOf({ access: "sk-c" }), "sk-c");
  assert.equal(keyOf({ methods: [{ key: "sk-d" }] }), "sk-d");
  assert.equal(keyOf({ type: "api", key: "sk-e" }), "sk-e");
  assert.equal(keyOf(null), "");
  assert.equal(keyOf({}), "");
  assert.equal(keyOf({ key: 42 }), "");
});

test("the advertised lines are all present and the main one is the default base", () => {
  assert.equal(LINES.main, BASE);
  assert.equal(BASE, `${ORIGIN}/v1`);
  assert.equal(LINES.upload, "https://upload.eazydata.org/v1");
  assert.equal(LINES.china, "https://cn.eazydata.org/v1");
  assert.equal(LINES.backup, "https://zzz.kkpliu.top/v1");
});

test("config declares the provider once and never overwrites the user's own", async () => {
  const plugin = await EazyDataPlugin({}, { fetchImpl: async () => json({}) });

  const fresh = {};
  await plugin.config(fresh);
  assert.equal(fresh.provider[PROVIDER].npm, "@ai-sdk/openai-compatible");
  assert.equal(fresh.provider[PROVIDER].api, BASE);
  assert.ok(fresh.provider[PROVIDER].models[DEFAULT_MODEL]);

  const mine = { provider: { [PROVIDER]: { name: "mine", models: {} } } };
  await plugin.config(mine);
  assert.equal(mine.provider[PROVIDER].name, "mine");
});

test("the base URL can be switched to a backup line", async () => {
  const plugin = await EazyDataPlugin({}, { fetchImpl: async () => json({}), baseURL: LINES.china });
  const fresh = {};
  await plugin.config(fresh);
  assert.equal(fresh.provider[PROVIDER].api, LINES.china);
});

test("auth names the provider, its concurrency and its icon", async () => {
  const plugin = await EazyDataPlugin({}, { fetchImpl: async () => json({}) });
  assert.equal(plugin.auth.provider, PROVIDER);
  assert.equal(plugin.auth.maxConcurrency, 8);
  assert.equal(plugin.auth.icon, `${ORIGIN}/favicon.svg`);
  assert.equal(plugin.auth.methods[0].type, "api");
  assert.equal(plugin.auth.checkin, undefined);
});

test("the key is asked for through a prompt, so magpie hands it to authorize", async () => {
  const plugin = await EazyDataPlugin({}, { fetchImpl: async () => json({}) });
  const [method] = plugin.auth.methods;
  assert.ok(Array.isArray(method.prompts) && method.prompts.length >= 1);
  const keyPrompt = method.prompts.find((p) => p.key === "key");
  assert.ok(keyPrompt, "there is a prompt that submits `key`");
  assert.equal(typeof keyPrompt.validate, "function");
  assert.match(keyPrompt.validate("   "), /required/i);
  assert.match(keyPrompt.validate("sk-a\r\nb"), /line break/i);
  assert.equal(keyPrompt.validate("sk-ok"), undefined);
});

test("the sign-in check accepts a working key and remembers the allowance it saw", async () => {
  const { calls, fetchImpl } = recorder(json({ object: "list", data: [] }));
  const plugin = await EazyDataPlugin({}, { fetchImpl });
  const out = await plugin.auth.methods[0].authorize({ key: " sk-good " });
  assert.equal(out.type, "success");
  assert.equal(out.key, "sk-good");
  assert.equal(calls[0].url, `${BASE}/models`);
  assert.equal(calls[0].init.headers.authorization, "Bearer sk-good");
});

test("the sign-in check refuses a key the service rejected", async () => {
  const plugin = await EazyDataPlugin({}, {
    fetchImpl: async () => json({ error: { message: "invalid_api_key" } }, 401),
  });
  const out = await plugin.auth.methods[0].authorize({ key: "sk-bad" });
  assert.equal(out.type, "failed");
  assert.match(out.error, /invalid_api_key/);
});

test("the sign-in check refuses an empty key without asking the service", async () => {
  const { calls, fetchImpl } = recorder(json({}));
  const plugin = await EazyDataPlugin({}, { fetchImpl });
  const out = await plugin.auth.methods[0].authorize({ key: "   " });
  assert.equal(out.type, "failed");
  assert.equal(calls.length, 0);
});

test("the sign-in check keeps the key when the service cannot be reached", async () => {
  const plugin = await EazyDataPlugin({}, {
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });
  const out = await plugin.auth.methods[0].authorize({ key: "sk-unreachable" });
  assert.equal(out.type, "success");
  assert.equal(out.key, "sk-unreachable");
});

test("the loader hands out the base URL, the account's key and a guarded fetch", async () => {
  const { calls, fetchImpl } = recorder(json({ choices: [] }));
  const plugin = await EazyDataPlugin({}, { fetchImpl });
  const loader = await plugin.auth.loader(async () => account);
  assert.equal(loader.baseURL, BASE);
  assert.equal(loader.apiKey, "sk-test-key");

  await loader.fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer someone-else" },
    body: JSON.stringify({ model: "gpt-4o", messages: [] }),
  });
  const sent = calls[0];
  assert.equal(sent.url, `${BASE}/chat/completions`);
  // The account's key wins over whatever was passed in.
  assert.equal(sent.init.headers.get("authorization"), "Bearer sk-test-key");
  assert.equal(sent.init.headers.get("content-type"), "application/json");
  assert.equal(sent.init.method, "POST");
});

test("the loader sends nothing when no account is signed in", async () => {
  const plugin = await EazyDataPlugin({}, { fetchImpl: async () => json({}) });
  assert.deepEqual(await plugin.auth.loader(async () => undefined), {});
});

test("a request is rebuilt on the plugin's own origin", async () => {
  const { calls, fetchImpl } = recorder(json({ ok: true }));
  const plugin = await EazyDataPlugin({}, { fetchImpl });
  const loader = await plugin.auth.loader(async () => account);
  await loader.fetch("https://elsewhere.example/v1/chat/completions?trace=1", { method: "POST", body: "{}" });
  assert.equal(calls[0].url, `${BASE}/chat/completions?trace=1`);
});

test("a spent balance 429 gets a Retry-After when the relay sent none", async () => {
  const body = { error: { message: "insufficient quota", code: "quota_exceeded" } };
  const plugin = await EazyDataPlugin({}, { fetchImpl: async () => json(body, 429) });
  const loader = await plugin.auth.loader(async () => account);
  const res = await loader.fetch(`${BASE}/chat/completions`, { method: "POST", body: "{}" });
  assert.equal(res.status, 429);
  // No reset instant for a cumulative balance: a moderate, honest rest.
  assert.equal(res.headers.get("retry-after"), "3600");
  assert.equal((await res.json()).error.code, "quota_exceeded");
});

test("a concurrency 429 keeps the service's own short Retry-After", async () => {
  const plugin = await EazyDataPlugin({}, {
    fetchImpl: async () => json({ error: { code: "rate_limit_exceeded", message: "too many requests" } }, 429, {
      "retry-after": "2",
    }),
  });
  const loader = await plugin.auth.loader(async () => account);
  const res = await loader.fetch(`${BASE}/chat/completions`, { method: "POST", body: "{}" });
  assert.equal(res.headers.get("retry-after"), "2");
});

test("other failures pass through untouched", async () => {
  const plugin = await EazyDataPlugin({}, {
    fetchImpl: async () => json({ error: { code: "model_not_found" } }, 404),
  });
  const loader = await plugin.auth.loader(async () => account);
  const res = await loader.fetch(`${BASE}/chat/completions`, { method: "POST", body: "{}" });
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("retry-after"), null);
});

test("usage reads the dollar balance from the relay's billing routes", async () => {
  const { calls, fetchImpl } = recorder((call) => {
    if (call.url.endsWith("/dashboard/billing/subscription")) return json(SUBSCRIPTION);
    if (call.url.endsWith("/dashboard/billing/usage")) return json(USAGE);
    return json({});
  });
  const plugin = await EazyDataPlugin({}, { fetchImpl });
  const usage = await plugin.auth.usage(async () => account);
  assert.equal(usage.plan, "eazydata");
  assert.equal(usage.windows.length, 1);
  const [w] = usage.windows;
  assert.equal(w.unit, "usd");
  assert.equal(w.limit, 100);
  assert.equal(w.amount, 0.04);
  assert.ok(w.used > 0 && w.used < 0.1);
  assert.match(w.display, /\$99\.96 left of \$100/);
  assert.equal(usage.error, undefined);
  const urls = calls.map((c) => c.url).sort();
  assert.ok(urls.some((u) => u.endsWith("/dashboard/billing/subscription")));
  assert.ok(urls.some((u) => u.endsWith("/dashboard/billing/usage")));
});

test("usage marks the account when its key stopped working", async () => {
  const plugin = await EazyDataPlugin({}, {
    fetchImpl: async () => json({ error: { code: "invalid_api_key" } }, 401),
  });
  const usage = await plugin.auth.usage(async () => account);
  assert.equal(usage.signIn, "expired");
  assert.ok(usage.error);
});

test("usage shows an unknown balance rather than a made-up number", async () => {
  const plugin = await EazyDataPlugin({}, { fetchImpl: async () => json({ object: "list" }) });
  const usage = await plugin.auth.usage(async () => account);
  assert.equal(usage.windows.length, 1);
  assert.equal("used" in usage.windows[0], false);
  assert.equal(usage.windows[0].limit, undefined);
  assert.ok(usage.windows[0].display);
});

test("usage falls back to a balance an earlier read already saw", async () => {
  let mode = "ok";
  const plugin = await EazyDataPlugin({}, {
    fetchImpl: async (url) => {
      if (mode === "down") throw new TypeError("fetch failed");
      if (String(url).endsWith("/dashboard/billing/subscription")) return json(SUBSCRIPTION);
      if (String(url).endsWith("/dashboard/billing/usage")) return json(USAGE);
      return json({});
    },
  });
  const first = await plugin.auth.usage(async () => account);
  assert.equal(first.windows[0].limit, 100);
  mode = "down";
  const usage = await plugin.auth.usage(async () => account);
  assert.equal(usage.windows[0].limit, 100);
  assert.ok(usage.error);
});

test("usage says nothing when no account is signed in", async () => {
  const plugin = await EazyDataPlugin({}, { fetchImpl: async () => json({}) });
  assert.deepEqual(await plugin.auth.usage(async () => undefined), {});
});

test("the models hook offers what the account can actually use", async () => {
  const listing = { object: "list", data: [{ id: "gpt-4o" }, { id: "claude-3.5-sonnet" }] };
  const plugin = await EazyDataPlugin({}, { fetchImpl: async () => json(listing) });
  const before = { [DEFAULT_MODEL]: { name: "already here" } };
  const models = await plugin.provider.models({ models: before }, { auth: account });
  assert.deepEqual(Object.keys(models).sort(), ["claude-3.5-sonnet", "gpt-4o"]);
  assert.equal(models["gpt-4o"].api.id, "gpt-4o");
});

test("the models hook keeps the list it has when the read fails", async () => {
  const plugin = await EazyDataPlugin({}, {
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });
  const before = { [DEFAULT_MODEL]: { name: "already here" } };
  assert.equal(await plugin.provider.models({ models: before }, { auth: account }), before);
});

test("the models hook keeps the list it has when there is no account", async () => {
  const plugin = await EazyDataPlugin({}, { fetchImpl: async () => json({}) });
  const before = { [DEFAULT_MODEL]: { name: "already here" } };
  assert.equal(await plugin.provider.models({ models: before }), before);
});
