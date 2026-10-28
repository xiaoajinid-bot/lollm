/**
 * Stub lib/llm-engine.mjs untuk pengujian API tanpa memuat model GGUF.
 * Antrian skrip keluaran model diambil dari globalThis.__stubInferenceQueue.
 */

export const DEFAULT_MODEL_ID = 'qwen2.5-0.5b-instruct';

export const MODEL_CATALOG = [
  {
    id: DEFAULT_MODEL_ID,
    aliases: ['default'],
    name: 'Stub 0.5B Instruct',
    family: 'Stub',
    parameters: '0.5B',
    quantization: 'Q4_K_M',
    sizeMb: 379,
    contextLength: 2048,
    badge: 'stub',
    description: 'Model stub untuk pengujian.',
    filename: 'stub.gguf',
    downloadUrl: 'https://example.invalid/stub.gguf',
  },
];

export function resolveModelSpec(requestedId) {
  if (!requestedId) return MODEL_CATALOG[0];
  const normalized = String(requestedId).trim().toLowerCase();
  return (
    MODEL_CATALOG.find(
      (item) =>
        item.id.toLowerCase() === normalized ||
        (item.aliases || []).some((alias) => alias.toLowerCase() === normalized)
    ) || null
  );
}

export async function ensureModelLoaded() {
  return { spec: MODEL_CATALOG[0], model: null, context: null, coldLoad: false, loadMs: 0 };
}

export async function getSystemHealth() {
  return {
    ok: true,
    status: 'warm',
    active_model: DEFAULT_MODEL_ID,
    loading_model: null,
    download_progress: null,
    cached_models: [
      { id: DEFAULT_MODEL_ID, name: 'Stub', size_mb: 379, quantization: 'Q4_K_M', loaded_in_ram: true, cached_on_tmp: true },
    ],
    runtime: { vercel_region: 'stub1', node_version: 'v22', cpu_cores: 2, rss_mb: 42, tmp_disk: { free_mb: 400 } },
    stats: { requestsServed: 0, tokensGenerated: 0, lastTokensPerSecond: null, lastLatencyMs: null, coldStarts: 0 },
  };
}

export async function runChatInference(args = {}) {
  const queue = globalThis.__stubInferenceQueue || [];
  const next = queue.length > 1 ? queue.shift() : queue.length === 1 ? queue[0] : 'Jawaban stub.';
  globalThis.__stubInferenceCalls = (globalThis.__stubInferenceCalls || 0) + 1;
  globalThis.__stubInferenceArgs = globalThis.__stubInferenceArgs || [];
  globalThis.__stubInferenceArgs.push(args);

  const text = typeof next === 'function' ? next(args) : next;

  if (typeof args.onTokenChunk === 'function') {
    const chunks = String(text).match(/[\s\S]{1,9}/g) || [];
    for (const chunk of chunks) args.onTokenChunk(chunk);
  }

  return {
    modelSpec: MODEL_CATALOG[0],
    text,
    finishReason: 'stop',
    usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
    timings: { cold_load: false, load_ms: 0, generation_ms: 12, tokens_per_second: 9.5 },
  };
}
