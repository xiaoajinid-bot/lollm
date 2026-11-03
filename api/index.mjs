/**
 * Vercel serverless entrypoint.
 *
 * A platform function cannot open a long-lived listening socket, so instead of
 * `lollm serve` we build the exact same router and hand each request straight to
 * it. Everything in `src/` is reused unchanged: the Ollama API, the OpenAI API,
 * streaming NDJSON/SSE, the playground and the model store.
 *
 * Notes for the hosted environment:
 *  - the filesystem is read-only except `/tmp`, so the model store defaults to
 *    `/tmp/lollm` (ephemeral — a pull is lost when the instance is recycled);
 *  - the native llama.cpp binding is not installed by the Vercel build, so the
 *    deterministic `mock` backend is the default there. Set `LOLLM_BACKEND=llama`
 *    once the binding is bundled if you want real inference.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createInstance } from "../src/index.mjs";
import { createHandler } from "../src/server.mjs";

const DEMO_GGUF = fileURLToPath(new URL("../examples/demo-model.gguf", import.meta.url));
const DEMO_NAME = process.env.LOLLM_DEMO_MODEL ?? "lollm-demo:latest";

/**
 * A hosted demo with an empty store is a dead playground. When the mock backend
 * is in use (no native weights available anyway) seed one deterministic model so
 * `/playground`, `/api/tags` and `/api/chat` all work out of the box.
 *
 * @param {any} store
 */
async function seedDemoModel(store) {
  if (process.env.LOLLM_SEED_DEMO === "0") return;
  const models = await store.list().catch(() => []);
  if (models.length > 0) return;
  await store.create({
    model: DEMO_NAME,
    from: DEMO_GGUF,
    system: "You are lollm, a tiny demo model served from a serverless function.",
  });
}

/**
 * The platform filesystem is read-only apart from its temp directory, so the
 * model store has to live there. `mkdtemp` gives every instance a unique,
 * owner-only directory instead of a shared, guessable path.
 *
 * @returns {Promise<string>}
 */
async function resolveHome() {
  const configured = process.env.LOLLM_HOME;
  if (configured) return configured;
  return fs.mkdtemp(path.join(os.tmpdir(), "lollm-"));
}

/** @type {Promise<(req: any, res: any) => Promise<void>> | undefined} */
let ready;

async function boot() {
  const home = await resolveHome();
  const instance = await createInstance({
    home,
    backend: process.env.LOLLM_BACKEND ?? "mock",
    playground: process.env.LOLLM_PLAYGROUND !== "0",
    modelsDir: process.env.LOLLM_MODELS_DIR ?? undefined,
  });
  if (process.env.LOLLM_BACKEND !== "llama") {
    await seedDemoModel(instance.store).catch(() => {});
  }
  return createHandler({
    config: instance.config,
    store: instance.store,
    engine: instance.engine,
    logger: instance.logger,
  });
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
export default async function handler(req, res) {
  ready ??= boot();
  let handle;
  try {
    handle = await ready;
  } catch (error) {
    // Never retry a broken boot on every request; report it once, clearly.
    ready = undefined;
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    const message = `lollm failed to start: ${String(/** @type {Error} */ (error)?.message ?? error)}`;
    res.end(JSON.stringify({ error: message }));
    return;
  }
  await handle(req, res);
}

export const config = { maxDuration: 300 };
