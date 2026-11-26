// The models eazydata serves, and how they read on magpie's side.
//
// eazydata is an OpenAI-compatible relay: it does not document a fixed model
// table, it serves whatever the upstream accounts behind it can reach, and
// `GET /v1/models` is the live source of truth. So there is no hardcoded
// catalogue here. `config` publishes one generic entry so magpie has a
// provider to show before a key is signed in; `provider.models` replaces it
// with exactly what the signed-in account may call.
//
// Two shapes are needed. `config` takes the small table (name, limit,
// tool_call…); `provider.models` takes full OpenCode Model objects (api,
// capabilities, cost). `configModels` builds the first, `fullModel` expands an
// entry of the first into the second, so both hooks describe one model alike.
//
// A relay routes to many upstream families (OpenAI, Anthropic, Gemini, DeepSeek,
// Qwen…), so the generic shape must be generous: text in / text out, tools on,
// a large context window, and a zero money cost — this relay bills against a
// plan allowance, not per exact token in a way the client can compute.

export const CHAT_SDK = "@ai-sdk/openai-compatible";

// The entry `config` publishes before sign-in. It is a placeholder the account's
// real listing replaces; the id is honest about that.
export const DEFAULT_MODEL = "eazydata-default";

// A relay model carries no reliable per-model limits, so pick a large window
// that most routed families allow. These are the fallback figures, not claims:
// a model that needs less simply uses less.
const DEFAULT_CONTEXT = 128_000;
const DEFAULT_OUTPUT = 32_768;

// A modality list as the capability map OpenCode reads ({text: true, …}).
export function flagMap(list, fallback = ["text"]) {
  const out = {};
  for (const m of Array.isArray(list) ? list : []) {
    if (typeof m === "string" && m) out[m] = true;
  }
  if (Object.keys(out).length) return out;
  for (const m of fallback) out[m] = true;
  return out;
}

// The `config` hook's model table: the smaller shape OpenCode and magpie take
// there (name, limit, tool_call, cost…), not a full Model object.
export function configModels({ reasoning = false } = {}) {
  return {
    [DEFAULT_MODEL]: {
      name: "eazydata (pick after sign-in)",
      limit: { context: DEFAULT_CONTEXT, output: DEFAULT_OUTPUT },
      // Thinking stays off unless the plugin option turns it on: a relay may
      // route to a model that rejects reasoning parameters, and a chat that
      // fails is worse than one without a visible reasoning pane.
      reasoning,
      tool_call: true,
      attachment: true,
      modalities: { input: ["text", "image"], output: ["text"] },
      // Billed in tokens against the plan allowance, never in money the client
      // can compute. No `free` flag: this spends the plan's quota.
      cost: { input: 0, output: 0 },
    },
  };
}

// An entry of the config table as the full Model the `provider.models` hook
// returns. `id` is what the agent writes after the provider id; `api.id` is
// what goes in the request body, and stays the service's own id.
export function fullModel(providerID, id, small, baseURL, npm = CHAT_SDK) {
  const known = small ?? {};
  const modalities = known.modalities ?? {};
  const limit = known.limit ?? {};
  const model = {
    id,
    providerID,
    name: known.name ?? id,
    api: { id: known.id ?? id, url: baseURL, npm },
    limit: {
      context: Number.isFinite(limit.context) ? limit.context : DEFAULT_CONTEXT,
      output: Number.isFinite(limit.output) ? limit.output : DEFAULT_OUTPUT,
    },
    capabilities: {
      temperature: true,
      reasoning: known.reasoning === true,
      toolcall: known.tool_call !== false,
      attachment: known.attachment !== false,
      input: flagMap(modalities.input, ["text", "image"]),
      output: flagMap(modalities.output),
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    variants: {},
    release_date: "",
    status: "active",
  };
  // magpie reads `decides` on the models hook too, and it is what turns a model
  // into a classifier instead of a chat model.
  if (known.decides === true) model.decides = true;
  return model;
}

// A whole config table as full Models, for the fallback list.
export function fullModels(template, { baseURL, npm = CHAT_SDK, providerID } = {}) {
  const out = {};
  for (const [id, small] of Object.entries(template ?? {})) {
    out[id] = fullModel(providerID, id, small, baseURL, npm);
  }
  return out;
}

// The ids in a GET /v1/models answer, in the order the API gave them.
export function modelIDs(listing) {
  const rows = Array.isArray(listing)
    ? listing
    : Array.isArray(listing?.data)
      ? listing.data
      : Array.isArray(listing?.models)
        ? listing.models
        : [];
  const ids = [];
  for (const row of rows) {
    const id = typeof row === "string" ? row : row?.id;
    if (typeof id === "string" && id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

// The account's own model list, for the `provider.models` hook.
//
// The listing is the whole truth about what this account may call, so every id
// it names is offered. A description the plugin knows (from `template`) is kept;
// anything else borrows `fallback`'s shape rather than vanishing, since the
// relay only lists models it will actually serve. When the listing is empty the
// table itself is offered, and when even that is empty the single generic entry
// stays, so magpie never ends up with a provider that has zero models.
export function accountModels(ids, template, { baseURL, npm = CHAT_SDK, providerID, fallback } = {}) {
  const out = {};
  const spare = fallback ?? template?.[DEFAULT_MODEL] ?? configModels()[DEFAULT_MODEL];
  let described = 0;
  for (const id of ids ?? []) {
    const small = template?.[id] ?? spare;
    out[id] = fullModel(providerID, id, small, baseURL, npm);
    described += 1;
  }
  if (described) return out;
  const table = fullModels(template, { baseURL, npm, providerID });
  return Object.keys(table).length ? table : { [DEFAULT_MODEL]: fullModel(providerID, DEFAULT_MODEL, spare, baseURL, npm) };
}

// Either shape of a model — the config table's small one, or a full Model
// magpie handed back — as the small one, so `fullModel` can rebuild it.
export function smallOf(model, id) {
  if (!model || typeof model !== "object") return undefined;
  const caps = model.capabilities ?? {};
  const limit = model.limit ?? {};
  const modalities = model.modalities ?? {
    input: Object.keys(caps.input ?? {}).filter((k) => caps.input[k]),
    output: Object.keys(caps.output ?? {}).filter((k) => caps.output[k]),
  };
  return {
    name: model.name,
    id: model.api?.id ?? id,
    limit: { context: limit.context, output: limit.output },
    reasoning: model.reasoning ?? caps.reasoning,
    tool_call: model.tool_call ?? caps.toolcall,
    attachment: model.attachment ?? caps.attachment,
    modalities,
    decides: model.decides,
  };
}
