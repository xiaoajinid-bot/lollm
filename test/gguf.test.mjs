import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { readGgufInfo, isGgufFile, GgufError } from "../src/models/gguf.mjs";
import { buildGgufBuffer, fixtureMetadata, tempDir, writeGgufFixture } from "./helpers/gguf-fixture.mjs";

test("reads architecture, context, quantization and parameter count", async () => {
  const dir = await tempDir();
  const file = await writeGgufFixture(path.join(dir, "tiny.gguf"));
  const info = await readGgufInfo(file);

  assert.equal(info.version, 3);
  assert.equal(info.architecture, "qwen2");
  assert.equal(info.name, "Tiny Test Model");
  assert.equal(info.contextLength, 32768);
  assert.equal(info.embeddingLength, 896);
  assert.equal(info.blockCount, 24);
  assert.equal(info.quantization, "Q4_K_M");
  assert.equal(info.parameterCount, 494_000_000);
  assert.equal(info.tensorCount, 2);
  assert.ok(info.sizeBytes > 0);
  assert.match(String(info.chatTemplate), /im_start/);
});

test("skips tokenizer arrays instead of buffering megabytes", async () => {
  const dir = await tempDir();
  const tokens = Array.from({ length: 4096 }, (_, index) => `token-${index}`);
  const file = path.join(dir, "tokens.gguf");
  await fs.writeFile(
    file,
    buildGgufBuffer({
      metadata: fixtureMetadata({ "tokenizer.ggml.tokens": tokens }),
      tensors: [{ name: "token_embd.weight", dims: [16, 32] }],
    }),
  );

  const info = await readGgufInfo(file);
  assert.equal(info.metadata["tokenizer.ggml.tokens"], undefined);
  assert.equal(info.metadata["tokenizer.ggml.model"], "gpt2");
  assert.equal(info.tensorCount, 1);
});

test("infers quantization from tensor types when file_type is missing", async () => {
  const dir = await tempDir();
  const metadata = fixtureMetadata();
  delete metadata["general.file_type"];
  delete metadata["general.parameter_count"];
  const file = path.join(dir, "inferred.gguf");
  await fs.writeFile(
    file,
    buildGgufBuffer({
      metadata,
      tensors: [
        { name: "a", dims: [10, 10], type: 2 }, // Q4_0
        { name: "b", dims: [10, 10], type: 2 },
        { name: "c", dims: [10, 10], type: 0 }, // F32 (ignored when another type dominates)
      ],
    }),
  );
  const info = await readGgufInfo(file);
  assert.equal(info.quantization, "Q4_0");
  assert.equal(info.parameterCount, 300);
});

test("supports GGUF v1 headers (32-bit lengths)", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "v1.gguf");
  await fs.writeFile(
    file,
    buildGgufBuffer({
      version: 1,
      metadata: {
        "general.architecture": "llama",
        "general.name": "Old Timer",
        "general.file_type": 2,
        "llama.context_length": 2048,
      },
      tensors: [{ name: "output.weight", dims: [8, 8] }],
    }),
  );
  const info = await readGgufInfo(file);
  assert.equal(info.version, 1);
  assert.equal(info.architecture, "llama");
  assert.equal(info.contextLength, 2048);
  assert.equal(info.quantization, "Q4_0");
  assert.equal(info.parameterCount, 64);
});

test("rejects files that are not GGUF", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "not-a-model.gguf");
  await fs.writeFile(file, "definitely not a model");
  await assert.rejects(() => readGgufInfo(file), (error) => {
    assert.ok(error instanceof GgufError);
    assert.match(error.message, /not a GGUF file/);
    return true;
  });
  assert.equal(await isGgufFile(file), false);
});

test("reports a clear error for missing files", async () => {
  await assert.rejects(() => readGgufInfo("/nonexistent/path/model.gguf"), /model file not found/);
});

test("truncated headers are rejected cleanly", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "truncated.gguf");
  const buffer = buildGgufBuffer({ metadata: fixtureMetadata() });
  await fs.writeFile(file, buffer.subarray(0, 40));
  await assert.rejects(() => readGgufInfo(file), /unexpected end of GGUF file/);
});
