import { silentLogger } from "../logger.mjs";
import { toolsToFunctions } from "../chat/messages.mjs";

/**
 * llama.cpp backend, via node-llama-cpp (the same bindings Ollama's JavaScript
 * users reach for). Everything heavy is imported lazily so the CLI, the model
 * store and the tests all work on machines where the native addon has not been
 * built yet.
 *
 * @param {{config?: Record<string, any>, logger?: import("../logger.mjs").Logger}} [options]
 */
export function createLlamaBackend(options = {}) {
  const logger = options.logger ?? silentLogger.child("llama");
  const config = options.config ?? {};

  /** @type {Promise<any> | null} */
  let modulePromise = null;
  /** @type {Promise<any> | null} */
  let llamaPromise = null;
  /** @type {Set<any>} */
  const handles = new Set();
  /** @type {WeakMap<any, any>} */
  const grammarCache = new WeakMap();

  async function loadModule() {
    if (!modulePromise) {
      modulePromise = import("node-llama-cpp").catch((error) => {
        modulePromise = null;
        const hint =
          "node-llama-cpp is required for real inference. Install it with " +
          "`npm install node-llama-cpp` (or set LOLLM_BACKEND=mock to run without a model).";
        throw new Error(`${hint}\nOriginal error: ${/** @type {Error} */ (error).message}`);
      });
    }
    return modulePromise;
  }

  async function getLlamaInstance() {
    if (!llamaPromise) {
      llamaPromise = (async () => {
        const mod = await loadModule();
        const gpu = config.gpu === false || config.gpu === "false" ? false : config.gpu || "auto";
        logger.debug(`initialising llama.cpp (gpu: ${String(gpu)})`);
        return mod.getLlama({
          gpu,
          logLevel: config.logLevel === "debug" || config.verbose ? "info" : "warn",
        });
      })().catch((error) => {
        llamaPromise = null;
        throw error;
      });
    }
    return llamaPromise;
  }

  /** @param {any} handle */
  function makeLocks(handle) {
    /** @type {any[]} */
    const free = [];
    /** @type {((sequence: any) => void)[]} */
    const waiters = [];
    return {
      /** @param {any} sequence */
      add(sequence) {
        free.push(sequence);
      },
      async acquire() {
        const sequence = free.pop();
        if (sequence) return sequence;
        return new Promise((resolve) => waiters.push(resolve));
      },
      /** @param {any} sequence */
      release(sequence) {
        const next = waiters.shift();
        if (next) next(sequence);
        else free.push(sequence);
      },
      releaseAll() {
        while (waiters.length > 0) waiters.shift()?.(null);
      },
      dispose() {
        free.length = 0;
        waiters.length = 0;
      },
    };
  }

  return {
    kind: "llama",
    capabilities: { tools: true, embeddings: true },

    /**
     * @param {{name: string, path: string, contextSize: number, sequences: number,
     *          gpuLayers?: number | null, threads?: number}} input
     */
    async loadModel(input) {
      const mod = await loadModule();
      const llama = await getLlamaInstance();
      const modelOptions = { modelPath: input.path };
      if (input.gpuLayers !== undefined && input.gpuLayers !== null) {
        modelOptions.gpuLayers = input.gpuLayers;
      }
      logger.info(`loading ${input.name} (context ${input.contextSize}, ${input.sequences} sequence(s))`);
      const model = await llama.loadModel(modelOptions);
      /** @type {any} */
      let context;
      try {
        context = await model.createContext({
          contextSize: input.contextSize,
          sequences: input.sequences,
          ...(input.threads ? { threads: input.threads } : {}),
        });
      } catch (error) {
        await model.dispose?.();
        throw error;
      }

      /** @type {any[]} */
      const sequences = [];
      for (let i = 0; i < input.sequences; i += 1) {
        sequences.push(context.getSequence());
      }
      const locks = makeLocks({});
      for (const sequence of sequences) locks.add(sequence);

      /** @type {any} */
      let embeddingContext = null;
      let disposed = false;

      /** @param {string | object} format */
      async function grammarFor(format) {
        if (!format) return undefined;
        let cache = grammarCache.get(llama);
        if (!cache) {
          cache = new Map();
          grammarCache.set(llama, cache);
        }
        const key = typeof format === "string" ? format : JSON.stringify(format);
        if (cache.has(key)) return cache.get(key);
        const grammar =
          typeof format === "string"
            ? await llama.getGrammarFor(format === "json" ? "json" : format)
            : await llama.createGrammarForJsonSchema(format);
        cache.set(key, grammar);
        return grammar;
      }

      /** @param {string} text */
      const tokenCount = (text) => {
        try {
          return model.tokenize(String(text ?? "")).length;
        } catch {
          return Math.max(1, Math.ceil(String(text ?? "").length / 4));
        }
      };

      /**
       * "No limit" still has to stop somewhere: a generation can never exceed
       * the context window. When the caller sets no cap, generate until EOG or
       * until the window is full (Ollama's num_predict: -1 behaves the same).
       * @param {number | undefined} requested
       * @param {number} promptTokens
       */
      const tokenBudget = (requested, promptTokens) => {
        if (typeof requested === "number" && requested > 0) return requested;
        const window = Number(context.contextSize) || 0;
        if (!window) return undefined;
        return Math.max(1, window - promptTokens);
      };

      const handle = {
        name: input.name,
        path: input.path,
        contextSize: context.contextSize,
        sequences: input.sequences,
        model,
        context,

        /**
         * @param {{messages: any[], tools?: any[], format?: any, options?: Record<string, any>,
         *          signal?: AbortSignal, onToken?: (text: string) => void}} request
         */
        async chat(request) {
          const options = request.options ?? {};
          const sequence = await locks.acquire();
          if (!sequence) throw new Error("model was unloaded");
          try {
            const chat = new mod.LlamaChat({ contextSequence: sequence, chatWrapper: "auto" });
            try {
              const history = toChatHistory(request.messages);
              const promptTokens = tokenCount(history.map((item) => item.text).join("\n"));
              // Count real tokens instead of re-tokenizing the detokenized text:
              // byte-level tokens do not round-trip and would inflate `eval_count`.
              let completionTokens = 0;
              const generation = {
                maxTokens: tokenBudget(options.maxTokens, promptTokens),
                temperature: options.temperature,
                topP: options.topP,
                topK: options.topK,
                minP: options.minP,
                seed: options.seed,
                repeatPenalty: options.repeatPenalty,
                customStopTriggers: options.stop,
                signal: request.signal,
                stopOnAbortSignal: true,
                onTextChunk: request.onToken,
                onToken: (tokens) => {
                  completionTokens += tokens.length;
                },
              };
              const grammar = await grammarFor(request.format);
              if (grammar) generation.grammar = grammar;
              const functions = toolsToFunctions(request.tools);
              if (functions) {
                generation.functions = functions;
                generation.documentFunctionParams = true;
              }
              const response = await chat.generateResponse(history, generation);
              const text = response.response ?? "";
              const toolCalls = (response.functionCalls ?? []).map((call) => ({
                name: call.functionName,
                arguments: call.params ?? {},
              }));
              return {
                text,
                toolCalls,
                promptTokens,
                completionTokens,
                stopReason: response.metadata?.stopReason ?? "eogToken",
              };
            } finally {
              chat.dispose();
            }
          } finally {
            locks.release(sequence);
          }
        },

        /**
         * @param {{prompt: string, tools?: any[], format?: any, options?: Record<string, any>,
         *          signal?: AbortSignal, onToken?: (text: string) => void}} request
         */
        async complete(request) {
          const options = request.options ?? {};
          const sequence = await locks.acquire();
          if (!sequence) throw new Error("model was unloaded");
          try {
            const completion = new mod.LlamaCompletion({ contextSequence: sequence });
            try {
              const promptTokens = tokenCount(request.prompt);
              let completionTokens = 0;
              const generation = {
                maxTokens: tokenBudget(options.maxTokens, promptTokens),
                temperature: options.temperature,
                topP: options.topP,
                topK: options.topK,
                minP: options.minP,
                seed: options.seed,
                repeatPenalty: options.repeatPenalty,
                customStopTriggers: options.stop,
                signal: request.signal,
                stopOnAbortSignal: true,
                onTextChunk: request.onToken,
                onToken: (tokens) => {
                  completionTokens += tokens.length;
                },
              };
              const grammar = await grammarFor(request.format);
              if (grammar) generation.grammar = grammar;
              const result = await completion.generateCompletionWithMeta(request.prompt, generation);
              const text = result.completion ?? "";
              return {
                text,
                toolCalls: [],
                promptTokens,
                completionTokens,
                stopReason: result.stopReason ?? "eogToken",
              };
            } finally {
              completion.dispose();
            }
          } finally {
            locks.release(sequence);
          }
        },

        /**
         * @param {{input: string[], signal?: AbortSignal}} request
         */
        async embed(request) {
          if (!embeddingContext) {
            embeddingContext = await model.createEmbeddingContext({
              contextSize: Math.max(512, Math.min(2048, input.contextSize)),
            });
          }
          /** @type {number[][]} */
          const vectors = [];
          let promptTokens = 0;
          for (const text of request.input ?? []) {
            if (request.signal?.aborted) {
              const error = new Error("aborted");
              error.name = "AbortError";
              throw error;
            }
            const embedding = await embeddingContext.getEmbeddingFor(text);
            vectors.push(Array.from(embedding.vector));
            promptTokens += tokenCount(text);
          }
          return { vectors, promptTokens };
        },

        tokenCount,

        async dispose() {
          if (disposed) return;
          disposed = true;
          locks.releaseAll();
          locks.dispose();
          try {
            await embeddingContext?.dispose?.();
          } catch {
            /* ignore */
          }
          try {
            await context.dispose?.();
          } catch {
            /* ignore */
          }
          try {
            await model.dispose?.();
          } catch {
            /* ignore */
          }
          handles.delete(handle);
        },
      };

      handles.add(handle);
      return handle;
    },

    async dispose() {
      for (const handle of [...handles]) {
        await handle.dispose();
      }
      handles.clear();
      if (llamaPromise) {
        try {
          const llama = await llamaPromise;
          await llama.dispose?.();
        } catch {
          /* ignore */
        }
        llamaPromise = null;
      }
    },
  };
}

/**
 * Convert wire messages to node-llama-cpp chat history items.
 * @param {any[]} messages
 */
export function toChatHistory(messages) {
  const history = [];
  for (const message of messages ?? []) {
    if (message.role === "system") {
      history.push({ type: "system", text: String(message.content ?? "") });
      continue;
    }
    if (message.role === "assistant") {
      let text = String(message.content ?? "");
      if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        const calls = message.tool_calls
          .map((call) => JSON.stringify({ name: call.function?.name, arguments: safeJson(call.function?.arguments) }))
          .join("\n");
        text = text ? `${text}\n${calls}` : calls;
      }
      history.push({ type: "model", text });
      continue;
    }
    if (message.role === "tool") {
      const label = message.name ? ` (${message.name})` : "";
      history.push({ type: "user", text: `Tool result${label}: ${String(message.content ?? "")}` });
      continue;
    }
    history.push({ type: "user", text: String(message.content ?? "") });
  }
  return history;
}

/** @param {unknown} value */
function safeJson(value) {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
