import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";

import { resolveConfig } from "../src/config.mjs";
import { readBody } from "../src/util/http.mjs";
import { mapOptions, mergeOptions } from "../src/chat/messages.mjs";
import { resolveRemoteTarget } from "../src/models/remote.mjs";

const home = path.join(os.tmpdir(), "lollm-limits");

/** @param {Buffer} payload */
function fakeRequest(payload) {
  const stream = Readable.from([payload]);
  return /** @type {any} */ (stream);
}

test("nothing is capped by default: no token, context or body limits", () => {
  const config = resolveConfig({ home }, {});
  assert.equal(config.contextSize, null, "context defaults to the model's own window");
  assert.equal(config.maxTokens, null, "no default output cap");
  assert.equal(config.maxBodyBytes, 0, "0 means unlimited");
});

test("limits are opt-in through env or flags", () => {
  const env = resolveConfig({ home }, {
    LOLLM_CONTEXT_SIZE: "16384",
    LOLLM_MAX_TOKENS: "512",
    LOLLM_MAX_BODY_BYTES: "1048576",
  });
  assert.equal(env.contextSize, 16384);
  assert.equal(env.maxTokens, 512);
  assert.equal(env.maxBodyBytes, 1048576);

  const flag = resolveConfig({ home, contextSize: 8192, maxTokens: 256, maxBodyBytes: 4096 }, {});
  assert.equal(flag.contextSize, 8192);
  assert.equal(flag.maxTokens, 256);
  assert.equal(flag.maxBodyBytes, 4096);
});

test("LOLLM_CONTEXT_SIZE=auto restores the unlimited default", () => {
  const config = resolveConfig({ home }, { LOLLM_CONTEXT_SIZE: "auto" });
  assert.equal(config.contextSize, null);
});

test("request bodies are unbounded unless a cap is configured", async () => {
  const big = Buffer.alloc(2 * 1024 * 1024, 0x61);
  const unlimited = await readBody(fakeRequest(big), { limit: 0 });
  assert.equal(unlimited.length, big.length);

  await assert.rejects(() => readBody(fakeRequest(big), { limit: 1024 }), /exceeds 1024 bytes/);
});

test("num_predict / max_tokens unset or -1 means unlimited", () => {
  assert.deepEqual(mapOptions({}), {});
  assert.equal(mapOptions({ num_predict: -1 }).maxTokens, undefined);
  assert.equal(mapOptions({ max_tokens: 0 }).maxTokens, undefined);
  assert.equal(mapOptions({ num_predict: 128 }).maxTokens, 128);
  assert.equal(mapOptions({ max_tokens: 64 }).maxTokens, 64);
});

test("a configured maxTokens default applies only when the request has none", () => {
  const defaults = { maxTokens: 300 };
  assert.equal(mapOptions({}, defaults).maxTokens, 300);
  assert.equal(mapOptions({ num_predict: 10 }, defaults).maxTokens, 10);
  assert.equal(mapOptions({ num_predict: -1 }, defaults).maxTokens, undefined);
});

test("context size is optional: unset leaves it to the model", () => {
  assert.equal(mapOptions({}).contextSize, undefined);
  assert.equal(mapOptions({}, { contextSize: undefined }).contextSize, undefined);
  assert.equal(mapOptions({ num_ctx: 2048 }).contextSize, 2048);
  // mergeOptions must not invent a context value either
  assert.equal(mergeOptions({ temperature: 0.8 }, {}).contextSize, undefined);
});

test("hf: references follow LOLLM_HF_ENDPOINT (mirrors and local tests)", () => {
  const mirror = resolveRemoteTarget("hf:org/repo:model.gguf", { hfEndpoint: "http://mirror.local:8080/" });
  assert.equal(mirror.url, "http://mirror.local:8080/org/repo/resolve/main/model.gguf?download=true");

  const config = resolveConfig({ home }, { LOLLM_HF_ENDPOINT: "https://hf-mirror.example" });
  assert.equal(config.hfEndpoint, "https://hf-mirror.example");
  assert.equal(resolveConfig({ home }, {}).hfEndpoint, "https://huggingface.co");
});
