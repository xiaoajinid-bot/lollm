import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { ModelStore } from "../src/models/store.mjs";
import { HttpError } from "../src/errors.mjs";
import { tempDir, writeGgufFixture } from "./helpers/gguf-fixture.mjs";

async function makeStore() {
  const dir = await tempDir("lollm-store-");
  const store = new ModelStore({ modelsDir: path.join(dir, "models") });
  await store.init();
  const gguf = await writeGgufFixture(path.join(dir, "fixtures", "tiny.gguf"));
  return { dir, store, gguf };
}

test("imports a GGUF file and exposes Ollama-style details", async () => {
  const { store, gguf } = await makeStore();
  const result = await store.importFile(gguf, { name: "tiny:latest" });
  assert.equal(result.model, "tiny:latest");
  assert.match(result.digest, /^sha256:[a-f0-9]{64}$/);

  const models = await store.list();
  assert.equal(models.length, 1);
  assert.equal(models[0].name, "tiny:latest");
  assert.equal(models[0].details.format, "gguf");
  assert.equal(models[0].details.family, "qwen2");
  assert.equal(models[0].details.parameter_size, "494M");
  assert.equal(models[0].details.quantization_level, "Q4_K_M");
  assert.ok(models[0].size > 0);
});

test("resolve returns a blob path and parsed layers", async () => {
  const { store, gguf } = await makeStore();
  await store.importFile(gguf, { name: "tiny" });
  const resolved = await store.resolve("tiny:latest");
  assert.match(resolved.modelPath, /blobs[\\/]sha256-[a-f0-9]{64}$/);
  assert.equal(await fs.readFile(resolved.modelPath).then((b) => b.subarray(0, 4).toString()), "GGUF");
  assert.equal(resolved.gguf.contextLength, 32768);
  assert.deepEqual(resolved.capabilities, ["completion", "tools"]);
  assert.equal(resolved.manifest.layers[0].mediaType, "application/vnd.ollama.image.model");
  assert.ok(resolved.manifest.config.digest.startsWith("sha256:"));
});

test("show reconstructs a Modelfile and model_info", async () => {
  const { store, gguf } = await makeStore();
  await store.importFile(gguf, { name: "tiny" });
  const show = await store.show("tiny");
  assert.match(show.modelfile, /^FROM /);
  assert.equal(show.model_info["general.architecture"], "qwen2");
  assert.equal(show.model_info["qwen2.context_length"], 32768);
  assert.equal(show.model_info["tokenizer.ggml.tokens"], undefined);
  assert.equal(show.template, "");
});

test("copy shares blobs and rejects duplicates", async () => {
  const { store, gguf } = await makeStore();
  await store.importFile(gguf, { name: "tiny" });
  const blobsBefore = await fs.readdir(path.join(store.dir, "blobs"));

  await store.copy("tiny", "tiny-copy:latest");
  const found = await store.find("tiny-copy");
  assert.ok(found, "copy should be discoverable");
  const blobsAfter = await fs.readdir(path.join(store.dir, "blobs"));
  assert.equal(blobsAfter.length, blobsBefore.length, "copy must not duplicate the weights");

  await assert.rejects(() => store.copy("tiny", "tiny-copy"), (error) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 409);
    return true;
  });
});

test("remove deletes the manifest and prunes directories", async () => {
  const { store, gguf } = await makeStore();
  await store.importFile(gguf, { name: "temp:latest" });
  await store.remove("temp");
  assert.equal(await store.find("temp"), null);
  const remaining = await fs.readdir(path.join(store.dir, "manifests", "lollm.local")).catch(() => []);
  assert.deepEqual(remaining, []);
});

test("create builds a Modelfile-derived model from an existing one", async () => {
  const { store, gguf } = await makeStore();
  await store.importFile(gguf, { name: "base:latest" });
  const result = await store.create({
    model: "tutor:latest",
    from: "base",
    system: "You are a patient tutor.",
    template: "{{ .System }}\n{{ .Prompt }}",
    parameters: { temperature: "0.3", stop: ["</s>"] },
  });
  assert.equal(result.model, "tutor:latest");

  const resolved = await store.resolve("tutor");
  assert.equal(resolved.system, "You are a patient tutor.");
  assert.match(resolved.template, /\{\{ \.Prompt \}\}/);
  assert.equal(resolved.parameters.temperature, "0.3");
  // A single value is stored as a scalar, repeated values become an array.
  assert.equal(resolved.parameters.stop, "</s>");
  assert.equal(resolved.modelLayer.digest, (await store.resolve("base")).modelLayer.digest);

  const show = await store.show("tutor");
  assert.match(show.modelfile, /SYSTEM """/);
  assert.match(show.parameters, /temperature 0.3/);
});

test("create can import a GGUF path directly", async () => {
  const { store, gguf } = await makeStore();
  const result = await store.create({ model: "direct:q4", from: gguf });
  assert.equal(result.model, "direct:q4");
  assert.equal((await store.resolve("direct:q4")).details.quantization_level, "Q4_K_M");
});

test("create requires FROM and refuses unknown sources", async () => {
  const { store } = await makeStore();
  await assert.rejects(() => store.create({ model: "x" }), /FROM is required/);
  await assert.rejects(
    () => store.create({ model: "x", from: "hf:org/repo:model.gguf" }),
    /is not installed/,
  );
});

test("pull imports a local file through the reference parser", async () => {
  const { store, gguf } = await makeStore();
  const events = [];
  const result = await store.pull(gguf, { name: "pulled:latest", onProgress: (event) => events.push(event) });
  assert.equal(result.model, "pulled:latest");
  assert.ok(events.some((event) => event.status === "success"));
  assert.ok(await store.find("pulled"));
});

test("pull refuses non-GGUF files", async () => {
  const { dir, store } = await makeStore();
  const bogus = path.join(dir, "bogus.gguf");
  await fs.writeFile(bogus, "not a model");
  await assert.rejects(() => store.pull(bogus, { name: "bogus" }), /not a GGUF file/);
});

test("unknown models produce 404s with a helpful message", async () => {
  const { store } = await makeStore();
  await assert.rejects(() => store.resolve("nope"), (error) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 404);
    assert.match(error.message, /lollm pull nope/);
    return true;
  });
});

test("rejects path traversal in model names", async () => {
  const { store } = await makeStore();
  await assert.rejects(() => store.resolve("../etc/passwd"), HttpError);
  assert.throws(() => store.blobPath("sha256:../../etc/passwd"), /invalid layer digest/);
});
