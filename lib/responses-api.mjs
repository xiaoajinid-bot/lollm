/**
 * Kompatibilitas OpenAI **Responses API** (`POST /v1/responses`).
 *
 * Modul ini murni konversi + perakitan objek, tanpa menyentuh engine/model,
 * supaya bisa diuji tanpa `node-llama-cpp`. Handler di `api/llm.mjs` yang
 * menjalankan inferensi lewat `runToolAgent`.
 *
 * Referensi bentuk objek: https://platform.openai.com/docs/api-reference/responses
 */
import crypto from 'node:crypto';

/** Tipe tool Responses yang belum bisa dijalankan server (diabaikan, bukan error). */
const UNSUPPORTED_TOOL_TYPES = new Set(['web_search', 'web_search_preview', 'file_search', 'code_interpreter', 'image_generation', 'computer_use_preview', 'mcp']);

function shortId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

/** Ambil teks dari `content` yang berbentuk string atau array part Responses. */
export function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    if (content == null) return '';
    return typeof content === 'object' && typeof content.text === 'string' ? content.text : '';
  }
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      // Part multimodal (gambar/audio/file) belum didukung engine teks
      if (part.type === 'refusal' && typeof part.refusal === 'string') return part.refusal;
      return '';
    })
    .join('');
}

function parseArguments(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return { _raw: String(raw) };
  }
}

/**
 * Ubah `input` + `instructions` menjadi `messages` format chat.
 * Mendukung: string, array pesan `{role, content}`, `input_text`/`output_text`,
 * serta item `function_call` & `function_call_output` (pola tool calling Responses).
 */
export function convertResponsesInput(body = {}) {
  const messages = [];
  const instructions =
    typeof body.instructions === 'string' ? body.instructions.trim() : '';
  if (instructions) messages.push({ role: 'system', content: instructions });

  const input = body.input ?? body.messages;

  if (typeof input === 'string') {
    if (input.trim()) messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item) continue;
      if (typeof item === 'string') {
        if (item.trim()) messages.push({ role: 'user', content: item });
        continue;
      }
      const type = item.type || (item.role ? 'message' : '');

      if (type === 'function_call') {
        messages.push({
          role: 'assistant',
          content: contentToText(item.content),
          tool_calls: [
            {
              id: item.call_id || item.id || shortId('call'),
              type: 'function',
              function: {
                name: String(item.name || ''),
                arguments: JSON.stringify(parseArguments(item.arguments)),
              },
            },
          ],
        });
        continue;
      }

      if (type === 'function_call_output') {
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id || item.id,
          name: item.name || 'tool',
          content: contentToText(item.output),
        });
        continue;
      }

      if (item.role) {
        const role = item.role === 'developer' ? 'system' : String(item.role);
        const content = contentToText(item.content);
        if (content.trim()) messages.push({ role, content });
      }
    }
  }

  return { messages, instructions };
}

/** Tool Responses (`{type:'function', name, parameters}`) → format chat. */
export function convertResponsesTools(tools) {
  if (!Array.isArray(tools)) return { tools: [], unsupported: [] };
  const converted = [];
  const unsupported = [];

  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;

    // Sudah format chat (`{type:'function', function:{...}}`)
    if (tool.type === 'function' && tool.function?.name) {
      converted.push(tool);
      continue;
    }
    if (tool.type === 'function' && tool.name) {
      converted.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters:
            tool.parameters && typeof tool.parameters === 'object'
              ? tool.parameters
              : { type: 'object', properties: {} },
        },
      });
      continue;
    }
    if (typeof tool.type === 'string' && UNSUPPORTED_TOOL_TYPES.has(tool.type)) {
      unsupported.push(tool.type);
    }
  }

  return { tools: converted, unsupported: [...new Set(unsupported)] };
}

/** `tool_choice` Responses → format chat. */
export function convertResponsesToolChoice(choice) {
  if (choice == null || choice === '') return 'auto';
  if (typeof choice === 'string') return choice;
  if (choice?.type === 'function' && choice.name) {
    return { type: 'function', function: { name: choice.name } };
  }
  if (choice?.function?.name) return choice;
  return 'auto';
}

/** Nomor urut event SSE Responses (mulai 0, naik satu per event). */
export function createSequence() {
  let n = 0;
  return () => n++;
}

function emptyUsage(usage) {
  const input = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0);
  const output = Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0);
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: Number(usage?.total_tokens ?? input + output),
  };
}

function messageItem({ id, text, status = 'completed' }) {
  return {
    id,
    type: 'message',
    status,
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
}

function functionCallItem(call, status = 'completed') {
  return {
    id: call.itemId || shortId('fc'),
    type: 'function_call',
    status,
    call_id: call.id || call.call_id || shortId('call'),
    name: call.name,
    arguments: JSON.stringify(call.arguments ?? {}),
  };
}

/**
 * Rakit objek `response` final (non-streaming maupun event `response.completed`).
 */
export function buildResponseObject({
  id,
  model,
  createdAt,
  text = '',
  toolCalls = [],
  finishReason = 'stop',
  usage,
  messageId,
  meta = {},
}) {
  const output = [];
  if (text.trim().length > 0) {
    output.push(messageItem({ id: messageId || shortId('msg'), text }));
  }
  for (const call of toolCalls) {
    output.push(functionCallItem(call));
  }

  const incomplete = finishReason === 'length';
  const response = {
    id,
    object: 'responses',
    created_at: createdAt,
    status: incomplete ? 'incomplete' : 'completed',
    error: null,
    incomplete_details: incomplete ? { reason: 'max_output_tokens' } : null,
    instructions: meta.instructions || null,
    max_output_tokens: meta.maxOutputTokens ?? null,
    model,
    output,
    output_text: text,
    parallel_tool_calls: true,
    previous_response_id: meta.previousResponseId || null,
    reasoning: { effort: null, summary: null },
    store: meta.store !== false,
    temperature: meta.temperature ?? null,
    text: { format: { type: 'text' } },
    tool_choice: meta.toolChoice ?? 'auto',
    tools: Array.isArray(meta.tools) ? meta.tools : [],
    top_p: meta.topP ?? null,
    truncation: 'disabled',
    usage: emptyUsage(usage),
    user: null,
    metadata: meta.metadata && typeof meta.metadata === 'object' ? meta.metadata : {},
  };

  if (meta.unsupportedTools?.length) {
    response.unsupported_tools = meta.unsupportedTools;
  }
  // Konsisten dengan endpoint chat: jejak tool internal (tidak ada di spesifikasi)
  if (meta.trace?.length) response.tool_trace = meta.trace;

  return response;
}

/**
 * Penulis event SSE Responses API. Semua event memakai format:
 *     event: <type>\n data: {...}\n\n
 * dengan `sequence_number` naik satu per event.
 */
export function createResponsesStream({ write, id, model, createdAt, meta = {} }) {
  const seq = createSequence();
  const messageId = shortId('msg');
  const output = [];
  let text = '';
  let messageIndex = null;
  let partOpened = false;
  const toolItems = new Map();
  let closed = false;

  const emit = (type, payload) => {
    if (closed) return;
    write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq(), ...payload })}\n\n`);
  };

  const snapshot = (status) => ({
    id,
    object: 'responses',
    created_at: createdAt,
    status,
    error: null,
    incomplete_details: null,
    instructions: meta.instructions || null,
    max_output_tokens: meta.maxOutputTokens ?? null,
    model,
    output: [...output],
    output_text: text,
    parallel_tool_calls: true,
    previous_response_id: meta.previousResponseId || null,
    reasoning: { effort: null, summary: null },
    store: meta.store !== false,
    temperature: meta.temperature ?? null,
    text: { format: { type: 'text' } },
    tool_choice: meta.toolChoice ?? 'auto',
    tools: Array.isArray(meta.tools) ? meta.tools : [],
    top_p: meta.topP ?? null,
    truncation: 'disabled',
    usage: null,
    user: null,
    metadata: meta.metadata && typeof meta.metadata === 'object' ? meta.metadata : {},
  });

  return {
    messageId,

    begin() {
      emit('response.created', { response: snapshot('in_progress') });
      emit('response.in_progress', { response: snapshot('in_progress') });
    },

    textDelta(chunk) {
      if (!chunk) return;
      if (messageIndex === null) {
        messageIndex = output.length;
        const item = messageItem({ id: messageId, text: '', status: 'in_progress' });
        item.content = [];
        output.push(item);
        emit('response.output_item.added', { output_index: messageIndex, item });
        const part = { type: 'output_text', text: '', annotations: [] };
        emit('response.content_part.added', {
          item_id: messageId,
          output_index: messageIndex,
          content_index: 0,
          part,
        });
        partOpened = true;
      }
      text += chunk;
      emit('response.output_text.delta', {
        item_id: messageId,
        output_index: messageIndex,
        content_index: 0,
        delta: chunk,
        logprobs: [],
      });
    },

    /** Panggilan tool milik client → item `function_call` di output. */
    toolCall(call) {
      if (!call?.name) return;
      const item = functionCallItem(call);
      const index = output.length;
      output.push(item);
      toolItems.set(item.call_id, { item, index });
      emit('response.output_item.added', { output_index: index, item: { ...item, arguments: '', status: 'in_progress' } });
      emit('response.function_call_arguments.delta', {
        item_id: item.id,
        output_index: index,
        delta: item.arguments,
      });
      emit('response.function_call_arguments.done', {
        item_id: item.id,
        output_index: index,
        arguments: item.arguments,
      });
    },

    finish(result = {}) {
      if (closed) return null;

      if (messageIndex !== null && partOpened) {
        emit('response.output_text.done', {
          item_id: messageId,
          output_index: messageIndex,
          content_index: 0,
          text,
        });
        const part = { type: 'output_text', text, annotations: [] };
        emit('response.content_part.done', {
          item_id: messageId,
          output_index: messageIndex,
          content_index: 0,
          part,
        });
        const item = messageItem({ id: messageId, text });
        output[messageIndex] = item;
        emit('response.output_item.done', { output_index: messageIndex, item });
      }

      for (const { item, index } of toolItems.values()) {
        emit('response.output_item.done', { output_index: index, item });
      }

      const response = buildResponseObject({
        id,
        model,
        createdAt,
        text,
        toolCalls: [],
        finishReason: result.finishReason || 'stop',
        usage: result.usage,
        messageId,
        meta,
      });
      // Pakai item yang sudah dikirim di stream supaya id-nya konsisten
      response.output = [...output];
      response.output_text = text;

      emit('response.completed', { response });
      closed = true;
      return response;
    },

    fail(error) {
      if (closed) return;
      emit('error', {
        code: error?.code || 'server_error',
        message: error?.message || 'Gagal menjalankan inferensi LLM.',
        param: null,
      });
      closed = true;
    },

    close() {
      closed = true;
    },
  };
}

/**
 * Cache respons di memori instance (untuk `GET /v1/responses/:id`,
 * `DELETE`, dan `previous_response_id`).
 *
 * Serverless tidak punya storage lintas instance, jadi cache ini bersifat
 * best-effort: hanya berlaku selama instance function masih hidup.
 */
export function createResponseStore({ limit = 20 } = {}) {
  const entries = new Map();

  return {
    set(id, entry) {
      if (entries.has(id)) entries.delete(id);
      entries.set(id, entry);
      while (entries.size > limit) {
        const oldest = entries.keys().next().value;
        entries.delete(oldest);
      }
      return entry;
    },
    get(id) {
      return entries.get(id) || null;
    },
    delete(id) {
      return entries.delete(id);
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}
