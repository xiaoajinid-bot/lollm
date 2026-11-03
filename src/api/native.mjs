import { badRequest, unsupported } from "../errors.mjs";
import { readJson, sendJson, sendText } from "../util/http.mjs";
import { startNdjson } from "../util/ndjson.mjs";
import { APP_NAME, OLLAMA_COMPAT_VERSION, VERSION } from "../version.mjs";
import { normalizeMessages, normalizeTools } from "../chat/messages.mjs";
import { parseModelfile } from "../models/modelfile.mjs";
import { parseReference } from "../models/registry.mjs";
import { modelInfoForShow } from "./show.mjs";
import {
  createdNow,
  normalizeFormat,
  nativeToolCalls,
  timingFields,
  toInputArray,
} from "./shared.mjs";

/**
 * Ollama-compatible native API (`/api/*`).
 *
 * @param {{engine: import("../engine/engine.mjs").Engine,
 *          store: import("../models/store.mjs").ModelStore,
 *          config: import("../config.mjs").Config,
 *          logger: import("../logger.mjs").Logger}} deps
 */
export function createNativeApi({ engine, store, config, logger }) {
  /** @param {unknown} value */
  const requireModelName = (value) => {
    const name = typeof value === "string" ? value.trim() : "";
    if (!name) throw badRequest("model is required", "missing_model");
    return name;
  };

  /**
   * Serialize stream writes so backpressure is respected even though the
   * generation callbacks are synchronous.
   * @param {ReturnType<typeof startNdjson>} ndjson
   */
  const makeWriter = (ndjson) => {
    /** @type {Promise<void>} */
    let chain = Promise.resolve();
    return {
      /** @param {unknown} payload */
      push(payload) {
        chain = chain.then(() => ndjson.write(payload));
        return chain;
      },
      async flush() {
        await chain;
      },
    };
  };

  /** @param {import("../router.mjs").RequestContext} ctx */
  const generate = async (ctx) => {
    const body = await readJson(ctx.req, { limit: config.maxBodyBytes });
    const model = requireModelName(body.model ?? body.name);
    // Resolve before opening the stream so a missing model is a clean 404
    // instead of a 200 response with an error frame in the middle.
    await store.resolve(model);
    if (body.images) logger.warn("vision input is not supported yet; images are ignored");
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    const format = normalizeFormat(body.format);
    const stream = body.stream !== false;
    const onTokenRequired = stream;

    if (!stream) {
      const result = await engine.complete({
        model,
        prompt,
        system: body.system,
        template: body.template,
        raw: body.raw === true,
        format,
        options: body.options,
        keepAlive: body.keep_alive,
        signal: ctx.signal,
      });
      sendJson(ctx.res, 200, {
        model: result.model,
        created_at: createdNow(),
        response: result.text,
        done: true,
        done_reason: result.stopReason === "maxTokens" ? "length" : "stop",
        context: [],
        ...timingFields(result.timings),
      });
      return;
    }

    const ndjson = startNdjson(ctx.res);
    const writer = makeWriter(ndjson);
    const payloadBase = { model, created_at: createdNow() };
    await writer.push({ ...payloadBase, response: "", done: false });
    try {
      const result = await engine.complete({
        model,
        prompt,
        system: body.system,
        template: body.template,
        raw: body.raw === true,
        format,
        options: body.options,
        keepAlive: body.keep_alive,
        signal: ctx.signal,
        onToken: onTokenRequired
          ? (chunk) => {
              writer.push({ ...payloadBase, response: chunk, done: false });
            }
          : undefined,
      });
      await writer.flush();
      await ndjson.write({
        ...payloadBase,
        response: "",
        done: true,
        done_reason: result.stopReason === "maxTokens" ? "length" : "stop",
        context: [],
        ...timingFields(result.timings),
      });
      await ndjson.end();
    } catch (error) {
      await safeEnd(ndjson);
      throw error;
    }
  };

  /** @param {import("../router.mjs").RequestContext} ctx */
  const chat = async (ctx) => {
    const body = await readJson(ctx.req, { limit: config.maxBodyBytes });
    const model = requireModelName(body.model ?? body.name);
    await store.resolve(model);
    const messages = normalizeMessages(body.messages);
    const tools = normalizeTools(body.tools);
    const format = normalizeFormat(body.format);
    const stream = body.stream !== false;
    const wantsTools = Boolean(tools?.length);

    if (!stream) {
      const result = await engine.chat({
        model,
        messages,
        tools,
        format,
        options: body.options,
        keepAlive: body.keep_alive,
        signal: ctx.signal,
      });
      const doneReason = result.toolCalls.length > 0 ? "tool_calls" : result.stopReason === "maxTokens" ? "length" : "stop";
      sendJson(ctx.res, 200, {
        model: result.model,
        created_at: createdNow(),
        message: {
          role: "assistant",
          content: result.text,
          ...(result.toolCalls.length > 0 ? { tool_calls: nativeToolCalls(result.toolCalls) } : {}),
        },
        done: true,
        done_reason: doneReason,
        ...timingFields(result.timings),
      });
      return;
    }

    const ndjson = startNdjson(ctx.res);
    const writer = makeWriter(ndjson);
    const payloadBase = { model, created_at: createdNow() };
    await writer.push({
      ...payloadBase,
      message: { role: "assistant", content: "" },
      done: false,
    });
    try {
      let streamed = false;
      const result = await engine.chat({
        model,
        messages,
        tools,
        format,
        options: body.options,
        keepAlive: body.keep_alive,
        signal: ctx.signal,
        onToken: (chunk) => {
          streamed = true;
          writer.push({
            ...payloadBase,
            message: { role: "assistant", content: chunk },
            done: false,
          });
        },
      });
      await writer.flush();
      if (!streamed && result.text) {
        await ndjson.write({
          ...payloadBase,
          message: { role: "assistant", content: result.text },
          done: false,
        });
      }
      if (result.toolCalls.length > 0) {
        await ndjson.write({
          ...payloadBase,
          message: { role: "assistant", content: "", tool_calls: nativeToolCalls(result.toolCalls) },
          done: false,
        });
      }
      const doneReason =
        result.toolCalls.length > 0 ? "tool_calls" : result.stopReason === "maxTokens" ? "length" : "stop";
      await ndjson.write({
        ...payloadBase,
        message: { role: "assistant", content: "" },
        done: true,
        done_reason: doneReason,
        ...timingFields(result.timings),
      });
      await ndjson.end();
    } catch (error) {
      await safeEnd(ndjson);
      throw error;
    }
  };

  /** @param {import("../router.mjs").RequestContext} ctx */
  const embed = async (ctx) => {
    const body = await readJson(ctx.req, { limit: config.maxBodyBytes });
    const model = requireModelName(body.model ?? body.name);
    await store.resolve(model);
    const input = toInputArray(body.input);
    if (input.length === 0) throw badRequest("input is required", "invalid_input");
    const result = await engine.embed({ model, input, options: body.options, keepAlive: body.keep_alive, signal: ctx.signal });
    sendJson(ctx.res, 200, {
      model: result.model,
      embeddings: result.embeddings,
      total_duration: Math.round(result.timings.totalDuration * 1e6),
      load_duration: Math.round(result.timings.loadDuration * 1e6),
      prompt_eval_count: result.promptTokens,
    });
  };

  /** @param {import("../router.mjs").RequestContext} ctx */
  const legacyEmbeddings = async (ctx) => {
    const body = await readJson(ctx.req, { limit: config.maxBodyBytes });
    const model = requireModelName(body.model ?? body.name);
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    if (!prompt) throw badRequest("prompt is required", "invalid_prompt");
    const result = await engine.embed({ model, input: [prompt], options: body.options, keepAlive: body.keep_alive, signal: ctx.signal });
    sendJson(ctx.res, 200, { embedding: result.embeddings[0] });
  };

  /** @param {import("../router.mjs").RequestContext} ctx */
  const pull = async (ctx) => {
    const body = await readJson(ctx.req, { limit: config.maxBodyBytes });
    const reference = body.model ?? body.name;
    if (typeof reference !== "string" || reference.trim() === "") {
      throw badRequest("model is required", "missing_model");
    }
    const stream = body.stream !== false;
    const ndjson = stream ? startNdjson(ctx.res) : null;
    const writer = ndjson ? makeWriter(ndjson) : null;
    /** @type {any[]} */
    const events = [];
    const onProgress = (event) => {
      if (writer) writer.push(event);
      else events.push(event);
    };
    try {
      // Ollama clients expect the progress stream to start with this frame,
      // even for local file imports.
      void parseReference(reference);
      onProgress({ status: "pulling manifest" });
      const result = await store.pull(reference, {
        name: body.name && body.model ? body.name : undefined,
        onProgress,
        signal: ctx.signal,
      });
      if (writer) {
        await writer.flush();
        await ndjson?.write({ status: "success" });
        await ndjson?.end();
      } else {
        sendJson(ctx.res, 200, { status: "success", model: result.model, events });
      }
    } catch (error) {
      await safeEnd(ndjson);
      throw error;
    }
  };

  /** @param {import("../router.mjs").RequestContext} ctx */
  const show = async (ctx) => {
    const body = await readJson(ctx.req, { limit: config.maxBodyBytes });
    const model = requireModelName(body.model ?? body.name);
    const resolved = await store.resolve(model);
    sendJson(ctx.res, 200, {
      license: resolved.license ?? "",
      modelfile: buildShowModelfile(resolved),
      parameters: resolved.parametersText,
      template: resolved.template ?? "",
      system: resolved.system ?? "",
      details: resolved.details,
      model_info: modelInfoForShow(resolved),
      capabilities: resolved.capabilities,
      modified_at: resolved.modifiedAt,
    });
  };

  /** @param {import("../router.mjs").RequestContext} ctx */
  const create = async (ctx) => {
    const body = await readJson(ctx.req, { limit: config.maxBodyBytes });
    const model = requireModelName(body.model ?? body.name);
    let parsed = {};
    if (typeof body.modelfile === "string" && body.modelfile.trim() !== "") {
      try {
        parsed = parseModelfile(body.modelfile);
      } catch (error) {
        throw badRequest(`invalid Modelfile: ${/** @type {Error} */ (error).message}`, "invalid_modelfile");
      }
    }
    const from = body.from ?? parsed.from;
    if (!from) throw badRequest("FROM is required", "missing_from");
    const parameters = {
      ...(parsed.parameters ?? {}),
      ...(body.parameters && typeof body.parameters === "object" ? body.parameters : {}),
    };
    const stream = body.stream !== false;
    const ndjson = stream ? startNdjson(ctx.res) : null;
    const writer = ndjson ? makeWriter(ndjson) : null;
    try {
      if (writer) writer.push({ status: "creating model" });
      const result = await store.create({
        model,
        from,
        system: body.system ?? parsed.system,
        template: body.template ?? parsed.template,
        license: body.license ?? parsed.license,
        parameters,
      });
      if (writer) {
        writer.push({ status: "writing manifest" });
        await writer.flush();
        await ndjson?.write({ status: "success" });
        await ndjson?.end();
      } else {
        sendJson(ctx.res, 200, { status: "success", model: result.model });
      }
    } catch (error) {
      await safeEnd(ndjson);
      throw error;
    }
  };

  /** @param {import("../router.mjs").RequestContext} ctx */
  const remove = async (ctx) => {
    const body = await readJson(ctx.req, { limit: config.maxBodyBytes });
    const model = requireModelName(body.model ?? body.name);
    const result = await store.remove(model);
    sendJson(ctx.res, 200, result);
  };

  /** @param {import("../router.mjs").RequestContext} ctx */
  const copy = async (ctx) => {
    const body = await readJson(ctx.req, { limit: config.maxBodyBytes });
    const source = typeof body.source === "string" ? body.source.trim() : "";
    const destination = typeof body.destination === "string" ? body.destination.trim() : "";
    if (!source || !destination) {
      throw badRequest("source and destination are required", "invalid_request");
    }
    await store.copy(source, destination);
    sendJson(ctx.res, 200, { status: "success" });
  };

  return {
    /** @param {import("../router.mjs").Router} router */
    register(router) {
      router.get("/", async (ctx) => {
        // Ollama clients probe `/` and expect this exact string.
        sendText(ctx.res, 200, "Ollama is running");
      });

      router.get("/api/version", async (ctx) => {
        sendJson(ctx.res, 200, { version: OLLAMA_COMPAT_VERSION, lollm: VERSION });
      });

      router.get("/api/tags", async (ctx) => {
        sendJson(ctx.res, 200, { models: await store.list() });
      });

      router.get("/api/ps", async (ctx) => {
        sendJson(ctx.res, 200, { models: await engine.ps() });
      });

      router.post("/api/show", show);
      router.post("/api/generate", generate);
      router.post("/api/chat", chat);
      router.post("/api/embed", embed);
      router.post("/api/embeddings", legacyEmbeddings);
      router.post("/api/pull", pull);
      router.post("/api/create", create);
      router.post("/api/delete", remove);
      router.post("/api/copy", copy);
      router.post("/api/push", async () => {
        throw unsupported("pushing to a registry is not supported by lollm", "unsupported");
      });
      router.get("/api/health", async (ctx) => {
        sendJson(ctx.res, 200, {
          status: "ok",
          name: APP_NAME,
          version: VERSION,
          backend: engine.status().backend,
          engine: engine.status(),
        });
      });
      router.get("/api/models", async (ctx) => {
        // Convenience alias some dashboards look for.
        sendJson(ctx.res, 200, { models: await store.list() });
      });
    },
  };
}

/** @param {any} stream */
async function safeEnd(stream) {
  try {
    await stream?.end?.();
  } catch {
    /* client already gone */
  }
}

/**
 * Reconstruct a Modelfile for `/api/show` without importing the store helper
 * (keeps this module focused on HTTP concerns).
 * @param {import("../models/store.mjs").ResolvedModel} resolved
 */
function buildShowModelfile(resolved) {
  const lines = [`FROM ${resolved.modelPath}`];
  if (resolved.template) lines.push(`TEMPLATE """${resolved.template}"""`);
  if (resolved.system) lines.push(`SYSTEM """${resolved.system}"""`);
  if (resolved.license) lines.push(`LICENSE """${resolved.license}"""`);
  if (resolved.parametersText) {
    for (const line of resolved.parametersText.split("\n")) {
      if (line.trim()) lines.push(`PARAMETER ${line.trim()}`);
    }
  }
  return lines.join("\n");
}

