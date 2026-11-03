import { createHash } from "node:crypto";
import { silentLogger } from "../logger.mjs";
import { estimateTokens } from "../chat/messages.mjs";

/**
 * Deterministic in-process backend.
 *
 * Used by the test suite, and by `lollm serve --backend mock` for wiring up
 * clients / CI without a multi-gigabyte model. It implements the exact same
 * contract as the llama.cpp backend, including token streaming and tool calls,
 * so the HTTP layer can be verified end-to-end.
 */
export function createMockBackend(options = {}) {
  const logger = options.logger ?? silentLogger.child("mock");
  const latencyMs = options.latencyMs ?? 0;
  const loadDelayMs = options.loadDelayMs ?? 0;
  /** @type {Set<any>} */
  const handles = new Set();

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** @param {AbortSignal | undefined} signal */
  const assertLive = (signal) => {
    if (signal?.aborted) {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }
  };

  return {
    kind: "mock",
    capabilities: { tools: true, embeddings: true },

    /**
     * @param {{name: string, path: string, contextSize: number, sequences: number}} input
     */
    async loadModel(input) {
      if (loadDelayMs > 0) await sleep(loadDelayMs);
      logger.debug(`loading mock model ${input.name}`);
      const modelName = input.name;

      /**
       * Build the deterministic "completion" for a prompt.
       * @param {string} prompt
       * @param {any[] | undefined} tools
       * @param {any} format
       */
      const respond = (prompt, tools, format) => {
        const trimmed = prompt.trim();
        if (tools?.length && trimmed.startsWith("/tool")) {
          return {
            text: "",
            toolCalls: [{ name: tools[0].function.name, arguments: {} }],
          };
        }
        if (format === "json" || (format && typeof format === "object")) {
          return { text: JSON.stringify({ mock: true, model: modelName }), toolCalls: [] };
        }
        if (trimmed === "") return { text: `[${modelName}] Hello.`, toolCalls: [] };
        return { text: `[${modelName}] ${trimmed}`, toolCalls: [] };
      };

      /** @param {string} text */
      const streamOut = async (text, signal, onToken) => {
        if (!onToken) return 0;
        const chunks = text.match(/\s*\S+|\s+$/g) ?? [];
        let emitted = 0;
        for (const chunk of chunks) {
          assertLive(signal);
          if (latencyMs > 0) await sleep(latencyMs);
          onToken(chunk);
          emitted += 1;
        }
        return emitted;
      };

      const handle = {
        name: input.name,
        path: input.path,
        contextSize: input.contextSize ?? null,
        sequences: input.sequences,

        /**
         * @param {{messages: {role: string, content: string}[], tools?: any[], format?: any,
         *          options?: Record<string, any>, signal?: AbortSignal, onToken?: (t: string) => void}} request
         */
        async chat(request) {
          assertLive(request.signal);
          const messages = request.messages ?? [];
          const lastUser = [...messages].reverse().find((message) => message.role === "user");
          const prompt = lastUser?.content ?? "";
          const { text, toolCalls } = respond(prompt, request.tools, request.format);
          const chunks = await streamOut(text, request.signal, request.onToken);
          return {
            text,
            toolCalls,
            promptTokens: messages.reduce((sum, message) => sum + estimateTokens(message.content), 0),
            completionTokens: chunks || Math.max(1, Math.ceil(text.length / 4)),
            stopReason: toolCalls.length > 0 ? "functionCalls" : "eogToken",
          };
        },

        /**
         * @param {{prompt: string, format?: any, options?: Record<string, any>,
         *          signal?: AbortSignal, onToken?: (t: string) => void}} request
         */
        async complete(request) {
          assertLive(request.signal);
          const { text, toolCalls } = respond(request.prompt ?? "", undefined, request.format);
          const chunks = await streamOut(text, request.signal, request.onToken);
          return {
            text,
            toolCalls,
            promptTokens: estimateTokens(request.prompt ?? ""),
            completionTokens: chunks || Math.max(1, Math.ceil(text.length / 4)),
            stopReason: "eogToken",
          };
        },

        /**
         * @param {{input: string[], signal?: AbortSignal}} request
         */
        async embed(request) {
          assertLive(request.signal);
          const vectors = (request.input ?? []).map((text) => hashEmbedding(text));
          return { vectors, promptTokens: (request.input ?? []).reduce((sum, t) => sum + estimateTokens(t), 0) };
        },

        /** @param {string} text */
        countTokens(text) {
          return estimateTokens(text);
        },

        async dispose() {
          handles.delete(handle);
        },
      };

      handles.add(handle);
      return handle;
    },

    async dispose() {
      for (const handle of handles) await handle.dispose();
      handles.clear();
    },
  };
}

/**
 * Hash-based pseudo-embedding: stable across runs, normalized to unit length.
 * @param {string} text
 * @param {number} [dimensions]
 */
export function hashEmbedding(text, dimensions = 32) {
  /** @type {number[]} */
  const values = [];
  let counter = 0;
  while (values.length < dimensions) {
    const digest = createHash("sha256").update(`${text}\u0000${counter}`).digest();
    for (let i = 0; i < digest.length && values.length < dimensions; i += 4) {
      const int = digest.readInt32LE(i);
      values.push(int / 0x7fffffff);
    }
    counter += 1;
  }
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
  return values.map((value) => Number((value / norm).toFixed(6)));
}
