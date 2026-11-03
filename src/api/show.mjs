/**
 * `model_info` as returned by `/api/show`: GGUF metadata with scalar values and
 * small arrays kept, giant tokenizer arrays dropped (they are megabytes long
 * and no client needs them).
 *
 * @param {import("../models/store.mjs").ResolvedModel} resolved
 */
export function modelInfoForShow(resolved) {
  const info = resolved.gguf ?? {};
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(info.metadata ?? {})) {
    if (Array.isArray(value) && value.length > 64) continue;
    if (typeof value === "bigint") out[key] = Number(value);
    else out[key] = value;
  }
  out["general.architecture"] = info.architecture ?? "unknown";
  if (info.parameterCount) out["general.parameter_count"] = info.parameterCount;
  if (info.quantization) out["general.quantization"] = info.quantization;
  if (info.contextLength) out[`${info.architecture}.context_length`] = info.contextLength;
  if (info.embeddingLength) out[`${info.architecture}.embedding_length`] = info.embeddingLength;
  if (info.blockCount) out[`${info.architecture}.block_count`] = info.blockCount;
  return out;
}
