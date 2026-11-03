import { resolveConfig } from "./config.mjs";
import { createLogger } from "./logger.mjs";
import { ModelStore } from "./models/store.mjs";
import { Engine } from "./engine/engine.mjs";
import { createLlamaBackend } from "./engine/llama-backend.mjs";
import { createMockBackend } from "./engine/mock-backend.mjs";
import { createServer, startServer } from "./server.mjs";
import { APP_NAME, VERSION } from "./version.mjs";

export { Engine, ModelStore, createServer, startServer, resolveConfig, createLogger };
export { createLlamaBackend, createMockBackend };
export { APP_NAME, VERSION };
export { parseModelName, parseReference, nameFromFile } from "./models/registry.mjs";
export { parseModelfile } from "./models/modelfile.mjs";
export { readGgufInfo } from "./models/gguf.mjs";
export { renderTemplate, renderChatTemplate } from "./chat/template.mjs";

/**
 * Assemble a ready-to-run instance (config → store → backend → engine → server)
 * without binding a port. Handy for embedding lollm in tests or in another
 * Node process.
 *
 * @param {Record<string, any> & {backend?: any, logger?: import("./logger.mjs").Logger}} [options]
 */
export async function createInstance(options = {}) {
  const config = resolveConfig(options);
  const logger = options.logger ?? createLogger({ level: config.logLevel });
  // `options.backend` may be an instance (tests) or a string from the CLI flags.
  const injectedBackend =
    options.backend && typeof options.backend.loadModel === "function" ? options.backend : undefined;
  const backend =
    injectedBackend ??
    (config.backend === "mock"
      ? createMockBackend({ logger: logger.child("mock") })
      : createLlamaBackend({ config, logger: logger.child("llama") }));

  const store = new ModelStore({
    modelsDir: config.modelsDir,
    logger: logger.child("store"),
    registry: config.ollamaRegistry,
    hfToken: config.hfToken,
    hfEndpoint: config.hfEndpoint,
    allowInsecure: config.allowInsecure,
    fetchImpl: options.fetchImpl,
  });
  await store.init();

  const engine = new Engine({ store, backend, config, logger: logger.child("engine") });
  const server = createServer({ config, store, engine, logger: logger.child("http") });
  return { config, logger, backend, store, engine, server };
}

/**
 * Same as `createInstance`, but listens on the configured host/port.
 * @param {Record<string, any>} [options]
 */
export async function start(options = {}) {
  const instance = await createInstance(options);
  const listener = await startServer({
    config: instance.config,
    store: instance.store,
    engine: instance.engine,
    logger: instance.logger.child("http"),
  });
  return { ...instance, ...listener, url: listener.url };
}
