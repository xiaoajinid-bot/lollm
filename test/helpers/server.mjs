import path from "node:path";
import { start } from "../../src/index.mjs";
import { silentLogger } from "../../src/logger.mjs";
import { createMockBackend } from "../../src/engine/mock-backend.mjs";
import { tempDir, writeGgufFixture } from "./gguf-fixture.mjs";
import { parseModelfile } from "../../src/models/modelfile.mjs";

/**
 * Boot a fully wired server on an ephemeral port, backed by the deterministic
 * mock backend and an isolated model store.
 *
 * @param {{mock?: Record<string, any>, models?: string[], template?: string | null}} [options]
 */
export async function bootServer(options = {}) {
  const home = await tempDir("lollm-api-");
  const instance = await start({
    home,
    host: "127.0.0.1",
    port: 0,
    backend: createMockBackend({ logger: silentLogger, ...(options.mock ?? {}) }),
    logger: silentLogger,
    playground: true,
  });

  const gguf = await writeGgufFixture(path.join(home, "fixtures", "tiny.gguf"));
  const models = options.models ?? ["tiny:latest"];
  for (const model of models) {
    await instance.store.importFile(gguf, { name: model });
  }

  if (options.template) {
    await instance.store.create({
      model: "templated:latest",
      from: "tiny:latest",
      template: options.template,
      system: "You are terse.",
      parameters: { temperature: "0.2", stop: ["<|im_end|>"] },
    });
  }

  return {
    ...instance,
    home,
    gguf,
    fetch: (pathname, init) => fetch(new URL(pathname, instance.url), init),
  };
}

/**
 * Parse an NDJSON response body into objects.
 * @param {string} text
 */
export function parseNdjson(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * Parse an SSE response body into `data:` payloads (strings are returned raw,
 * `[DONE]` included).
 * @param {string} text
 */
export function parseSse(text) {
  /** @type {any[]} */
  const events = [];
  for (const block of text.split("\n\n")) {
    const dataLines = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    if (dataLines.length === 0) continue;
    const payload = dataLines.join("\n");
    if (payload === "[DONE]") {
      events.push("[DONE]");
      continue;
    }
    events.push(JSON.parse(payload));
  }
  return events;
}

/**
 * @param {string} modelsDir
 * @param {string} file
 */
export function fixturePath(modelsDir, file) {
  return path.join(modelsDir, file);
}

export { parseModelfile };
