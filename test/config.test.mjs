import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { resolveConfig, DEFAULT_PORT } from "../src/config.mjs";
import {
  formatBytes,
  formatDuration,
  formatParameters,
  parseDuration,
  toNanos,
} from "../src/util/format.mjs";

test("sensible defaults", () => {
  const home = path.join(os.tmpdir(), "lollm-config-defaults");
  const config = resolveConfig({ home }, {});
  assert.equal(config.port, DEFAULT_PORT);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.backend, "llama");
  // No cap by default: the model's own context window is used.
  assert.equal(config.contextSize, null);
  assert.equal(config.maxTokens, null);
  assert.equal(config.maxBodyBytes, 0);
  assert.equal(config.parallel, 1);
  assert.equal(config.maxLoadedModels, 1);
  assert.equal(config.gpu, "auto");
  assert.equal(config.playground, true);
  assert.equal(config.modelsDir, path.join(home, "models"));
});

test("environment variables set defaults, explicit options win", () => {
  const home = path.join(os.tmpdir(), "lollm-config-env");
  const env = {
    LOLLM_PORT: "8080",
    LOLLM_HOST: "0.0.0.0",
    LOLLM_PARALLEL: "3",
    LOLLM_CONTEXT_SIZE: "8192",
    LOLLM_KEEP_ALIVE: "30m",
    LOLLM_PLAYGROUND: "0",
    LOLLM_GPU: "false",
    LOLLM_BACKEND: "mock",
  };
  const fromEnv = resolveConfig({ home }, env);
  assert.equal(fromEnv.port, 8080);
  assert.equal(fromEnv.host, "0.0.0.0");
  assert.equal(fromEnv.parallel, 3);
  assert.equal(fromEnv.contextSize, 8192);
  assert.equal(fromEnv.keepAlive, "30m");
  assert.equal(fromEnv.playground, false);
  assert.equal(fromEnv.gpu, false);
  assert.equal(fromEnv.backend, "mock");

  const overridden = resolveConfig({ home, port: 9000, playground: true }, env);
  assert.equal(overridden.port, 9000);
  assert.equal(overridden.playground, true);
});

test("config.json fills gaps below env and options", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lollm-config-file-"));
  await fs.writeFile(
    path.join(home, "config.json"),
    JSON.stringify({ port: 1234, contextSize: 2048, ollamaRegistry: "https://mirror.example" }),
  );
  const config = resolveConfig({ home }, {});
  assert.equal(config.port, 1234);
  assert.equal(config.contextSize, 2048);
  assert.equal(config.ollamaRegistry, "https://mirror.example");

  const withEnv = resolveConfig({ home }, { LOLLM_PORT: "4321" });
  assert.equal(withEnv.port, 4321);
});

test("corrupt config.json is ignored", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lollm-config-bad-"));
  await fs.writeFile(path.join(home, "config.json"), "{not json");
  const config = resolveConfig({ home }, {});
  assert.equal(config.port, DEFAULT_PORT);
});

test("parseDuration understands Ollama-style values", () => {
  assert.equal(parseDuration("5m"), 5 * 60_000);
  assert.equal(parseDuration("1h30m"), 90 * 60_000);
  assert.equal(parseDuration("500ms"), 500);
  assert.equal(parseDuration("45s"), 45_000);
  assert.equal(parseDuration(30), 30_000); // bare numbers are seconds
  assert.equal(parseDuration(0), 0);
  assert.equal(parseDuration(-1), Infinity);
  assert.equal(parseDuration("forever"), Infinity);
  assert.equal(parseDuration("nonsense", 1234), 1234);
  assert.equal(parseDuration(undefined, 42), 42);
});

test("formatting helpers stay human readable", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(397_821_344), "379.4 MB");
  assert.equal(formatParameters(494_000_000), "494M");
  assert.equal(formatParameters(7_600_000_000), "7.6B");
  assert.equal(formatParameters(0), "unknown");
  assert.equal(formatDuration(500), "500ms");
  assert.equal(formatDuration(90_000), "1m30s");
  assert.equal(formatDuration(Infinity), "forever");
  assert.equal(toNanos(1.5), 1_500_000);
});
