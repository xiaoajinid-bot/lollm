import test from "node:test";
import assert from "node:assert/strict";

import {
  nameFromFile,
  parseModelName,
  parseReference,
  huggingFaceUrl,
  ollamaManifestUrl,
} from "../src/models/registry.mjs";
import { HttpError } from "../src/errors.mjs";

test("normalizes model names like Ollama", () => {
  assert.deepEqual(parseModelName("qwen2.5"), {
    namespace: "library",
    name: "qwen2.5",
    tag: "latest",
    display: "qwen2.5:latest",
    full: "library/qwen2.5:latest",
  });
  assert.equal(parseModelName("qwen2.5:0.5B").display, "qwen2.5:0.5B");
  assert.equal(parseModelName("myns/model:q4").display, "myns/model:q4");
  assert.equal(parseModelName("Qwen2.5:Q4").name, "qwen2.5");
});

test("rejects invalid model names", () => {
  for (const bad of ["", "  ", "bad name", "../escape", "-leading", "a/b/c"]) {
    assert.throws(() => parseModelName(bad), HttpError, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test("parses Ollama registry references", () => {
  const ref = parseReference("qwen2.5:0.5b");
  assert.equal(ref.provider, "ollama");
  assert.equal(ref.modelName.display, "qwen2.5:0.5b");
  assert.equal(parseReference("ollama:gemma3:4b").modelName.display, "gemma3:4b");
});

test("parses Hugging Face references", () => {
  const ref = parseReference("hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:qwen2.5-0.5b-instruct-q4_k_m.gguf");
  assert.equal(ref.provider, "hf");
  assert.equal(ref.repo, "Qwen/Qwen2.5-0.5B-Instruct-GGUF");
  assert.equal(ref.file, "qwen2.5-0.5b-instruct-q4_k_m.gguf");
  assert.equal(ref.suggestedName, "qwen2.5-0.5b-instruct-q4_k_m");
  assert.equal(
    huggingFaceUrl(ref.repo, ref.file),
    "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf?download=true",
  );
});

test("requires a file for Hugging Face references", () => {
  assert.throws(() => parseReference("hf:org/repo"), /need a repo and a file/);
  assert.throws(() => parseReference("hf:org/repo:model.safetensors"), /must be a \.gguf/);
});

test("parses URLs and local paths", () => {
  const url = parseReference("https://example.com/models/Tiny-Q4.gguf");
  assert.equal(url.provider, "http");
  assert.equal(url.suggestedName, "tiny-q4");

  const relative = parseReference("./models/tiny.gguf");
  assert.equal(relative.provider, "file");
  assert.equal(relative.suggestedName, "tiny");

  assert.equal(parseReference("/abs/path/model.gguf").provider, "file");
});

test("derives valid names from file names", () => {
  assert.equal(nameFromFile("Qwen2.5-0.5B-Instruct-Q4_K_M.gguf"), "qwen2.5-0.5b-instruct-q4_k_m");
  assert.equal(nameFromFile("...gguf"), "model");
  assert.equal(nameFromFile("Model (1).GGUF"), "model-1");
});

test("builds registry URLs", () => {
  const modelName = parseModelName("myns/model:q4");
  assert.equal(
    ollamaManifestUrl("https://registry.ollama.ai", modelName),
    "https://registry.ollama.ai/v2/myns/model/manifests/q4",
  );
});
