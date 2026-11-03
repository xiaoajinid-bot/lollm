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
 * A real model is far too large to ship in the function bundle, so the platform
 * pulls one into its temporary storage on the first invocation of an instance
 * (~258 MB, a few seconds from Hugging Face). Point LOLLM_BOOT_MODEL at any
 * `hf:`, `https://…` or `file:` reference to change it, or set it to `0` to
 * disable the boot pull entirely.
 */
const DEFAULT_BOOT_MODEL = "hf:bartowski/SmolLM2-360M-Instruct-GGUF:SmolLM2-360M-Instruct-Q4_K_M.gguf";
const DEFAULT_BOOT_NAME = "smollm2:360m";

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
 * Make sure the boot model is present in the (ephemeral) model store.
 *
 * @param {any} instance
 * @returns {Promise<string | undefined>}
 */
async function ensureBootModel(instance) {
  const ref = process.env.LOLLM_BOOT_MODEL ?? DEFAULT_BOOT_MODEL;
  if (!ref || ref === "0" || ref === "none") return undefined;
  const name = process.env.LOLLM_BOOT_MODEL_NAME ?? DEFAULT_BOOT_NAME;
  const existing = await instance.store.find(name).catch(() => null);
  if (existing) return existing.display;

  const startedAt = Date.now();
  instance.logger.info(`pulling boot model ${ref} as ${name}`);
  const pulled = await instance.store.pull(ref, { name });
  instance.logger.info(
    `boot model ready as ${pulled?.display ?? name} in ${Math.round((Date.now() - startedAt) / 1000)}s`,
  );
  return pulled?.display ?? name;
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

/**
 * Visibility for the cold start: `GET /api/boot` answers with what the function
 * is actually running, so a failed pull or a missing native binding can be seen
 * without opening the platform log viewer.
 */
const boot = {
  status: /** @type {"pending" | "ready" | "error"} */ ("pending"),
  startedAt: 0,
  ms: 0,
  backend: "",
  home: "",
  model: /** @type {string | undefined} */ (undefined),
  error: /** @type {string | undefined} */ (undefined),
  threads: "",
  cpus: 0,
  parallel: 0,
  totalMemMb: 0,
};

async function start() {
  const home = await resolveHome();
  boot.startedAt = Date.now();
  boot.home = home;
  boot.backend = process.env.LOLLM_BACKEND ?? "mock";
  boot.cpus = os.cpus().length;
  boot.parallel = os.availableParallelism?.() ?? 0;
  boot.totalMemMb = Math.round(os.totalmem() / 1e6);
  // A sandbox reports the *host* core count (often 64+), and llama.cpp happily
  // spawns that many workers on the two vCPUs it actually gets, which collapses
  // generation to a crawl. Cap the default at the CPU quota we can really use.
  if (!process.env.LOLLM_THREADS && process.env.LOLLM_BACKEND === "llama") {
    process.env.LOLLM_THREADS = String(Math.min(4, Math.max(1, boot.parallel || 2)));
  }
  boot.threads = process.env.LOLLM_THREADS ?? "auto";
  const instance = await createInstance({
    home,
    backend: process.env.LOLLM_BACKEND ?? "mock",
    playground: process.env.LOLLM_PLAYGROUND !== "0",
    modelsDir: process.env.LOLLM_MODELS_DIR ?? undefined,
  });
  if (process.env.LOLLM_BACKEND !== "llama") {
    await seedDemoModel(instance.store).catch(() => {});
  } else {
    try {
      boot.model = await ensureBootModel(instance);
    } catch (error) {
      const message = String(/** @type {Error} */ (error)?.message ?? error);
      boot.error = message;
      instance.logger.warn(`boot model unavailable: ${message}`);
    }
  }
  boot.status = boot.error ? "error" : "ready";
  boot.ms = Date.now() - boot.startedAt;
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
  ready ??= start();
  let handle;
  try {
    handle = await ready;
  } catch (error) {
    // Never retry a broken boot on every request; report it once, clearly.
    ready = undefined;
    boot.status = "error";
    boot.error = String(/** @type {Error} */ (error)?.message ?? error);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    const message = `lollm failed to start: ${String(/** @type {Error} */ (error)?.message ?? error)}`;
    res.end(JSON.stringify({ error: message }));
    return;
  }

  // Diagnostics for the cold start (model download, backend, temp dir).
  if ((req.url ?? "").split("?")[0] === "/api/boot") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ...boot, uptimeMs: boot.startedAt ? Date.now() - boot.startedAt : 0 }));
    return;
  }

  await handle(req, res);
}

export const config = { maxDuration: 300 };
