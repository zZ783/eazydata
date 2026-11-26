// The eazydata provider, as magpie's plugin host calls it.
//
// eazydata (https://eazydata.org) is an OpenAI-compatible relay: one base URL,
// one API key, and whatever models the account behind the key can reach.
// Two things make it need a plugin rather than a plain provider block:
//
//   - the model list is not fixed and not documented; it is read live from
//     `GET /v1/models` for the signed-in account, so a model added upstream
//     works without a new release of this plugin;
//   - the allowance, when the relay reports one, is only ever in `x-quota-*`
//     response headers, so `usage` has to read a response to know it — and must
//     show "unknown" rather than a made-up 0% when the headers are absent.
//
// Everything else — base URL, key, request forwarding — is a normal API key
// provider. The relay has four advertised lines (主站 / 备用 zzz / 备用 cn /
// upload); the plugin uses the main line by default, and any of them can be
// selected with the `baseURL` option (or a providers.json override).

import { quotaWindow, planOf, nextUtcMidnight } from "./quota.mjs";
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

  // The newest allowance any response reported, per account key. Only a
  // fallback for `usage` when its own read fails: keeping it under the key
  // keeps two signed-in keys from showing each other's spend.
  const seen = new Map();
  const remember = (key, headers, now) => {
    if (!key) return;
    const window = quotaWindow(headers, now);
    if (window) seen.set(key, { window, at: now });
  };

  // One account's worth of headers, from a GET the caller is making anyway.
  async function readAllowance(apiKey) {
    const res = await fetchImpl(`${baseURL}/models`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
    });
    const window = quotaWindow(res.headers);
    if (window) seen.set(apiKey, { window, at: Date.now() });
    // Nothing reads this body; drop it rather than hold the connection open.
    try {
      await res.body?.cancel?.();
    } catch {
      /* already gone */
    }
    return { res, window };
  }

  // The allowance, when it looks like a hard stop, is a rest until its reset.
  // The relay may or may not send Retry-After; when it doesn't, the reset
  // instant (header, or the body's own words) does.
  async function spentAllowance(res) {
    const text = await res.text().catch(() => "");
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* non-JSON body: pass its own words through */
    }
    const headers = new Headers(res.headers);
    if (!headers.get("retry-after")) {
      const reset = body?.error?.reset_at ?? headers.get("x-quota-reset");
      const at = typeof reset === "string" ? Date.parse(reset) : NaN;
      const until = Number.isFinite(at) ? at : nextUtcMidnight().getTime();
      headers.set("retry-after", String(Math.max(1, Math.ceil((until - Date.now()) / 1000))));
    }
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
              const window = quotaWindow(res.headers);
              if (window) seen.set(key, { window, at: Date.now() });
              try {
                await res.body?.cancel?.();
              } catch {
                /* already gone */
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
            remember(apiKey, res.headers, Date.now());

            // A 429 that is the allowance running out gets a working
            // Retry-After; a concurrency 429 keeps the relay's own short one.
            if (res.status === 429 && (await isSpent(res))) {
              return spentAllowance(res);
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
          const read = await readAllowance(apiKey);
          window = read.window;
          if (read.res.status === 401) {
            // 401 is about the key itself, so the account is the one to fix.
            signIn = "expired";
            error = "The API key is no longer accepted. Sign in again.";
          }
        } catch (e) {
          error = `Could not read the allowance: ${e?.message ?? e}`;
        }
        // A read that failed falls back to what a request already reported,
        // still under this account's own key.
        window ??= seen.get(apiKey)?.window ?? null;

        const windows = [];
        if (window) {
          windows.push({ ...window });
        } else {
          // No figures at all: shown, never routed on (no `used`, no counts).
          windows.push({
            name: "Plan allowance",
            span: 86400,
            resetsAt: nextUtcMidnight().toISOString(),
            unit: "tokens",
            display: "The allowance is reported in response headers; it appears after this account's first request.",
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
          remember(apiKey, res.headers, Date.now());
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
  quotaWindow,
  planOf,
  configModels,
  accountModels,
  modelIDs,
};
