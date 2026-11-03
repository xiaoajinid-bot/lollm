import { HttpError, badRequest } from "../errors.mjs";
import { silentLogger } from "../logger.mjs";
import { now, parseDuration } from "../util/format.mjs";
import { mapOptions, mergeOptions, optionsFromParameters } from "../chat/messages.mjs";
import { renderChatTemplate, renderTemplate } from "../chat/template.mjs";

/** Ollama's documented sampling defaults. */
const OLLAMA_DEFAULTS = {
  temperature: 0.8,
  topP: 0.9,
  topK: 40,
  repeatPenalty: { penalty: 1.1 },
};

/** @param {unknown} value */
function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** @param {string} [message] */
function abortError(message = "request aborted") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/**
 * FIFO counting semaphore with abort support.
 */
export class Semaphore {
  /** @param {number} max */
  constructor(max) {
    this.max = max;
    this.active = 0;
    /** @type {{resolve: (release: () => void) => void, reject: (error: Error) => void, signal?: AbortSignal, onAbort?: () => void}[]} */
    this.queue = [];
  }

  get pending() {
    return this.queue.length;
  }

  /**
   * @param {AbortSignal} [signal]
   * @returns {Promise<() => void>} release function
   */
  acquire(signal) {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve(this.#releaser());
    }
    return new Promise((resolve, reject) => {
      /** @type {any} */
      const waiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.queue.indexOf(waiter);
          if (index !== -1) this.queue.splice(index, 1);
          reject(abortError());
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
    });
  }

  #releaser() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const waiter = this.queue.shift();
      if (waiter) {
        if (waiter.signal && waiter.onAbort) {
          waiter.signal.removeEventListener("abort", waiter.onAbort);
        }
        this.active += 1;
        waiter.resolve(this.#releaser());
      }
    };
  }

  /** Drop everything waiting (used on shutdown). */
  abortAll() {
    for (const waiter of this.queue.splice(0)) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(abortError("engine is shutting down"));
    }
  }
}

/**
 * @typedef {Object} LoadedModel
 * @property {string} name
 * @property {any} handle
 * @property {import("../models/store.mjs").ResolvedModel} resolved
 * @property {number} loadedAt
 * @property {number} lastUsed
 * @property {Date | null} expiresAt
 * @property {NodeJS.Timeout | null} timer
 * @property {number} loadDuration
 * @property {number} activeRequests
 */

/**
 * Owns the llama.cpp state: which model is resident, how many generations run
 * at once, and when models are evicted.
 */
export class Engine {
  /**
   * @param {Object} options
   * @param {import("../models/store.mjs").ModelStore} options.store
   * @param {any} options.backend
   * @param {import("../config.mjs").Config} options.config
   * @param {import("../logger.mjs").Logger} [options.logger]
   */
  constructor(options) {
    this.store = options.store;
    this.backend = options.backend;
    this.config = options.config;
    this.logger = options.logger ?? silentLogger.child("engine");
    /** @type {Map<string, LoadedModel>} */
    this.loaded = new Map();
    /** @type {Map<string, Promise<LoadedModel>>} */
    this.loading = new Map();
    this.semaphore = new Semaphore(Math.max(1, this.config.parallel ?? 1));
    this.startedAt = Date.now();
    this.stats = {
      requests: 0,
      completions: 0,
      embeddings: 0,
      promptTokens: 0,
      completionTokens: 0,
      loads: 0,
      errors: 0,
    };
  }

  // ---------------------------------------------------------------------------
  // Model lifecycle
  // ---------------------------------------------------------------------------

  /**
   * @param {string} modelName
   * @param {{contextSize?: number, gpuLayers?: number, threads?: number}} options
   * @param {number} keepAliveMs
   * @returns {Promise<{record: LoadedModel, fresh: boolean}>}
   */
  async ensureModel(modelName, options, keepAliveMs) {
    const resolved = await this.store.resolve(modelName);
    const existing = this.loaded.get(resolved.name);
    if (existing) {
      existing.lastUsed = now();
      this.#scheduleUnload(existing, keepAliveMs);
      return { record: existing, fresh: false };
    }

    let pending = this.loading.get(resolved.name);
    const fresh = !pending;
    if (!pending) {
      pending = this.#loadModel(resolved, options).finally(() => this.loading.delete(resolved.name));
      this.loading.set(resolved.name, pending);
    }
    const record = await pending;
    record.lastUsed = now();
    this.#scheduleUnload(record, keepAliveMs);
    return { record, fresh };
  }

  /**
   * @param {import("../models/store.mjs").ResolvedModel} resolved
   * @param {{contextSize?: number, gpuLayers?: number, threads?: number}} options
   * @returns {Promise<LoadedModel>}
   */
  async #loadModel(resolved, options) {
    await this.#makeRoom(resolved.name);
    const startedAt = now();
    let handle;
    try {
      handle = await this.backend.loadModel({
        name: resolved.name,
        path: resolved.modelPath,
        // undefined = let llama.cpp use the model's native context window.
        contextSize: positive(options.contextSize ?? this.config.contextSize),
        sequences: Math.max(1, this.config.parallel ?? 1),
        gpuLayers: options.gpuLayers ?? this.config.gpuLayers ?? undefined,
        threads: options.threads ?? this.config.threads ?? undefined,
      });
    } catch (error) {
      this.stats.errors += 1;
      this.logger.error(`failed to load ${resolved.name}: ${/** @type {Error} */ (error).message}`);
      throw new HttpError(500, `failed to load model "${resolved.name}": ${/** @type {Error} */ (error).message}`, {
        code: "model_load_failed",
        cause: error,
      });
    }

    /** @type {LoadedModel} */
    const record = {
      name: resolved.name,
      handle,
      resolved,
      loadedAt: now(),
      lastUsed: now(),
      expiresAt: null,
      timer: null,
      loadDuration: now() - startedAt,
      activeRequests: 0,
    };
    this.loaded.set(resolved.name, record);
    this.stats.loads += 1;
    this.logger.info(
      `loaded ${resolved.name} in ${Math.round(record.loadDuration)}ms (context ${handle.contextSize ?? options.contextSize})`,
    );
    return record;
  }

  /** Evict idle models so a new one fits within `maxLoadedModels`. */
  async #makeRoom(incoming) {
    const max = Math.max(1, this.config.maxLoadedModels ?? 1);
    while (this.loaded.size >= max) {
      const candidates = [...this.loaded.values()]
        .filter((record) => record.name !== incoming)
        .sort((a, b) => a.lastUsed - b.lastUsed);
      const idle = candidates.find((record) => record.activeRequests === 0);
      if (!idle) {
        throw new HttpError(503, "all model slots are busy, retry when the current request finishes", {
          code: "model_slots_busy",
        });
      }
      this.logger.info(`evicting ${idle.name} to make room for ${incoming}`);
      await this.unload(idle.name);
    }
  }

  /**
   * @param {LoadedModel} record
   * @param {number} keepAliveMs
   */
  #scheduleUnload(record, keepAliveMs) {
    if (record.timer) {
      clearTimeout(record.timer);
      record.timer = null;
    }
    if (!Number.isFinite(keepAliveMs)) {
      record.expiresAt = null;
      return;
    }
    if (keepAliveMs <= 0) {
      record.expiresAt = null;
      setImmediate(() => {
        if (record.activeRequests === 0) {
          this.unload(record.name).catch((error) => {
            this.logger.warn(`unload ${record.name} failed: ${/** @type {Error} */ (error).message}`);
          });
        }
      });
      return;
    }
    record.expiresAt = new Date(Date.now() + keepAliveMs);
    record.timer = setTimeout(() => {
      if (record.activeRequests > 0) {
        this.#scheduleUnload(record, keepAliveMs);
        return;
      }
      this.unload(record.name).catch((error) => {
        this.logger.warn(`unload ${record.name} failed: ${/** @type {Error} */ (error).message}`);
      });
    }, keepAliveMs);
    record.timer.unref?.();
  }

  /** @param {string} name */
  async unload(name) {
    const record = this.loaded.get(name) ?? [...this.loaded.values()].find((item) => item.resolved.name === name);
    if (!record) return false;
    if (record.timer) clearTimeout(record.timer);
    this.loaded.delete(record.name);
    try {
      await record.handle.dispose();
    } catch (error) {
      this.logger.warn(`error while unloading ${record.name}: ${/** @type {Error} */ (error).message}`);
    }
    this.logger.info(`unloaded ${record.name}`);
    return true;
  }

  async unloadAll() {
    const names = [...this.loaded.keys()];
    await Promise.all(names.map((name) => this.unload(name)));
    return names.length;
  }

  // ---------------------------------------------------------------------------
  // Generation
  // ---------------------------------------------------------------------------

  /**
   * @param {Object} request
   * @param {string} request.model
   * @param {{role: string, content: string, images?: any[], tool_calls?: any[]}[]} request.messages
   * @param {any[]} [request.tools]
   * @param {"json" | object | undefined} [request.format]
   * @param {Record<string, any>} [request.options]
   * @param {string | number} [request.keepAlive]
   * @param {AbortSignal} [request.signal]
   * @param {(chunk: string) => void | Promise<void>} [request.onToken]
   */
  async chat(request) {
    const { model, messages, tools, format, signal, onToken } = request;
    if (!Array.isArray(messages) || messages.length === 0) {
      throw badRequest("messages must not be empty", "invalid_messages");
    }
    const resolved = await this.store.resolve(model);
    const options = this.#generationOptions(resolved, request.options);
    const keepAliveMs = this.#keepAliveMs(request.keepAlive);
    const timing = { firstTokenAt: 0 };
    const tokenSink = wrapTokenSink(onToken, timing);

    return this.#run(resolved, options, keepAliveMs, signal, timing, async (handle) => {
      const history = this.#withSystemPrompt(resolved, messages);
      if (resolved.template && !tools?.length) {
        const { system, rest } = splitSystemMessages(history);
        const prompt = renderChatTemplate(/** @type {string} */ (resolved.template), {
          system,
          messages: rest,
          tools,
        });
        return handle.complete({ prompt, format, options, signal, onToken: tokenSink });
      }
      return handle.chat({ messages: history, tools, format, options, signal, onToken: tokenSink });
    });
  }

  /**
   * @param {Object} request
   * @param {string} request.model
   * @param {string} request.prompt
   * @param {string | null} [request.system]
   * @param {string | null} [request.template]
   * @param {boolean} [request.raw]
   * @param {"json" | object | undefined} [request.format]
   * @param {Record<string, any>} [request.options]
   * @param {string | number} [request.keepAlive]
   * @param {AbortSignal} [request.signal]
   * @param {(chunk: string) => void | Promise<void>} [request.onToken]
   */
  async complete(request) {
    const { model, prompt, raw, format, signal, onToken } = request;
    if (typeof prompt !== "string") throw badRequest("prompt must be a string", "invalid_prompt");
    const resolved = await this.store.resolve(model);
    const options = this.#generationOptions(resolved, request.options);
    const keepAliveMs = this.#keepAliveMs(request.keepAlive);
    const system = request.system ?? resolved.system ?? "";
    const template = request.template ?? resolved.template ?? null;
    const timing = { firstTokenAt: 0 };
    const tokenSink = wrapTokenSink(onToken, timing);

    return this.#run(resolved, options, keepAliveMs, signal, timing, async (handle) => {
      if (!raw && !template) {
        // No stored template: let node-llama-cpp apply the model's own chat wrapper.
        const messages = [
          ...(system ? [{ role: "system", content: system }] : []),
          { role: "user", content: prompt },
        ];
        return handle.chat({ messages, format, options, signal, onToken: tokenSink });
      }
      const text = raw
        ? prompt
        : renderTemplate(/** @type {string} */ (template), {
            System: system,
            Prompt: prompt,
            Response: "",
            Messages: [
              ...(system ? [{ Role: "system", Content: system }] : []),
              { Role: "user", Content: prompt },
            ],
          });
      return handle.complete({ prompt: text, format, options, signal, onToken: tokenSink });
    });
  }

  /**
   * @param {Object} request
   * @param {string} request.model
   * @param {string[]} request.input
   * @param {Record<string, any>} [request.options]
   * @param {string | number} [request.keepAlive]
   * @param {AbortSignal} [request.signal]
   */
  async embed(request) {
    const { model, input, signal } = request;
    if (!Array.isArray(input) || input.length === 0) {
      throw badRequest("input must be a non-empty string or array of strings", "invalid_input");
    }
    const resolved = await this.store.resolve(model);
    const options = this.#generationOptions(resolved, request.options);
    const keepAliveMs = this.#keepAliveMs(request.keepAlive);
    const startedAt = now();
    const release = await this.semaphore.acquire(signal);
    try {
      const { record } = await this.ensureModel(resolved.name, options, keepAliveMs);
      record.activeRequests += 1;
      try {
        const result = await record.handle.embed({ input, signal });
        this.stats.requests += 1;
        this.stats.embeddings += 1;
        this.stats.promptTokens += result.promptTokens ?? 0;
        return {
          model: resolved.name,
          embeddings: result.vectors,
          promptTokens: result.promptTokens ?? 0,
          timings: {
            totalDuration: now() - startedAt,
            loadDuration: 0,
            promptEvalDuration: now() - startedAt,
            evalDuration: 0,
            promptTokens: result.promptTokens ?? 0,
            completionTokens: 0,
          },
          details: resolved.details,
        };
      } finally {
        record.activeRequests -= 1;
      }
    } catch (error) {
      if (/** @type {Error} */ (error)?.name !== "AbortError") this.stats.errors += 1;
      throw error;
    } finally {
      release();
    }
  }

  /**
   * Shared pipeline: queue → load → generate → timings → stats.
   *
   * @param {import("../models/store.mjs").ResolvedModel} resolved
   * @param {Record<string, any>} options
   * @param {number} keepAliveMs
   * @param {AbortSignal | undefined} signal
   * @param {{firstTokenAt: number}} timing
   * @param {(handle: any) => Promise<any>} run
   */
  async #run(resolved, options, keepAliveMs, signal, timing, run) {
    const requestStart = now();
    const release = await this.semaphore.acquire(signal);
    try {
      const loadStart = now();
      const { record, fresh } = await this.ensureModel(resolved.name, options, keepAliveMs);
      const loadDuration = fresh ? now() - loadStart : 0;
      record.activeRequests += 1;
      const generationStart = now();
      try {
        const result = await run(record.handle);
        const generationEnd = now();
        const totalGeneration = generationEnd - generationStart;
        const first = timing.firstTokenAt;
        const promptTokens = result.promptTokens ?? 0;
        const completionTokens = result.completionTokens ?? 0;
        let promptEvalDuration;
        let evalDuration;
        if (first > 0) {
          promptEvalDuration = first - generationStart;
          evalDuration = generationEnd - first;
        } else {
          // Non-streaming request: estimate the split from token counts.
          const totalTokens = promptTokens + completionTokens;
          const share = totalTokens > 0 ? promptTokens / totalTokens : 0.5;
          promptEvalDuration = totalGeneration * share;
          evalDuration = totalGeneration - promptEvalDuration;
        }
        this.stats.requests += 1;
        this.stats.completions += 1;
        this.stats.promptTokens += promptTokens;
        this.stats.completionTokens += completionTokens;
        return {
          model: resolved.name,
          text: result.text ?? "",
          toolCalls: result.toolCalls ?? [],
          stopReason: result.stopReason,
          timings: {
            totalDuration: now() - requestStart,
            loadDuration,
            promptEvalDuration,
            evalDuration,
            promptTokens,
            completionTokens,
          },
          details: resolved.details,
        };
      } finally {
        record.activeRequests -= 1;
      }
    } catch (error) {
      if (/** @type {Error} */ (error)?.name !== "AbortError") this.stats.errors += 1;
      throw error;
    } finally {
      release();
    }
  }

  // ---------------------------------------------------------------------------
  // Introspection
  // ---------------------------------------------------------------------------

  async ps() {
    return [...this.loaded.values()].map((record) => ({
      name: record.name,
      model: record.name,
      size: record.resolved.size,
      digest: record.resolved.digest,
      details: record.resolved.details,
      expires_at: record.expiresAt ? record.expiresAt.toISOString() : "forever",
      size_vram: vramBytes(record),
    }));
  }

  status() {
    return {
      backend: this.backend.kind,
      parallel: this.config.parallel,
      queue: this.semaphore.pending,
      active: this.semaphore.active,
      loaded: [...this.loaded.values()].map((record) => ({
        name: record.name,
        loadedAt: new Date(record.loadedAt).toISOString(),
        lastUsed: new Date(record.lastUsed).toISOString(),
        expiresAt: record.expiresAt ? record.expiresAt.toISOString() : null,
        contextSize: record.handle.contextSize,
        size: record.resolved?.size,
      })),
      stats: { ...this.stats },
      uptimeMs: Date.now() - this.startedAt,
    };
  }

  async dispose() {
    this.semaphore.abortAll();
    await this.unloadAll();
    await this.backend.dispose?.();
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * @param {import("../models/store.mjs").ResolvedModel} resolved
   * @param {Record<string, any> | undefined} requestOptions
   */
  #generationOptions(resolved, requestOptions) {
    const fromModel = optionsFromParameters(resolved.parameters);
    const fromRequest = mapOptions(requestOptions, {
      contextSize: this.config.contextSize ?? undefined,
      maxTokens: this.config.maxTokens ?? undefined,
      gpuLayers: this.config.gpuLayers,
      threads: this.config.threads,
    });
    return mergeOptions(OLLAMA_DEFAULTS, fromModel, fromRequest);
  }

  /**
   * @param {string | number | undefined} keepAlive
   */
  #keepAliveMs(keepAlive) {
    if (keepAlive === undefined || keepAlive === null) return parseDuration(this.config.keepAlive);
    return parseDuration(keepAlive, parseDuration(this.config.keepAlive));
  }

  /**
   * @param {import("../models/store.mjs").ResolvedModel} resolved
   * @param {any[]} messages
   */
  #withSystemPrompt(resolved, messages) {
    if (!resolved.system) return messages;
    if (messages.some((message) => message.role === "system")) return messages;
    return [{ role: "system", content: resolved.system }, ...messages];
  }
}

/**
 * @param {((chunk: string) => void | Promise<void>) | undefined} onToken
 * @param {{firstTokenAt: number}} timing
 */
function wrapTokenSink(onToken, timing) {
  if (!onToken) return undefined;
  return (chunk) => {
    if (!timing.firstTokenAt) timing.firstTokenAt = now();
    return onToken(chunk);
  };
}

/** @param {any} record */
function vramBytes(record) {
  const model = record.handle?.model;
  const gpuLayers = model?.gpuLayers ?? 0;
  if (!gpuLayers) return 0;
  const info = record.handle?.modelInfo ?? null;
  const totalLayers = info?.blockCount ?? record.resolved?.gguf?.blockCount;
  const size = record.resolved?.size ?? 0;
  if (!totalLayers) return size;
  return Math.round((size * gpuLayers) / totalLayers);
}

/**
 * Pull the system prompt out of a message list, matching what Ollama templates
 * expect (`.System` separate, `.Messages` without system entries).
 * @param {{role: string, content: string}[]} messages
 */
export function splitSystemMessages(messages) {
  /** @type {string[]} */
  const systems = [];
  const rest = [];
  for (const message of messages) {
    if (message.role === "system") systems.push(message.content);
    else rest.push(message);
  }
  return { system: systems.join("\n\n"), rest };
}
