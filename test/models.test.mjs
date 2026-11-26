import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MODEL,
  flagMap,
  configModels,
  fullModel,
  fullModels,
  modelIDs,
  accountModels,
  smallOf,
} from "../src/models.mjs";

const BASE = "https://eazydata.org/v1";
const ID = "eazydata";

test("configModels publishes one generic entry before sign-in", () => {
  const models = configModels();
  const def = models[DEFAULT_MODEL];
  assert.equal(def.limit.context, 128_000);
  assert.equal(def.limit.output, 32_768);
  assert.equal(def.tool_call, true);
  assert.equal(def.reasoning, false);
  assert.deepEqual(def.cost, { input: 0, output: 0 });
  // Never `free: true`: every token spends the plan allowance.
  assert.equal("free" in def, false);
});

test("configModels turns reasoning on only when asked", () => {
  assert.equal(configModels({ reasoning: true })[DEFAULT_MODEL].reasoning, true);
});

test("flagMap fills a capability map and never returns an empty one", () => {
  assert.deepEqual(flagMap(["text", "image"]), { text: true, image: true });
  assert.deepEqual(flagMap([]), { text: true });
  assert.deepEqual(flagMap(undefined), { text: true });
  assert.deepEqual(flagMap(["audio"], ["text"]), { audio: true });
});

test("fullModel expands a config entry into a whole Model", () => {
  const small = configModels({ reasoning: true })[DEFAULT_MODEL];
  const model = fullModel(ID, "gpt-4o", small, BASE);
  assert.equal(model.id, "gpt-4o");
  assert.equal(model.providerID, ID);
  assert.equal(model.api.id, "gpt-4o");
  assert.equal(model.api.url, BASE);
  assert.equal(model.api.npm, "@ai-sdk/openai-compatible");
  assert.equal(model.limit.context, 128_000);
  assert.equal(model.capabilities.reasoning, true);
  assert.equal(model.capabilities.toolcall, true);
  assert.deepEqual(model.capabilities.input, { text: true, image: true });
  assert.deepEqual(model.capabilities.output, { text: true });
  assert.deepEqual(model.cost, { input: 0, output: 0, cache: { read: 0, write: 0 } });
  assert.equal(model.status, "active");
  assert.equal("decides" in model, false);
});

test("fullModel survives a missing entry by falling back to the default limits", () => {
  const model = fullModel(ID, "brand-new-model", undefined, BASE);
  assert.equal(model.limit.context, 128_000);
  assert.equal(model.limit.output, 32_768);
  assert.equal(model.name, "brand-new-model");
});

test("fullModels expands the whole table", () => {
  const models = fullModels(configModels(), { baseURL: BASE, providerID: ID });
  assert.deepEqual(Object.keys(models), [DEFAULT_MODEL]);
});

test("modelIDs reads every listing shape the API might use", () => {
  assert.deepEqual(modelIDs({ object: "list", data: [{ id: "a" }, { id: "b" }] }), ["a", "b"]);
  assert.deepEqual(modelIDs({ models: ["a", "b"] }), ["a", "b"]);
  assert.deepEqual(modelIDs(["a", { id: "b" }]), ["a", "b"]);
  // A model served twice is offered once.
  assert.deepEqual(modelIDs({ data: [{ id: "a" }, { id: "a" }] }), ["a"]);
  assert.deepEqual(modelIDs({ data: [{ id: "" }, { object: "model" }] }), []);
  assert.deepEqual(modelIDs(null), []);
  assert.deepEqual(modelIDs("nonsense"), []);
});

test("accountModels describes exactly the listed ids", () => {
  const models = accountModels(["gpt-4o", "claude-3.5-sonnet"], configModels(), { baseURL: BASE, providerID: ID });
  assert.deepEqual(Object.keys(models).sort(), ["claude-3.5-sonnet", "gpt-4o"]);
  assert.equal(models["gpt-4o"].api.id, "gpt-4o");
});

test("accountModels gives an unknown listed id the generic shape", () => {
  const models = accountModels(["some-new-model"], configModels(), {
    baseURL: BASE,
    providerID: ID,
    fallback: configModels()[DEFAULT_MODEL],
  });
  assert.equal(models["some-new-model"].id, "some-new-model");
  assert.equal(models["some-new-model"].api.id, "some-new-model");
  assert.equal(models["some-new-model"].limit.context, 128_000);
});

test("accountModels offers the table when nothing was listed", () => {
  const models = accountModels([], configModels(), { baseURL: BASE, providerID: ID });
  assert.deepEqual(Object.keys(models), [DEFAULT_MODEL]);
});

test("accountModels never returns an empty set, even with an empty table", () => {
  const models = accountModels([], {}, { baseURL: BASE, providerID: ID });
  assert.ok(Object.keys(models).length >= 1);
});

test("smallOf turns either model shape back into the config entry shape", () => {
  const full = fullModel(ID, "gpt-4o", configModels({ reasoning: true })[DEFAULT_MODEL], BASE);
  const small = smallOf(full, "gpt-4o");
  assert.equal(small.name, full.name);
  assert.equal(small.id, "gpt-4o");
  assert.deepEqual(small.limit, { context: 128_000, output: 32_768 });
  assert.equal(small.reasoning, true);
  assert.equal(small.tool_call, true);
  assert.deepEqual(small.modalities, { input: ["text", "image"], output: ["text"] });
  assert.equal(smallOf(undefined, "x"), undefined);
});
