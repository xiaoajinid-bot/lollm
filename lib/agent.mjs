/**
 * Agent loop untuk tool calling di atas model GGUF kecil.
 *
 * Alur:
 *   1. Suntikkan kontrak tool ke system prompt (buildToolInstructions).
 *   2. Jalankan inferensi; deteksi panggilan tool dari teks keluaran model.
 *   3. Bila model memanggil tool yang dikenal server → eksekusi, kirim hasil
 *      kembali sebagai pesan role "tool", lalu lanjutkan generasi.
 *   4. Bila tool tidak dikenal server (tool milik client) → kembalikan
 *      finish_reason "tool_calls" agar client yang mengeksekusi.
 *
 * Semua ketergantungan inferensi di-inject lewat `runInference` supaya modul
 * ini bisa diuji tanpa memuat model.
 */

import crypto from 'node:crypto';
import {
  buildToolInstructions,
  detectToolCallStart,
  executeToolCall,
  getToolRegistry,
  normalizeToolsInput,
  parseToolCalls,
  resolveToolChoice,
  stripToolCalls,
} from './tools.mjs';

const DEFAULT_MAX_ROUNDS = 3;
const MAX_ROUNDS_LIMIT = 6;
const STREAM_HOLDBACK = 48;

export function toTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        if (part && part.type === 'text' && typeof part.value === 'string') return part.value;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content === null || content === undefined) return '';
  return String(content);
}

function normalizeAssistantToolCalls(message) {
  const raw = Array.isArray(message.tool_calls) ? message.tool_calls : Array.isArray(message.function_call) ? [message.function_call] : [];
  return raw
    .map((call) => {
      const fn = call?.function ?? call;
      const name = fn?.name;
      if (!name) return null;
      let args = fn?.arguments;
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          args = { _raw: args };
        }
      }
      return { id: call?.id || `call_${crypto.randomBytes(6).toString('hex')}`, name: String(name), arguments: args && typeof args === 'object' ? args : {} };
    })
    .filter(Boolean);
}

export function normalizeMessages(messages, prompt) {
  const output = [];

  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!message || typeof message !== 'object') continue;
      const role = String(message.role || 'user').toLowerCase();
      const content = toTextContent(message.content);

      if (role === 'tool' || role === 'function') {
        output.push({ role: 'tool', name: String(message.name || message.tool_call_id || 'tool'), content });
      } else if (role === 'assistant' || role === 'model') {
        const calls = normalizeAssistantToolCalls(message);
        output.push({ role: 'assistant', content, tool_calls: calls.length ? calls : undefined });
      } else if (role === 'system' || role === 'developer') {
        output.push({ role: 'system', content });
      } else {
        output.push({ role: 'user', content });
      }
    }
  }

  if (output.length === 0) {
    const text = String(prompt ?? '').trim();
    if (text) output.push({ role: 'user', content: text });
  }

  return output;
}

/** Konversi riwayat internal menjadi format yang dipahami runChatInference. */
export function toEngineMessages(workingMessages) {
  return workingMessages
    .map((message) => {
      if (message.role === 'tool') {
        return { role: 'user', content: `[hasil tool ${message.name}]\n${message.content}` };
      }
      if (message.role === 'assistant' && message.tool_calls?.length) {
        const callText = message.tool_calls
          .map((call) => `[memanggil tool ${call.name} dengan argumen ${JSON.stringify(call.arguments)}]`)
          .join('\n');
        return { role: 'assistant', content: [message.content, callText].filter(Boolean).join('\n') };
      }
      return { role: message.role, content: message.content };
    })
    .filter((message) => typeof message.content === 'string' && message.content.trim().length > 0);
}

/**
 * Pembungkus streaming: menahan sebagian teks terakhir agar blok panggilan tool
 * tidak sempat terkirim ke client sebagai isi jawaban.
 */
class RoundStream {
  constructor(onTextChunk) {
    this.onTextChunk = onTextChunk;
    this.buffer = '';
    this.emitted = '';
    this.toolDetected = false;
  }

  push(chunk) {
    if (!chunk) return;
    this.buffer += chunk;
    this.maybeFlush(false);
  }

  maybeFlush(force) {
    if (this.toolDetected) return;

    const markerIndex = detectToolCallStart(this.buffer);
    if (markerIndex >= 0) {
      const prose = this.buffer.slice(0, markerIndex);
      this.buffer = this.buffer.slice(markerIndex);
      if (prose) this.emit(prose);
      this.toolDetected = true;
      return;
    }

    if (force) {
      const rest = this.buffer;
      this.buffer = '';
      if (rest) this.emit(rest);
      return;
    }

    if (this.buffer.length <= STREAM_HOLDBACK) return;
    const cut = this.buffer.length - STREAM_HOLDBACK;
    const ready = this.buffer.slice(0, cut);
    this.buffer = this.buffer.slice(cut);
    if (ready) this.emit(ready);
  }

  emit(text) {
    if (!text) return;
    this.emitted += text;
    if (this.onTextChunk) this.onTextChunk(text);
  }

  /** Selesai tanpa panggilan tool: kirim sisa buffer. */
  finishWithText(fallbackText) {
    this.maybeFlush(true);
    if (!this.emitted.trim() && fallbackText && String(fallbackText).trim()) {
      this.emit(String(fallbackText));
    }
    return this.emitted;
  }

  /** Selesai dengan panggilan tool: buang JSON panggilan, simpan prosa saja. */
  finishWithToolCalls(fullText, calls) {
    if (!this.emitted.trim()) {
      const prose = stripToolCalls(fullText, calls);
      if (prose && !prose.includes('{')) this.emit(prose);
    }
    this.buffer = '';
    return this.emitted;
  }
}

function createTraceEntry(call, execution) {
  return {
    id: call.id,
    name: call.name,
    arguments: execution?.arguments ?? call.arguments,
    ok: Boolean(execution?.ok),
    source: execution?.source ?? 'builtin',
    duration_ms: execution?.duration_ms ?? 0,
    result_preview:
      execution?.ok === false
        ? `ERROR: ${execution?.error || 'gagal'}`
        : String(
            typeof execution?.result === 'string' ? execution.result : JSON.stringify(execution?.result ?? null)
          ).slice(0, 400),
  };
}

function formatToolResultForModel(call, execution) {
  if (!execution.ok) {
    return JSON.stringify({ ok: false, error: execution.error });
  }
  return JSON.stringify({ ok: true, result: execution.result }).slice(0, 6000);
}

/**
 * @param {object} params
 * @param {(args: object) => Promise<{text: string, finishReason?: string, usage?: object, timings?: object}>} params.runInference
 */
export async function runToolAgent({
  messages,
  prompt,
  tools,
  functions,
  toolChoice = 'auto',
  maxRounds = process.env.LLM_TOOL_MAX_ROUNDS || DEFAULT_MAX_ROUNDS,
  temperature,
  topP,
  maxTokens,
  signal,
  env = process.env,
  registry,
  ctx = {},
  onTextChunk,
  onToolCall,
  onToolResult,
  onRound,
  runInference,
}) {
  if (typeof runInference !== 'function') {
    throw new Error('runToolAgent membutuhkan fungsi runInference.');
  }

  const working = normalizeMessages(messages, prompt);
  if (working.length === 0) {
    const err = new Error('Parameter "messages" atau "prompt" wajib diisi.');
    err.statusCode = 400;
    throw err;
  }

  const requestedTools = normalizeToolsInput(tools, functions);
  const choice = resolveToolChoice(toolChoice, requestedTools.map((tool) => tool.name));
  const hasTools = requestedTools.length > 0 && choice.mode !== 'none';

  const accumulate = (usage) => {
    if (!usage) return;
    totalUsage.prompt_tokens += Number(usage.prompt_tokens || 0);
    totalUsage.completion_tokens += Number(usage.completion_tokens || 0);
    totalUsage.total_tokens += Number(usage.total_tokens || 0);
  };

  const totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const trace = [];
  let lastTimings = null;
  let rounds = 0;

  const runOnce = async (workingMessages, instructions, streamWrapper) => {
    const result = await runInference({
      messages: toEngineMessages(workingMessages),
      extraSystemPrompt: instructions,
      temperature,
      topP,
      maxTokens,
      signal,
      ...(streamWrapper ? { onTokenChunk: (chunk) => streamWrapper.push(chunk) } : {}),
    });
    if (result?.usage) accumulate(result.usage);
    if (result?.timings) lastTimings = result.timings;
    return result;
  };

  // Tanpa tool → perilaku lama (satu kali inferensi)
  if (!hasTools) {
    const stream = new RoundStream(onTextChunk);
    const result = await runOnce(working, '', stream);
    const text = onTextChunk ? stream.finishWithText(result.text) : result.text || stream.emitted;
    return {
      text,
      finishReason: result.finishReason || 'stop',
      toolCalls: [],
      trace,
      rounds: 1,
      usage: totalUsage,
      timings: lastTimings,
    };
  }

  const toolRegistry = registry || getToolRegistry({ env });
  const toolSpecs = requestedTools.map((tool) => ({
    name: tool.name,
    description: tool.description || toolRegistry.get(tool.name)?.description || 'Tool tanpa deskripsi.',
    parameters: tool.parameters,
  }));

  // tool_choice menunjuk tool tertentu → hanya tool itu yang ditawarkan
  const offeredSpecs = choice.mode === 'required' && choice.only.length > 0
    ? toolSpecs.filter((spec) => choice.only.includes(spec.name))
    : toolSpecs;
  const offered = offeredSpecs.length > 0 ? offeredSpecs : toolSpecs;

  const boundedRounds = Math.max(1, Math.min(MAX_ROUNDS_LIMIT, Number(maxRounds) || DEFAULT_MAX_ROUNDS));
  const emittedParts = [];

  const forwardChunk = (text) => {
    emittedParts.push(text);
    if (onTextChunk) onTextChunk(text);
  };

  for (let round = 1; round <= boundedRounds; round += 1) {
    rounds = round;
    if (onRound) onRound({ round, tools: offered.map((spec) => spec.name) });

    const instructions = buildToolInstructions(offered, {
      required: round === 1 && choice.mode === 'required',
    });

    const stream = new RoundStream(forwardChunk);
    const result = await runOnce(working, instructions, stream);
    const fullText = result.text || stream.emitted || '';
    const calls = parseToolCalls(fullText);

    if (calls.length === 0) {
      stream.finishWithText(fullText);
      return {
        text: emittedParts.join('') || fullText,
        finishReason: result.finishReason || 'stop',
        toolCalls: [],
        trace,
        rounds,
        usage: totalUsage,
        timings: lastTimings,
      };
    }

    const unknownCalls = calls.filter((call) => !toolRegistry.has(call.name));
    if (unknownCalls.length > 0) {
      stream.finishWithToolCalls(fullText, calls);
      const clientCalls = calls.map((call) => ({
        id: call.id || `call_${crypto.randomBytes(6).toString('hex')}`,
        name: call.name,
        arguments: call.arguments,
      }));
      return {
        text: emittedParts.join(''),
        finishReason: 'tool_calls',
        toolCalls: clientCalls,
        trace,
        rounds,
        usage: totalUsage,
        timings: lastTimings,
      };
    }

    stream.finishWithToolCalls(fullText, calls);
    const prose = stripToolCalls(fullText, calls);
    const assistantMessage = {
      role: 'assistant',
      content: prose,
      tool_calls: calls.map((call) => ({
        id: call.id || `call_${crypto.randomBytes(6).toString('hex')}`,
        name: call.name,
        arguments: call.arguments,
      })),
    };
    working.push(assistantMessage);

    for (const call of assistantMessage.tool_calls) {
      if (onToolCall) onToolCall({ id: call.id, name: call.name, arguments: call.arguments });
      const execution = await executeToolCall({
        name: call.name,
        args: call.arguments,
        ctx: { ...ctx, registry: toolRegistry },
        env,
      });
      trace.push(createTraceEntry(call, execution));
      if (onToolResult) onToolResult(createTraceEntry(call, execution));

      working.push({
        role: 'tool',
        name: call.name,
        content: formatToolResultForModel(call, execution),
      });
    }

    if (round === boundedRounds) {
      // Putaran habis: minta jawaban final tanpa tool lagi.
      const finalInstructions = [
        'Semua tool sudah dieksekusi. Jangan memanggil tool lagi.',
        'Jawab pengguna sekarang memakai hasil tool di atas, dengan bahasa yang jelas dan singkat.',
      ].join(' ');
      const finalStream = new RoundStream(forwardChunk);
      const finalResult = await runOnce(working, finalInstructions, finalStream);
      // Jangan pernah bocorkan JSON panggilan tool sebagai jawaban akhir
      const cleanFinal = stripToolCalls(finalResult.text || '');
      const finalMessage =
        cleanFinal ||
        'Maaf, model belum bisa menyelesaikan permintaan ini tanpa memanggil tool lagi. Coba pertanyaan yang lebih spesifik.';
      finalStream.finishWithText(finalMessage);
      return {
        text: emittedParts.join('') || finalMessage,
        finishReason: finalResult.finishReason || 'stop',
        toolCalls: [],
        trace,
        rounds,
        usage: totalUsage,
        timings: lastTimings,
      };
    }
  }

  return {
    text: emittedParts.join(''),
    finishReason: 'stop',
    toolCalls: [],
    trace,
    rounds,
    usage: totalUsage,
    timings: lastTimings,
  };
}
