import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Ensure node-llama-cpp never attempts GPU probing or runtime builds in serverless
process.env.NODE_LLAMA_CPP_GPU = 'false';
process.env.NODE_LLAMA_CPP_SKIP_DOWNLOAD = 'true';
process.env.NODE_LLAMA_CPP_POSTINSTALL = 'skip';

// Static-traceable hint for Vercel NFT bundler (linux-x64 prebuilt binary package)
import('@node-llama-cpp/linux-x64').catch(() => {});

import { getLlama, LlamaChatSession } from 'node-llama-cpp';

export const DEFAULT_MODEL_ID = 'qwen2.5-0.5b-instruct';

export const MODEL_CATALOG = [
  {
    id: 'qwen2.5-0.5b-instruct',
    aliases: ['default', 'local', 'qwen2.5', 'qwen2.5:0.5b'],
    name: 'Qwen 2.5 0.5B Instruct (Q4_K_M)',
    family: 'Qwen 2.5',
    parameters: '0.5B',
    quantization: 'Q4_K_M',
    sizeMb: 379,
    contextLength: 2048,
    badge: 'Rekomendasi (Multilingual & Kode)',
    description:
      'Model instruksi multibahasa (sangat baik dalam Bahasa Indonesia & pemrograman) yang berjalan langsung di CPU Vercel.',
    filename: 'Qwen2.5-0.5B-Instruct-Q4_K_M.gguf',
    downloadUrl:
      'https://huggingface.co/bartowski/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf',
  },
  {
    id: 'smollm2-360m-instruct',
    aliases: ['smollm2', 'smollm2:360m'],
    name: 'SmolLM2 360M Instruct (Q4_K_M)',
    family: 'SmolLM2',
    parameters: '360M',
    quantization: 'Q4_K_M',
    sizeMb: 258,
    contextLength: 2048,
    badge: 'Seimbang & Ringan',
    description:
      'Model kompak dari HuggingFaceTB dengan konsumsi memori rendah dan kecepatan inferensi CPU tinggi.',
    filename: 'SmolLM2-360M-Instruct-Q4_K_M.gguf',
    downloadUrl:
      'https://huggingface.co/bartowski/SmolLM2-360M-Instruct-GGUF/resolve/main/SmolLM2-360M-Instruct-Q4_K_M.gguf',
  },
  {
    id: 'smollm2-135m-instruct',
    aliases: ['fast', 'tiny', 'smollm2:135m'],
    name: 'SmolLM2 135M Instruct (Q4_K_M)',
    family: 'SmolLM2',
    parameters: '135M',
    quantization: 'Q4_K_M',
    sizeMb: 101,
    contextLength: 2048,
    badge: 'Ultra Cepat (101 MB)',
    description:
      'Model super ringan untuk cold-start tercepat (~1–2 detik unduh) dan respons instan di CPU.',
    filename: 'SmolLM2-135M-Instruct-Q4_K_M.gguf',
    downloadUrl:
      'https://huggingface.co/bartowski/SmolLM2-135M-Instruct-GGUF/resolve/main/SmolLM2-135M-Instruct-Q4_K_M.gguf',
  },
];

export const DEFAULT_SYSTEM_PROMPT =
  'Kamu adalah asisten AI lokal yang berjalan langsung di dalam Serverless Function Vercel menggunakan mesin llama.cpp (GGUF CPU) tanpa API pihak ketiga. Jawablah dengan jelas, akurat, ramah, dan terstruktur sesuai bahasa pengguna.';

export function getModelsDir() {
  return process.env.LLM_MODELS_DIR || path.join(os.tmpdir(), 'vercel-local-llm-models');
}

export function resolveModelSpec(requestedId) {
  if (!requestedId || typeof requestedId !== 'string') {
    return MODEL_CATALOG[0];
  }
  const normalized = requestedId.trim().toLowerCase();
  for (const item of MODEL_CATALOG) {
    if (
      item.id.toLowerCase() === normalized ||
      item.aliases.some((a) => a.toLowerCase() === normalized)
    ) {
      return item;
    }
  }
  return null;
}

// Persist singleton state across warm invocations on Vercel Fluid Compute
const globalState =
  globalThis.__vercelLocalLlmState ||
  (globalThis.__vercelLocalLlmState = {
    startedAt: Date.now(),
    llamaPromise: null,
    activeModelId: null,
    activeModel: null,
    activeContext: null,
    loadingModelId: null,
    loadPromise: null,
    downloadProgress: null,
    mutexTail: Promise.resolve(),
    stats: {
      requestsServed: 0,
      tokensGenerated: 0,
      lastTokensPerSecond: null,
      lastLatencyMs: null,
      coldStarts: 0,
    },
  });

function runExclusive(taskFn) {
  const run = globalState.mutexTail.then(taskFn, taskFn);
  globalState.mutexTail = run.catch(() => {});
  return run;
}

async function getLlamaInstance() {
  if (!globalState.llamaPromise) {
    globalState.llamaPromise = getLlama({
      gpu: false,
      build: 'never',
    }).catch((err) => {
      globalState.llamaPromise = null;
      throw err;
    });
  }
  return globalState.llamaPromise;
}

async function unloadCurrentModelInternal() {
  if (globalState.activeContext) {
    try {
      await globalState.activeContext.dispose();
    } catch {}
    globalState.activeContext = null;
  }
  if (globalState.activeModel) {
    try {
      await globalState.activeModel.dispose();
    } catch {}
    globalState.activeModel = null;
  }
  globalState.activeModelId = null;
}

async function cleanupOtherModelFiles(keepFilename) {
  const dir = getModelsDir();
  await fsp.mkdir(dir, { recursive: true });
  const entries = await fsp.readdir(dir).catch(() => []);
  for (const entry of entries) {
    if (entry !== keepFilename) {
      await fsp.rm(path.join(dir, entry), { force: true }).catch(() => {});
    }
  }
}

async function ensureModelFile(spec, onProgress) {
  const dir = getModelsDir();
  await fsp.mkdir(dir, { recursive: true });
  const finalPath = path.join(dir, spec.filename);

  try {
    const stat = await fsp.stat(finalPath);
    if (stat.size > 10 * 1024 * 1024) {
      return { modelPath: finalPath, downloaded: false };
    }
  } catch {}

  // Free /tmp space before downloading a new GGUF file (Vercel /tmp has 512 MB limit)
  await cleanupOtherModelFiles(spec.filename);

  const partPath = `${finalPath}.part`;
  globalState.downloadProgress = {
    modelId: spec.id,
    downloadedBytes: 0,
    totalBytes: spec.sizeMb * 1024 * 1024,
    percent: 0,
    startedAt: Date.now(),
  };

  try {
    const response = await fetch(spec.downloadUrl, {
      headers: { 'User-Agent': 'vercel-local-llm/1.0' },
      redirect: 'follow',
    });

    if (!response.ok || !response.body) {
      throw new Error(
        `Gagal mengunduh model ${spec.id} dari Hugging Face: HTTP ${response.status}`
      );
    }

    const totalBytes =
      Number(response.headers.get('content-length')) || spec.sizeMb * 1024 * 1024;
    globalState.downloadProgress.totalBytes = totalBytes;

    let downloadedBytes = 0;
    let lastEmit = 0;
    const nodeStream = Readable.fromWeb(response.body);

    nodeStream.on('data', (chunk) => {
      downloadedBytes += chunk.length;
      const percent = totalBytes > 0 ? Math.min(99, Math.round((downloadedBytes / totalBytes) * 100)) : 0;
      globalState.downloadProgress = {
        modelId: spec.id,
        downloadedBytes,
        totalBytes,
        percent,
        startedAt: globalState.downloadProgress?.startedAt || Date.now(),
      };
      const now = Date.now();
      if (onProgress && now - lastEmit >= 400) {
        lastEmit = now;
        try {
          onProgress({ ...globalState.downloadProgress });
        } catch {}
      }
    });

    await pipeline(nodeStream, fs.createWriteStream(partPath));
    await fsp.rename(partPath, finalPath);

    globalState.downloadProgress = {
      modelId: spec.id,
      downloadedBytes,
      totalBytes: downloadedBytes,
      percent: 100,
      startedAt: globalState.downloadProgress?.startedAt || Date.now(),
    };
    if (onProgress) {
      try {
        onProgress({ ...globalState.downloadProgress });
      } catch {}
    }

    return { modelPath: finalPath, downloaded: true };
  } catch (err) {
    await fsp.rm(partPath, { force: true }).catch(() => {});
    throw err;
  } finally {
    globalState.downloadProgress = null;
  }
}

export async function ensureModelLoaded(modelId = DEFAULT_MODEL_ID, onProgress) {
  const spec = resolveModelSpec(modelId);
  if (!spec) {
    const valid = MODEL_CATALOG.map((m) => m.id).join(', ');
    const err = new Error(`Model "${modelId}" tidak ditemukan. Model tersedia: ${valid}`);
    err.statusCode = 404;
    throw err;
  }

  if (
    globalState.activeModelId === spec.id &&
    globalState.activeModel &&
    globalState.activeContext
  ) {
    return {
      spec,
      model: globalState.activeModel,
      context: globalState.activeContext,
      coldLoad: false,
      loadMs: 0,
    };
  }

  if (globalState.loadPromise && globalState.loadingModelId === spec.id) {
    return globalState.loadPromise;
  }

  const loadTask = (async () => {
    const t0 = performance.now();
    globalState.loadingModelId = spec.id;
    try {
      if (globalState.activeModelId && globalState.activeModelId !== spec.id) {
        await unloadCurrentModelInternal();
      }

      const { modelPath } = await ensureModelFile(spec, onProgress);
      const llama = await getLlamaInstance();

      const cpuCount = os.cpus()?.length || 2;
      const threads = Math.max(2, Math.min(4, cpuCount));

      const model = await llama.loadModel({
        modelPath,
      });

      const context = await model.createContext({
        contextSize: spec.contextLength,
        threads,
        sequences: 1,
      });

      globalState.activeModel = model;
      globalState.activeContext = context;
      globalState.activeModelId = spec.id;
      globalState.stats.coldStarts += 1;

      const loadMs = Math.round(performance.now() - t0);
      return {
        spec,
        model,
        context,
        coldLoad: true,
        loadMs,
      };
    } finally {
      globalState.loadingModelId = null;
      globalState.loadPromise = null;
    }
  })();

  globalState.loadPromise = loadTask;
  return loadTask;
}

function normalizeTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return String(content ?? '');
}

function describeToolCallsForPrompt(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return '';
  return toolCalls
    .map((call) => {
      const fn = call?.function ?? call;
      const name = fn?.name || 'tool';
      let args = fn?.arguments ?? call?.arguments ?? {};
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          args = { _raw: args };
        }
      }
      return `[memanggil tool ${name} dengan argumen ${JSON.stringify(args)}]`;
    })
    .join('\n');
}

function buildConversationFromMessages(messages, fallbackPrompt, extraSystemPrompt = '') {
  if (!Array.isArray(messages) || messages.length === 0) {
    const text = String(fallbackPrompt || '').trim();
    if (!text) {
      const err = new Error('Parameter "messages" atau "prompt" wajib diisi.');
      err.statusCode = 400;
      throw err;
    }
    return {
      systemPrompt: [DEFAULT_SYSTEM_PROMPT, extraSystemPrompt].filter(Boolean).join('\n\n'),
      priorHistory: [],
      userPrompt: text,
    };
  }

  const systemParts = [];
  const turns = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const role = String(msg.role || 'user').toLowerCase();
    const toolCallText = role === 'assistant' || role === 'model' ? describeToolCallsForPrompt(msg.tool_calls) : '';
    const text = [normalizeTextContent(msg.content), toolCallText].filter(Boolean).join('\n').trim();
    if (!text) continue;

    if (role === 'system' || role === 'developer') {
      systemParts.push(text);
    } else if (role === 'assistant' || role === 'model') {
      turns.push({ role: 'assistant', text });
    } else if (role === 'tool' || role === 'function') {
      const label = msg.name ? `[hasil tool ${msg.name}]` : '[hasil tool]';
      turns.push({ role: 'user', text: `${label}\n${text}` });
    } else {
      turns.push({ role: 'user', text });
    }
  }

  const baseSystemPrompt =
    systemParts.length > 0 ? systemParts.join('\n\n') : DEFAULT_SYSTEM_PROMPT;
  const systemPrompt = [baseSystemPrompt, extraSystemPrompt].filter(Boolean).join('\n\n');

  if (turns.length === 0) {
    const err = new Error('Minimal satu pesan "user" diperlukan di dalam "messages".');
    err.statusCode = 400;
    throw err;
  }

  let userPrompt = '';
  let sliceEnd = turns.length;
  if (turns[turns.length - 1].role === 'user') {
    userPrompt = turns[turns.length - 1].text;
    sliceEnd = turns.length - 1;
  } else {
    userPrompt = 'Lanjutkan respons sebelumnya dengan jelas.';
  }

  // Keep recent history compact so 2048 context window never overflows
  // (12 giliran cukup untuk percakapan + hasil tool, tetap hemat konteks)
  const recentTurns = turns.slice(Math.max(0, sliceEnd - 12), sliceEnd);
  const priorHistory = [
    { type: 'system', text: systemPrompt },
    ...recentTurns.map((t) =>
      t.role === 'assistant'
        ? { type: 'model', response: [t.text] }
        : { type: 'user', text: t.text }
    ),
  ];

  return {
    systemPrompt,
    priorHistory,
    userPrompt,
  };
}

export async function runChatInference({
  modelId = DEFAULT_MODEL_ID,
  messages,
  prompt,
  temperature = 0.65,
  topP = 0.9,
  maxTokens = 384,
  signal,
  onProgress,
  onTokenChunk,
  extraSystemPrompt = '',
}) {
  const { systemPrompt, priorHistory, userPrompt } = buildConversationFromMessages(
    messages,
    prompt,
    extraSystemPrompt
  );

  const clampedMaxTokens = Math.max(1, Math.min(1024, Number(maxTokens) || 384));
  const clampedTemp = Math.max(0, Math.min(2, Number(temperature ?? 0.65)));
  const clampedTopP = Math.max(0.05, Math.min(1, Number(topP ?? 0.9)));

  return runExclusive(async () => {
    const { spec, model, context, coldLoad, loadMs } = await ensureModelLoaded(
      modelId,
      onProgress
    );

    const sequence = context.getSequence();
    const session = new LlamaChatSession({
      contextSequence: sequence,
      systemPrompt,
    });

    if (priorHistory.length > 1) {
      session.setChatHistory(priorHistory);
    }

    const genStart = performance.now();
    let completionTokens = 0;
    let fullText = '';

    try {
      const promptTokenCount = model.tokenize(
        `${systemPrompt}\n${userPrompt}`
      ).length;

      const meta = await session.promptWithMeta(userPrompt, {
        maxTokens: clampedMaxTokens,
        temperature: clampedTemp,
        topP: clampedTopP,
        signal,
        stopOnAbortSignal: true,
        repeatPenalty: {
          lastTokens: 64,
          penalty: 1.12,
        },
        onTextChunk(chunk) {
          if (!chunk) return;
          completionTokens += 1;
          fullText += chunk;
          if (onTokenChunk) {
            onTokenChunk(chunk);
          }
        },
      });

      if (!fullText && meta?.responseText) {
        fullText = meta.responseText;
      }

      const generationMs = Math.max(1, Math.round(performance.now() - genStart));
      const tokensPerSecond = Number(
        ((completionTokens * 1000) / generationMs).toFixed(1)
      );

      globalState.stats.requestsServed += 1;
      globalState.stats.tokensGenerated += completionTokens;
      globalState.stats.lastTokensPerSecond = tokensPerSecond;
      globalState.stats.lastLatencyMs = generationMs + loadMs;

      const finishReason =
        meta?.stopReason === 'maxTokens'
          ? 'length'
          : meta?.stopReason === 'abort'
            ? 'stop'
            : 'stop';

      return {
        modelSpec: spec,
        text: fullText,
        finishReason,
        usage: {
          prompt_tokens: promptTokenCount,
          completion_tokens: completionTokens,
          total_tokens: promptTokenCount + completionTokens,
        },
        timings: {
          cold_load: coldLoad,
          load_ms: loadMs,
          generation_ms: generationMs,
          tokens_per_second: tokensPerSecond,
        },
      };
    } finally {
      try {
        session.dispose({ disposeSequence: true });
      } catch {
        try {
          sequence.dispose();
        } catch {}
      }
    }
  });
}

export async function getSystemHealth() {
  const dir = getModelsDir();
  await fsp.mkdir(dir, { recursive: true }).catch(() => {});

  let disk = null;
  try {
    const statfs = fs.statfsSync(dir);
    const totalBytes = statfs.blocks * statfs.bsize;
    const freeBytes = statfs.bavail * statfs.bsize;
    disk = {
      path: dir,
      total_mb: Math.round(totalBytes / 1024 / 1024),
      free_mb: Math.round(freeBytes / 1024 / 1024),
      used_mb: Math.round((totalBytes - freeBytes) / 1024 / 1024),
    };
  } catch {}

  const cachedFiles = await fsp.readdir(dir).catch(() => []);
  const mem = process.memoryUsage();

  return {
    ok: true,
    status: globalState.downloadProgress
      ? 'downloading'
      : globalState.loadingModelId
        ? 'loading'
        : globalState.activeModelId
          ? 'warm'
          : 'cold',
    engine: 'node-llama-cpp (llama.cpp CPU SIMD)',
    active_model: globalState.activeModelId,
    loading_model: globalState.loadingModelId,
    download_progress: globalState.downloadProgress,
    cached_models: MODEL_CATALOG.map((m) => ({
      id: m.id,
      name: m.name,
      size_mb: m.sizeMb,
      quantization: m.quantization,
      loaded_in_ram: globalState.activeModelId === m.id,
      cached_on_tmp: cachedFiles.includes(m.filename),
    })),
    runtime: {
      platform: process.platform,
      arch: process.arch,
      node_version: process.version,
      cpu_cores: os.cpus()?.length || 1,
      cpu_model: os.cpus()?.[0]?.model || 'unknown',
      vercel_region: process.env.VERCEL_REGION || 'local',
      vercel_env: process.env.VERCEL_ENV || 'development',
      uptime_seconds: Math.round((Date.now() - globalState.startedAt) / 1000),
      rss_mb: Math.round(mem.rss / 1024 / 1024),
      heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
      tmp_disk: disk,
    },
    stats: { ...globalState.stats },
  };
}
