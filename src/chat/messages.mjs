import { badRequest } from "../errors.mjs";

/**
 * Conversion layer between the wire formats (Ollama + OpenAI) and the engine.
 * Everything that both APIs share lives here so the two routers stay thin.
 */

const ROLES = new Set(["system", "user", "assistant", "tool", "developer"]);

/**
 * @typedef {Object} ChatMessage
 * @property {"system"|"user"|"assistant"|"tool"} role
 * @property {string} content
 * @property {any[]} [images]
 * @property {any[]} [tool_calls]
 * @property {string} [tool_call_id]
 * @property {string} [name]
 */

/**
 * @param {unknown} messages
 * @param {{allowEmpty?: boolean}} [options]
 * @returns {ChatMessage[]}
 */
export function normalizeMessages(messages, options = {}) {
  if (!Array.isArray(messages)) throw badRequest("messages must be an array", "invalid_messages");
  if (messages.length === 0 && !options.allowEmpty) {
    throw badRequest("messages must not be empty", "invalid_messages");
  }
  return messages.map((raw, index) => {
    if (!raw || typeof raw !== "object") {
      throw badRequest(`messages[${index}] must be an object`, "invalid_messages");
    }
    const message = /** @type {Record<string, any>} */ (raw);
    let role = String(message.role ?? "user").toLowerCase();
    if (role === "developer") role = "system";
    if (!ROLES.has(role)) {
      throw badRequest(`unsupported role "${message.role}" in messages[${index}]`, "invalid_messages");
    }
    const content = extractContent(message.content, index);
    /** @type {ChatMessage} */
    const normalized = { role: /** @type {any} */ (role), content };
    if (Array.isArray(message.images) && message.images.length > 0) normalized.images = message.images;
    if (Array.isArray(message.tool_calls)) normalized.tool_calls = message.tool_calls;
    if (message.tool_call_id) normalized.tool_call_id = String(message.tool_call_id);
    if (message.name) normalized.name = String(message.name);
    return normalized;
  });
}

/**
 * OpenAI allows content to be an array of parts; Ollama clients sometimes send
 * `null` for assistant messages that only contain tool calls.
 * @param {unknown} content
 * @param {number} index
 */
function extractContent(content, index) {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (typeof part === "string") {
        parts.push(part);
        continue;
      }
      if (part && typeof part === "object") {
        const item = /** @type {Record<string, any>} */ (part);
        if (typeof item.text === "string") parts.push(item.text);
        else if (item.type === "image_url") parts.push("[image omitted]");
      }
    }
    return parts.join("");
  }
  throw badRequest(`messages[${index}].content must be a string or an array`, "invalid_messages");
}

/**
 * @param {unknown} tools
 * @returns {any[] | undefined}
 */
export function normalizeTools(tools) {
  if (tools === undefined || tools === null) return undefined;
  if (!Array.isArray(tools)) throw badRequest("tools must be an array", "invalid_tools");
  if (tools.length === 0) return undefined;
  /** @type {any[]} */
  const out = [];
  const seen = new Set();
  for (const [index, raw] of tools.entries()) {
    if (!raw || typeof raw !== "object") throw badRequest(`tools[${index}] must be an object`, "invalid_tools");
    const tool = /** @type {Record<string, any>} */ (raw);
    // Accept both `{type:"function", function:{...}}` and a bare function object.
    const fn = tool.function ?? tool;
    const name = String(fn?.name ?? "");
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
      throw badRequest(`tools[${index}].function.name is invalid`, "invalid_tools");
    }
    if (seen.has(name)) throw badRequest(`duplicate tool name "${name}"`, "invalid_tools");
    seen.add(name);
    out.push({
      type: "function",
      function: {
        name,
        description: fn.description ? String(fn.description) : undefined,
        parameters: fn.parameters && typeof fn.parameters === "object"
          ? sanitizeSchema(fn.parameters)
          : { type: "object", properties: {} },
      },
    });
  }
  return out;
}

/**
 * node-llama-cpp consumes a map of `name → {description, params}`.
 * @param {any[] | undefined} tools
 * @returns {Record<string, {description?: string, params: any}> | undefined}
 */
export function toolsToFunctions(tools) {
  if (!tools?.length) return undefined;
  /** @type {Record<string, {description?: string, params: any}>} */
  const functions = {};
  for (const tool of tools) {
    functions[tool.function.name] = {
      description: tool.function.description,
      params: tool.function.parameters,
    };
  }
  return functions;
}

/**
 * Shrink JSON Schema to what llama.cpp grammars understand, and normalize
 * OpenAI-specific corners (`anyOf`, nullable unions, `$schema`, `format`).
 * @param {any} schema
 * @returns {any}
 */
export function sanitizeSchema(schema) {
  if (schema === null || typeof schema !== "object") return { type: "object", properties: {} };
  const input = /** @type {Record<string, any>} */ (schema);
  /** @type {Record<string, any>} */
  const out = {};

  let type = input.type;
  if (Array.isArray(type)) {
    const nonNull = type.filter((item) => item !== "null");
    type = nonNull[0] ?? "null";
  }
  if (typeof type === "string") out.type = type;

  if (input.properties && typeof input.properties === "object") {
    out.properties = {};
    for (const [key, value] of Object.entries(input.properties)) {
      out.properties[key] = sanitizeSchema(value);
    }
  }
  if (Array.isArray(input.required)) out.required = input.required.map(String);
  if (input.items !== undefined) out.items = sanitizeSchema(input.items);
  if (Array.isArray(input.prefixItems)) out.prefixItems = input.prefixItems.map(sanitizeSchema);
  if (Array.isArray(input.enum)) out.enum = input.enum.filter((item) => item !== null);
  if (input.const !== undefined) out.const = input.const;
  const oneOf = input.oneOf ?? input.anyOf;
  if (Array.isArray(oneOf)) {
    out.oneOf = oneOf.map(sanitizeSchema);
  }
  if (input.allOf && Array.isArray(input.allOf)) {
    // Merge object schemas (the common case for tool parameters).
    /** @type {Record<string, any>} */
    const mergedProperties = { ...(out.properties ?? {}) };
    /** @type {string[]} */
    const mergedRequired = new Set(out.required ?? []);
    let merged;
    for (const part of input.allOf) {
      const sanitized = sanitizeSchema(part);
      if (sanitized.properties) Object.assign(mergedProperties, sanitized.properties);
      for (const key of sanitized.required ?? []) mergedRequired.add(key);
      if (!merged && sanitized.type) merged = sanitized.type;
    }
    if (Object.keys(mergedProperties).length > 0) {
      out.type = "object";
      out.properties = mergedProperties;
      out.required = [...mergedRequired];
    } else if (merged) {
      out.type = merged;
    }
  }
  if (input.additionalProperties !== undefined) {
    out.additionalProperties = input.additionalProperties === true ? true : false;
  }
  for (const key of ["minItems", "maxItems", "minLength", "maxLength", "minProperties", "maxProperties"]) {
    if (typeof input[key] === "number") out[key] = input[key];
  }
  if (input.$defs && typeof input.$defs === "object") {
    out.$defs = {};
    for (const [key, value] of Object.entries(input.$defs)) out.$defs[key] = sanitizeSchema(value);
  }
  if (typeof input.$ref === "string") out.$ref = input.$ref;

  if (out.type === undefined) {
    if (out.properties) out.type = "object";
    else if (out.enum || out.const !== undefined) out.type = typeof (out.enum?.[0] ?? out.const);
    else out.type = "object";
  }
  return out;
}

/**
 * Ollama's `options` object → normalized generation options.
 *
 * @param {Record<string, unknown> | undefined} options
 * @param {{contextSize?: number, maxTokens?: number, gpuLayers?: number | null, threads?: number}} [defaults]
 */
export function mapOptions(options, defaults = {}) {
  const input = options ?? {};
  /** @type {Record<string, any>} */
  const out = {};

  const num = (value) => {
    if (value === undefined || value === null || value === "") return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  };

  const temperature = num(input.temperature);
  if (temperature !== undefined) out.temperature = temperature;

  const topP = num(input.top_p ?? input.topP);
  if (topP !== undefined) out.topP = topP;

  const topK = num(input.top_k ?? input.topK);
  if (topK !== undefined) out.topK = topK;

  const minP = num(input.min_p ?? input.minP);
  if (minP !== undefined) out.minP = minP;

  const seed = num(input.seed);
  if (seed !== undefined) out.seed = seed;

  // Ollama uses num_predict: -1 for "until the model stops"; OpenAI sends
  // max_tokens. Anything <= 0 (or absent) means unlimited: no cap is applied,
  // so generation ends on EOG or when the context window is full.
  const maxTokens = num(input.num_predict ?? input.max_tokens ?? input.maxTokens) ?? defaults.maxTokens;
  if (maxTokens !== undefined && maxTokens > 0) out.maxTokens = maxTokens;

  const stop = input.stop;
  if (Array.isArray(stop)) out.stop = stop.map(String).filter(Boolean);
  else if (typeof stop === "string" && stop !== "") out.stop = [stop];

  const penalty = num(input.repeat_penalty ?? input.repeatPenalty);
  const presence = num(input.presence_penalty ?? input.presencePenalty);
  const frequency = num(input.frequency_penalty ?? input.frequencyPenalty);
  if (penalty !== undefined || presence !== undefined || frequency !== undefined) {
    out.repeatPenalty = {
      ...(penalty !== undefined ? { penalty } : {}),
      ...(presence !== undefined ? { presencePenalty: presence } : {}),
      ...(frequency !== undefined ? { frequencyPenalty: frequency } : {}),
    };
  }

  const contextSize = num(input.num_ctx ?? input.contextSize) ?? defaults.contextSize;
  if (contextSize !== undefined) out.contextSize = contextSize;

  const gpuLayers = num(input.num_gpu ?? input.gpuLayers) ?? defaults.gpuLayers ?? undefined;
  if (gpuLayers !== undefined && gpuLayers !== null) out.gpuLayers = gpuLayers;

  const threads = num(input.num_thread ?? input.threads) ?? defaults.threads;
  if (threads !== undefined && threads > 0) out.threads = threads;

  return out;
}

/**
 * Default generation options coming from a Modelfile's `PARAMETER` lines.
 * @param {Record<string, string | string[]> | undefined} parameters
 */
export function optionsFromParameters(parameters) {
  return mapOptions(/** @type {Record<string, unknown>} */ (parameters ?? {}));
}

/**
 * Merge two option objects, right-hand side wins (arrays are replaced).
 * @param {...Record<string, any>} layers
 */
export function mergeOptions(...layers) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined) continue;
      if (key === "repeatPenalty") {
        out.repeatPenalty = { ...(out.repeatPenalty ?? {}), ...value };
      } else {
        out[key] = value;
      }
    }
  }
  return out;
}

/**
 * @param {any} value
 * @returns {string}
 */
export function contentToText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(contentToText).join("");
  if (typeof value === "object") {
    const record = /** @type {Record<string, any>} */ (value);
    if (typeof record.text === "string") return record.text;
    if (typeof record.content === "string") return record.content;
  }
  return "";
}

/**
 * Rough token estimate (~4 chars per token). The real backend replaces this
 * with the model tokenizer; usage numbers only need to be sane, not exact.
 * @param {string} text
 */
export const estimateTokens = (text) => Math.max(1, Math.ceil(String(text ?? "").length / 4));

/**
 * Map a backend stop reason to the wire `finish_reason` / `done_reason`.
 * @param {string | undefined} reason
 * @param {boolean} hasToolCalls
 */
export function finishReason(reason, hasToolCalls = false) {
  if (hasToolCalls) return "tool_calls";
  if (!reason) return "stop";
  if (reason === "maxTokens" || reason === "length") return "length";
  if (reason === "abort") return "stop";
  return "stop";
}

/**
 * OpenAI finishes with `tool_calls`; Ollama clients expect the same name.
 * @param {string | undefined} reason
 */
export const ollamaDoneReason = (reason) => (reason === "length" ? "length" : "stop");

/**
 * Convert internal tool calls into the OpenAI/Ollama wire shape.
 * @param {{name: string, arguments?: unknown, id?: string}[]} calls
 */
export function toWireToolCalls(calls) {
  return calls.map((call) => {
    const args = call.arguments ?? {};
    return {
      id: call.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
      type: "function",
      function: {
        name: call.name,
        arguments: typeof args === "string" ? args : JSON.stringify(args),
      },
    };
  });
}

/**
 * Try to recover a tool call from model text. Used when a model was asked to
 * answer with JSON instead of using the native function-call grammar.
 * @param {string} text
 * @returns {{name: string, arguments: Record<string, unknown>} | null}
 */
export function parseToolCallText(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  const candidate = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === "object") {
      if (Array.isArray(parsed.tool_calls) && parsed.tool_calls[0]) {
        const first = parsed.tool_calls[0];
        const fn = first.function ?? first;
        if (typeof fn.name === "string") {
          return { name: fn.name, arguments: fn.arguments ?? fn.parameters ?? {} };
        }
      }
      if (typeof parsed.name === "string" && (parsed.arguments || parsed.parameters)) {
        return { name: parsed.name, arguments: parsed.arguments ?? parsed.parameters ?? {} };
      }
    }
  } catch {
    return null;
  }
  return null;
}
