import { HttpError, badRequest, notFound } from "../errors.mjs";
import { readJson, sendJson } from "../util/http.mjs";
import { startSse } from "../util/sse.mjs";
import { normalizeMessages, normalizeTools, finishReason } from "../chat/messages.mjs";
import { APP_NAME } from "../version.mjs";
import {
  createdSeconds,
  normalizeFormat,
  openAiToolCalls,
  randomId,
  toInputArray,
} from "./shared.mjs";

/**
 * OpenAI-compatible surface (`/v1/*`), so the official `openai` SDKs, LangChain,
 * Vercel AI SDK, Continue, etc. can talk to a local llama.cpp model.
 *
 * @param {{engine: import("../engine/engine.mjs").Engine,
 *          store: import("../models/store.mjs").ModelStore,
 *          config: import("../config.mjs").Config,
 *          logger: import("../logger.mjs").Logger}} deps
 */
export function createOpenAiApi({ engine, store, config, logger }) {
  /**
   * OpenAI requires a model id; if the client omitted it, use the first local
   * model so "just works" clients (and quick curl tests) succeed.
   * @param {unknown} model
   */
  const resolveModel = async (model) => {
    if (typeof model === "string" && model.trim() !== "") return model.trim();
    const models = await store.list();
    if (models.length === 0) {
      throw notFound("no models installed yet — run `lollm pull <model>` first", "model_not_found");
    }
    return models[0].name;
  };

  /**
   * @param {Record<string, any>} body
   * @param {Record<string, any>} overrides
   */
  const buildOptions = (body, overrides = {}) => ({
    temperature: body.temperature,
    top_p: body.top_p,
    top_k: body.top_k,
    min_p: body.min_p,
    seed: body.seed,
    num_predict: body.max_tokens ?? body.max_completion_tokens ?? body.num_predict,
    stop: body.stop,
    presence_penalty: body.presence_penalty,
    frequency_penalty: body.frequency_penalty,
    ...overrides,
  });

  /** @param {Record<string, any>} responseFormat */
  const formatFromResponseFormat = (responseFormat) => {
    if (!responseFormat || typeof responseFormat !== "object") return undefined;
    if (responseFormat.type === "json_object") return "json";
    if (responseFormat.type === "json_schema") {
      const schema = responseFormat.json_schema?.schema ?? responseFormat.json_schema;
      if (schema && typeof schema === "object") return schema;
    }
    return undefined;
  };

  /** @param {import("../router.mjs").RequestContext} ctx */
  const chatCompletions = async (ctx) => {
    const body = await readJson(ctx.req, { limit: config.maxBodyBytes });
    const model = await resolveModel(body.model);
    await store.resolve(model);
    const messages = normalizeMessages(body.messages);
    const tools = normalizeTools(body.tools ?? body.functions?.map?.((fn) => ({ type: "function", function: fn })));
    const format = formatFromResponseFormat(body.response_format);
    const stream = body.stream === true;
    const includeUsage = body.stream_options?.include_usage === true;
    const options = buildOptions(body);

    if (!stream) {
      const result = await engine.chat({
        model,
        messages,
        tools,
        format,
        options,
        keepAlive: body.keep_alive,
        signal: ctx.signal,
      });
      const toolCalls = openAiToolCalls(result.toolCalls);
      const finish = finishReason(result.stopReason, result.toolCalls.length > 0);
      sendJson(ctx.res, 200, {
        id: `chatcmpl-${randomId()}`,
        object: "chat.completion",
        created: createdSeconds(),
        model: result.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: toolCalls.length > 0 ? result.text || null : result.text,
              ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
            },
            logprobs: null,
            finish_reason: finish,
          },
        ],
        usage: {
          prompt_tokens: result.timings.promptTokens,
          completion_tokens: result.timings.completionTokens,
          total_tokens: result.timings.promptTokens + result.timings.completionTokens,
        },
        system_fingerprint: APP_NAME,
      });
      return;
    }

    const sse = startSse(ctx.res);
    const id = `chatcmpl-${randomId()}`;
    const created = createdSeconds();
    const chunkObject = "chat.completion.chunk";
    try {
      await sse.write({
        id,
        object: chunkObject,
        created,
        model,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, logprobs: null, finish_reason: null }],
      });
      const result = await engine.chat({
        model,
        messages,
        tools,
        format,
        options,
        keepAlive: body.keep_alive,
        signal: ctx.signal,
        onToken: async (chunk) => {
          await sse.write({
            id,
            object: chunkObject,
            created,
            model,
            choices: [{ index: 0, delta: { content: chunk }, logprobs: null, finish_reason: null }],
          });
        },
      });
      const toolCalls = openAiToolCalls(result.toolCalls);
      if (toolCalls.length > 0) {
        await sse.write({
          id,
          object: chunkObject,
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: toolCalls.map((call, index) => ({
                  index,
                  id: call.id,
                  type: "function",
                  function: call.function,
                })),
              },
              logprobs: null,
              finish_reason: null,
            },
          ],
        });
      }
      await sse.write({
        id,
        object: chunkObject,
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {},
            logprobs: null,
            finish_reason: finishReason(result.stopReason, result.toolCalls.length > 0),
          },
        ],
      });
      if (includeUsage) {
        await sse.write({
          id,
          object: chunkObject,
          created,
          model,
          choices: [],
          usage: {
            prompt_tokens: result.timings.promptTokens,
            completion_tokens: result.timings.completionTokens,
            total_tokens: result.timings.promptTokens + result.timings.completionTokens,
          },
        });
      }
      await sse.write("[DONE]");
      await sse.end();
    } catch (error) {
      await sse.end().catch(() => {});
      throw error;
    }
  };

  /** @param {import("../router.mjs").RequestContext} ctx */
  const completions = async (ctx) => {
    const body = await readJson(ctx.req, { limit: config.maxBodyBytes });
    const model = await resolveModel(body.model);
    await store.resolve(model);
    const prompt = Array.isArray(body.prompt) ? String(body.prompt[0] ?? "") : String(body.prompt ?? "");
    if (!prompt) throw badRequest("prompt is required", "invalid_prompt");
    const stream = body.stream === true;
    const options = buildOptions(body);
    const format = formatFromResponseFormat(body.response_format);

    if (!stream) {
      const result = await engine.complete({
        model,
        prompt,
        format,
        options,
        keepAlive: body.keep_alive,
        signal: ctx.signal,
      });
      sendJson(ctx.res, 200, {
        id: `cmpl-${randomId()}`,
        object: "text_completion",
        created: createdSeconds(),
        model: result.model,
        choices: [
          {
            index: 0,
            text: result.text,
            logprobs: null,
            finish_reason: finishReason(result.stopReason),
          },
        ],
        usage: {
          prompt_tokens: result.timings.promptTokens,
          completion_tokens: result.timings.completionTokens,
          total_tokens: result.timings.promptTokens + result.timings.completionTokens,
        },
      });
      return;
    }

    const sse = startSse(ctx.res);
    const id = `cmpl-${randomId()}`;
    const created = createdSeconds();
    try {
      const result = await engine.complete({
        model,
        prompt,
        format,
        options,
        keepAlive: body.keep_alive,
        signal: ctx.signal,
        onToken: async (chunk) => {
          await sse.write({
            id,
            object: "text_completion",
            created,
            model,
            choices: [{ index: 0, text: chunk, logprobs: null, finish_reason: null }],
          });
        },
      });
      await sse.write({
        id,
        object: "text_completion",
        created,
        model,
        choices: [{ index: 0, text: "", logprobs: null, finish_reason: finishReason(result.stopReason) }],
      });
      await sse.write("[DONE]");
      await sse.end();
    } catch (error) {
      await sse.end().catch(() => {});
      throw error;
    }
  };

  /** @param {import("../router.mjs").RequestContext} ctx */
  const embeddings = async (ctx) => {
    const body = await readJson(ctx.req, { limit: config.maxBodyBytes });
    const model = await resolveModel(body.model);
    await store.resolve(model);
    const input = toInputArray(body.input);
    if (input.length === 0) throw badRequest("input is required", "invalid_input");
    const result = await engine.embed({ model, input, keepAlive: body.keep_alive, signal: ctx.signal });
    sendJson(ctx.res, 200, {
      object: "list",
      data: result.embeddings.map((embedding, index) => ({
        object: "embedding",
        index,
        embedding,
      })),
      model: result.model,
      usage: { prompt_tokens: result.promptTokens, total_tokens: result.promptTokens },
    });
  };

  /** @param {import("../router.mjs").RequestContext} ctx */
  const getModel = async (ctx) => {
    const id = ctx.params.id;
    try {
      const resolved = await store.resolve(id);
      sendJson(ctx.res, 200, modelPayload(resolved));
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        throw notFound(`model "${id}" not found`, "model_not_found");
      }
      throw error;
    }
  };

  return {
    /** @param {import("../router.mjs").Router} router */
    register(router) {
      router.get("/v1/models", async (ctx) => {
        const models = await store.list();
        sendJson(ctx.res, 200, {
          object: "list",
          data: models.map((model) => ({
            id: model.name,
            object: "model",
            created: Math.floor(new Date(model.modified_at).getTime() / 1000),
            owned_by: APP_NAME,
          })),
        });
      });
      router.get("/v1/models/:id", getModel);
      router.post("/v1/chat/completions", chatCompletions);
      router.post("/v1/completions", completions);
      router.post("/v1/embeddings", embeddings);
      router.get("/health", async (ctx) => {
        sendJson(ctx.res, 200, { status: "ok", ...engine.status() });
      });
    },
  };
}

/**
 * @param {import("../models/store.mjs").ResolvedModel} resolved
 */
function modelPayload(resolved) {
  return {
    id: resolved.name,
    object: "model",
    created: Math.floor(new Date(resolved.modifiedAt).getTime() / 1000),
    owned_by: APP_NAME,
    permission: [],
    root: resolved.name,
    parent: null,
    details: resolved.details,
    context_length: resolved.gguf?.contextLength ?? null,
  };
}

