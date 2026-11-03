import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { createInstance } from "../src/index.mjs";
import { silentLogger } from "../src/logger.mjs";
import { createMockBackend } from "../src/engine/mock-backend.mjs";
import { Semaphore } from "../src/engine/engine.mjs";
import { tempDir, writeGgufFixture } from "./helpers/gguf-fixture.mjs";

async function makeInstance(options = {}) {
  const home = await tempDir("lollm-engine-");
  const instance = await createInstance({
    home,
    logger: silentLogger,
    parallel: options.parallel ?? 1,
    maxLoadedModels: options.maxLoadedModels ?? 1,
    ...(options.config ?? {}),
    backend: createMockBackend({ logger: silentLogger, ...(options.mock ?? {}) }),
  });
  const gguf = await writeGgufFixture(path.join(home, "fixtures", "tiny.gguf"));
  await instance.store.importFile(gguf, { name: "tiny:latest" });
  if (options.secondModel) {
    const other = await writeGgufFixture(path.join(home, "fixtures", "other.gguf"), {
      metadata: { "general.name": "Other Model", "general.architecture": "llama" },
    });
    await instance.store.importFile(other, { name: "other:latest" });
  }
  return instance;
}

test("Semaphore caps concurrency and hands slots to waiters", async () => {
  const semaphore = new Semaphore(2);
  const releaseA = await semaphore.acquire();
  const releaseB = await semaphore.acquire();
  assert.equal(semaphore.active, 2);

  let granted = false;
  const waiting = semaphore.acquire().then((release) => {
    granted = true;
    return release;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(granted, false);

  releaseA();
  const releaseC = await waiting;
  assert.equal(granted, true);
  assert.equal(semaphore.active, 2);
  releaseB();
  releaseC();
  assert.equal(semaphore.active, 0);
});

test("Semaphore honours abort signals", async () => {
  const semaphore = new Semaphore(1);
  const release = await semaphore.acquire();
  const controller = new AbortController();
  const pending = semaphore.acquire(controller.signal);
  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
  release();
});

test("engine loads a model, streams tokens and reports timings", async () => {
  const instance = await makeInstance();
  const chunks = [];
  const result = await instance.engine.chat({
    model: "tiny",
    messages: [{ role: "user", content: "hello" }],
    onToken: (chunk) => chunks.push(chunk),
    keepAlive: "5m",
  });

  assert.equal(result.model, "tiny:latest");
  assert.match(result.text, /hello/);
  assert.equal(chunks.join(""), result.text);
  assert.ok(result.timings.completionTokens > 0);
  assert.ok(result.timings.totalDuration >= 0);
  assert.ok(instance.engine.loaded.has("tiny:latest"));
  await instance.engine.dispose();
});

test("keep_alive 0 unloads the model right after the request", async () => {
  const instance = await makeInstance();
  await instance.engine.chat({ model: "tiny", messages: [{ role: "user", content: "hi" }], keepAlive: 0 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(instance.engine.loaded.size, 0);
  await instance.engine.dispose();
});

test("keep_alive forever pins the model", async () => {
  const instance = await makeInstance();
  await instance.engine.chat({
    model: "tiny",
    messages: [{ role: "user", content: "hi" }],
    keepAlive: -1,
  });
  assert.equal(instance.engine.loaded.size, 1);
  assert.equal(instance.engine.loaded.get("tiny:latest").expiresAt, null);
  await instance.engine.dispose();
});

test("engine evicts the least recently used model when slots are full", async () => {
  const instance = await makeInstance({ secondModel: true, maxLoadedModels: 1 });
  await instance.engine.chat({ model: "tiny", messages: [{ role: "user", content: "one" }], keepAlive: "10m" });
  assert.ok(instance.engine.loaded.has("tiny:latest"));

  await instance.engine.chat({ model: "other", messages: [{ role: "user", content: "two" }], keepAlive: "10m" });
  assert.ok(instance.engine.loaded.has("other:latest"));
  assert.equal(instance.engine.loaded.has("tiny:latest"), false);
  await instance.engine.dispose();
});

test("aborted generation stops early", async () => {
  const home = await tempDir("lollm-abort-");
  const instance = await createInstance({
    home,
    backend: createMockBackend({ logger: silentLogger, latencyMs: 15 }),
    logger: silentLogger,
  });
  const gguf = await writeGgufFixture(path.join(home, "tiny.gguf"));
  await instance.store.importFile(gguf, { name: "tiny" });

  const controller = new AbortController();
  const chunks = [];
  await assert.rejects(
    () =>
      instance.engine.chat({
        model: "tiny",
        messages: [{ role: "user", content: "a fairly long sentence to stream slowly" }],
        signal: controller.signal,
        onToken: (chunk) => {
          chunks.push(chunk);
          if (chunks.length === 2) controller.abort();
        },
      }),
    (error) => error.name === "AbortError",
  );
  assert.ok(chunks.length >= 2);
  await instance.engine.dispose();
});

test("engine status exposes backend, queue and stats", async () => {
  const instance = await makeInstance();
  await instance.engine.chat({ model: "tiny", messages: [{ role: "user", content: "hi" }] });
  const status = instance.engine.status();
  assert.equal(status.backend, "mock");
  assert.equal(status.parallel, 1);
  assert.equal(status.stats.requests, 1);
  assert.equal(status.loaded.length, 1);
  const ps = await instance.engine.ps();
  assert.equal(ps[0].name, "tiny:latest");
  assert.ok(["forever"].includes(ps[0].expires_at) || typeof ps[0].expires_at === "string");
  await instance.engine.dispose();
});
