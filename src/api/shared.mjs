import { badRequest } from "../errors.mjs";
import { toNanos } from "../util/format.mjs";

/** Ollama reports durations in nanoseconds. */
export const timingFields = (timings) => ({
  total_duration: toNanos(timings.totalDuration),
  load_duration: toNanos(timings.loadDuration),
  prompt_eval_count: timings.promptTokens,
  prompt_eval_duration: toNanos(timings.promptEvalDuration),
  eval_count: timings.completionTokens,
  eval_duration: toNanos(timings.evalDuration),
});

export const createdNow = () => new Date().toISOString();
export const createdSeconds = () => Math.floor(Date.now() / 1000);

/** @param {string} text */
export const randomId = (text = "") => {
  const random = Math.random().toString(36).slice(2, 10);
  return `${text}${Date.now().toString(36)}${random}`;
};

/**
 * Ollama tool calls carry the arguments as an object; OpenAI uses a JSON
 * string. Keep both conversions in one place.
 * @param {{name: string, arguments?: unknown}[]} calls
 */
export function nativeToolCalls(calls) {
  return calls.map((call) => {
    let args = call.arguments ?? {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = { input: args };
      }
    }
    return { function: { name: call.name, arguments: args } };
  });
}

/**
 * @param {{name: string, arguments?: unknown}[]} calls
 */
export function openAiToolCalls(calls) {
  return calls.map((call) => ({
    id: `call_${randomId()}`,
    type: "function",
    function: {
      name: call.name,
      arguments:
        typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {}),
    },
  }));
}

/**
 * `format` accepts `"json"` or a JSON schema (Ollama ≥0.5 style).
 * @param {unknown} format
 */
export function normalizeFormat(format) {
  if (format === undefined || format === null || format === "") return undefined;
  if (typeof format === "string") {
    if (format.toLowerCase() !== "json") {
      throw badRequest(`unsupported format "${format}" (only "json" is supported)`, "invalid_format");
    }
    return "json";
  }
  if (typeof format === "object") return format;
  throw badRequest('format must be "json" or a JSON schema object', "invalid_format");
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
export function toInputArray(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return [value];
  return [];
}
