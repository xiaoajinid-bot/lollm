import test from "node:test";
import assert from "node:assert/strict";

import { createLlamaBackend, toChatHistory } from "../src/engine/llama-backend.mjs";

test("chat history conversion matches node-llama-cpp's ChatHistoryItem shape", () => {
  const history = toChatHistory([
    { role: "system", content: "be nice" },
    { role: "user", content: "hello" },
    {
      role: "assistant",
      content: "calling a tool",
      tool_calls: [{ type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }],
    },
    { role: "tool", name: "lookup", content: '{"answer":42}' },
    { role: "user", content: "thanks" },
  ]);

  assert.deepEqual(history[0], { type: "system", text: "be nice" });
  assert.deepEqual(history[1], { type: "user", text: "hello" });
  assert.equal(history[2].type, "model");
  assert.match(history[2].text, /calling a tool/);
  assert.match(history[2].text, /"name":"lookup"/);
  assert.equal(history[3].type, "user");
  assert.match(history[3].text, /Tool result \(lookup\): \{"answer":42\}/);
  assert.deepEqual(history[4], { type: "user", text: "thanks" });
});

test("the llama backend advertises its capabilities without loading anything", () => {
  const backend = createLlamaBackend({ config: { gpu: false } });
  assert.equal(backend.kind, "llama");
  assert.deepEqual(backend.capabilities, { tools: true, embeddings: true });
  assert.equal(typeof backend.loadModel, "function");
  assert.equal(typeof backend.dispose, "function");
});

test("node-llama-cpp exposes the APIs this backend relies on", async (t) => {
  let mod;
  try {
    mod = await import("node-llama-cpp");
  } catch {
    t.skip("node-llama-cpp is not installed (optional dependency)");
    return;
  }
  for (const name of ["getLlama", "LlamaChat", "LlamaCompletion", "LlamaChatSession", "LlamaGrammar"]) {
    assert.equal(typeof mod[name], "function", `${name} should be exported by node-llama-cpp`);
  }
});
