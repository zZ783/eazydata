// The eazydata provider, as magpie's plugin host calls it.
//
// eazydata (https://eazydata.org) is an OpenAI-compatible relay: one base URL,
// one API key, and whatever models the account behind the key can reach.
// Two things make it need a plugin rather than a plain provider block:
//
//   - the model list is not fixed and not documented; it is read live from
//     `GET /v1/models` for the signed-in account, so a model added upstream
//     works without a new release of this plugin;
//   - the allowance is a dollar balance, told only by the relay's OpenAI-style
//     billing routes (`/v1/dashboard/billing/subscription` and `/usage`), so
//     `usage` has to call them — and must show "unknown" rather than a made-up
//     0% when they cannot be read.
//
// Everything else — base URL, key, request forwarding — is a normal API key
// provider. The relay has four advertised lines (主站 / 备用 zzz / 备用 cn /
// upload); the plugin uses the main line by default, and any of them can be
// selected with the `baseURL` option (or a providers.json override).

import { balanceWindow, planOf } from "./quota.mjs";
import { CHAT_SDK, DEFAULT_MODEL, configModels, accountModels, modelIDs } from "./models.mjs";

export const PROVIDER = "eazydata";
export const ORIGIN = "https://eazydata.org";
export const BASE = `${ORIGIN}/v1`;

// The relay's four advertised lines. The main one is the default; the others
// are documented so a user can switch to a backup line when the main one is
// slow or an upload is too large for it.
export const LINES = {
  main: BASE,
  backup: "https://zzz.kkpliu.top/v1",
  china: "https://cn.eazydata.org/v1",
  upload: "https://upload.eazydata.org/v1",
};

const TIMEOUT_MS = 15_000;

// The key an account was signed in with, however magpie stored it: an api
// account is {type:"api", key}, older multi-method accounts keep it per
// method, and a keyless-style account may only carry `access`.
export function keyOf(auth) {
  if (!auth || typeof auth !== "object") return "";
  const key = auth.key ?? auth.apiKey ?? auth.access ?? auth.methods?.[0]?.key ?? "";
  return typeof key === "string" ? key.trim() : "";
}

export async function EazyDataPlugin(input, options = {}) {
  const baseURL = String(options.baseURL ?? BASE).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const reasoning = options.reasoning === true;
  const timeout = Number.isFinite(options.timeoutMs) ? options.timeoutMs : TIMEOUT_MS;

  // The model table both hooks describe from. `config` publishes it; the
  // models hook starts from it.
  const template = configModels({ reasoning });

  // The newest balance any read reported, per account key. A fallback for
  // `usage` when its own read fails: keeping it under the key keeps two
  // signed-in keys from showing each other's spend.
  const seen = new Map();

  // One GET, parsed as JSON, with the account's key. Throws on a network or
  // HTTP failure so the caller can fall back rather than read garbage.
  async function getJSON(pathname, apiKey) {
    const res = await fetchImpl(`${baseURL}${pathname}`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`billing read returned HTTP ${res.status}`);
    return res.json();
  }

  // The account's dollar balance, from the two billing routes eazydata
  // (one-api / new-api style) exposes to the signed-in key. `undefined` when
  // neither route said anything usable.
  async function readBalance(apiKey) {
    const [subscription, usage] = await Promise.all([
      getJSON("/dashboard/billing/subscription", apiKey).catch(() => null),
      getJSON("/dashboard/billing/usage", apiKey).catch(() => null),
    ]);
    const window = balanceWindow(subscription, usage);
    if (window) seen.set(apiKey, { window, at: Date.now() });
    return { window, subscription, usage };
  }

  // Whether the key itself is dead, from a billing read that failed. A 401/403
  // is about the key, so the account is the one to fix.
  async function keyRejected(apiKey) {
    try {
      const res = await fetchImpl(`${baseURL}/dashboard/billing/subscription`, {
        headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(timeout),
      });
      return res.status === 401 || res.status === 403;
    } catch {
      return false;
    }
  }

  // A 429 that is the balance running out has no reset instant to wait for —
  // the balance is cumulative, not a daily bucket — so when the relay sends no
  // Retry-After, ask for a moderate rest rather than hammering a dead balance.
  // A user has to top up, which happens outside any window this plugin sees.
  async function spentBalance(res) {
    const text = await res.text().catch(() => "");
    const headers = new Headers(res.headers);
    if (!headers.get("retry-after")) headers.set("retry-after", String(3600));
    return new Response(text, { status: res.status, statusText: res.statusText, headers });
  }

  // Whether a 429 is the allowance running out (a long rest) rather than a
  // momentary concurrency limit (a short one). Only the former is worth
  // benching the key until reset; guessing wrongly would either hammer the
  // relay or park a working account for the rest of the day.
  async function isSpent(res) {
    const copy = res.clone();
    try {
      const body = await copy.json();
      const code = String(body?.error?.code ?? body?.error?.type ?? "");
      const message = String(body?.error?.message ?? "");
      return /quota|insufficient|balance|exceed/i.test(`${code} ${message}`);
    } catch {
      return false;
    }
  }

  return {
    async config(cfg) {
      cfg.provider ??= {};
      // ??= so a provider the user declared in providers.json or plugins.json
      // keeps its own name, models and options.
      cfg.provider[PROVIDER] ??= {
        name: "eazydata",
        npm: CHAT_SDK,
        api: baseURL,
        models: template,
      };
    },

    auth: {
      provider: PROVIDER,
      icon: `${ORIGIN}/favicon.svg`,
      // The relay admits several requests at once per key; pick a sane ceiling
      // so magpie queues rather than collecting 429s.
      maxConcurrency: 8,
      methods: [
        {
          type: "api",
          label: "eazydata API key",
          placeholder: "sk-…",
          // The key is collected through a prompt, so magpie hands it to
          // `authorize` as `inputs.key`. Without `prompts`, older hosts draw
          // their own key box and call `authorize` with no key at all, and
          // newer ones have nowhere to ask for one.
          prompts: [
            {
              type: "password",
              key: "key",
              message: "eazydata API key",
              placeholder: "sk-…",
              validate: (value) => {
                if (typeof value !== "string" || !value.trim()) return "An API key is required.";
                if (/[\r\n]/.test(value)) return "The key must not contain line breaks.";
                return undefined;
              },
            },
          ],
          // Checked before it is stored, so a typo fails at sign-in instead of
          // as a 401 in the middle of a chat. A network failure is not the
          // key's fault and must not refuse it.
          async authorize(inputs) {
            const given = typeof inputs === "string" ? inputs : (inputs?.key ?? inputs?.apiKey ?? inputs?.token ?? "");
            const key = typeof given === "string" ? given.trim() : "";
            if (!key) return { type: "failed", error: "An API key is required." };
            try {
              const res = await fetchImpl(`${baseURL}/models`, {
                headers: { authorization: `Bearer ${key}`, accept: "application/json" },
                redirect: "error",
                signal: AbortSignal.timeout(timeout),
              });
              if (res.status === 401 || res.status === 403) {
                const text = await res.text().catch(() => "");
                let message = "";
                try {
                  message = JSON.parse(text)?.error?.message ?? "";
                } catch {
                  /* not JSON: the status is the whole answer */
                }
                return {
                  type: "failed",
                  error: message || `The key was refused (HTTP ${res.status}). Check it on eazydata.org.`,
                };
              }
            } catch {
              // Unreachable right now: keep the key, let requests say so.
            }
            return { type: "success", key, metadata: {} };
          },
        },
      ],

      async loader(getAuth) {
        const auth = await getAuth();
        const apiKey = keyOf(auth);
        if (!apiKey) return {};

        return {
          baseURL,
          apiKey,
          async fetch(input, init) {
            const request = new Request(input, init);
            const url = new URL(request.url);
            // Rebuild on our own origin: a model-metadata URL from somewhere
            // else must not carry the key off to it.
            const path = url.pathname.startsWith("/v1/") ? url.pathname.slice(3) : url.pathname;
            const target = `${baseURL}${path}${url.search}`;

            const headers = new Headers(request.headers);
            for (const name of ["host", "authorization", "content-length", "connection", "accept-encoding"]) {
              headers.delete(name);
            }
            headers.set("authorization", `Bearer ${apiKey}`);
            if (!headers.get("accept")) headers.set("accept", "application/json");
            if (!headers.get("content-type") && request.method !== "GET" && request.method !== "HEAD") {
              headers.set("content-type", "application/json");
            }

            let body = init?.body;
            if (body === undefined || body === null) {
              body = request.body ? await request.text() : undefined;
            }

            const res = await fetchImpl(target, {
              method: request.method,
              headers,
              body,
              signal: init?.signal ?? request.signal,
              redirect: "error",
            });

            // A 429 that is the balance running out gets a working
            // Retry-After; a concurrency 429 keeps the relay's own short one.
            if (res.status === 429 && (await isSpent(res))) {
              return spentBalance(res);
            }

            return res;
          },
        };
      },

      async usage(getAuth) {
        const auth = await getAuth?.();
        const apiKey = keyOf(auth);
        if (!apiKey) return {};

        let window = null;
        let error = "";
        let signIn;
        try {
          const read = await readBalance(apiKey);
          window = read.window;
          if (!window && (await keyRejected(apiKey))) {
            // A 401/403 is about the key itself, so the account is to fix.
            signIn = "expired";
            error = "The API key is no longer accepted. Sign in again.";
          } else if (!window) {
            error = "The relay reported no balance.";
          }
        } catch (e) {
          error = `Could not read the balance: ${e?.message ?? e}`;
        }
        // A read that failed falls back to what an earlier read already saw,
        // still under this account's own key.
        window ??= seen.get(apiKey)?.window ?? null;

        const windows = [];
        if (window) {
          windows.push({ ...window });
        } else {
          // No figures at all: shown, never routed on (no `used`, no counts).
          windows.push({
            name: "Balance",
            span: 10 * 365 * 86400,
            unit: "usd",
            display: "The balance is read from the relay's billing routes; it appears once the account can be read.",
          });
        }
        return {
          plan: planOf(window),
          windows,
          ...(error ? { error } : {}),
          ...(signIn ? { signIn } : {}),
        };
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (!auth) return provider.models;
        const apiKey = keyOf(auth);
        if (!apiKey) return provider.models;
        try {
          const res = await fetchImpl(`${baseURL}/models`, {
            headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
            redirect: "error",
            signal: AbortSignal.timeout(timeout),
          });
          // The list is only usable when the account could read it.
          if (!res.ok) return provider.models;
          const ids = modelIDs(await res.json());
          // A model the plugin can't describe still gets the generic shape, so a
          // model added upstream works before the next release.
          const models = accountModels(ids, template, {
            baseURL,
            providerID: PROVIDER,
            fallback: template[DEFAULT_MODEL],
          });
          return models ?? provider.models;
        } catch {
          // Keep the models magpie already has rather than lose the list over
          // one failed read.
          return provider.models;
        }
      },
    },
  };
}

export const _internal = {
  PROVIDER,
  ORIGIN,
  BASE,
  LINES,
  DEFAULT_MODEL,
  keyOf,
  planOf,
  configModels,
  accountModels,
  modelIDs,
};
