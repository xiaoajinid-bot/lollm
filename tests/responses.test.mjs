import assert from 'node:assert/strict';
import { register } from 'node:module';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  buildResponseObject,
  contentToText,
  convertResponsesInput,
  convertResponsesToolChoice,
  convertResponsesTools,
  createResponseStore,
  createResponsesStream,
} from '../lib/responses-api.mjs';

/* ------------------------- konversi input ------------------------- */

test('input string menjadi satu pesan user', () => {
  const { messages, instructions } = convertResponsesInput({ input: 'Halo' });
  assert.deepEqual(messages, [{ role: 'user', content: 'Halo' }]);
  assert.equal(instructions, '');
});

test('instructions menjadi pesan system di depan', () => {
  const { messages, instructions } = convertResponsesInput({
    instructions: 'Jawab singkat.',
    input: 'Halo',
  });
  assert.equal(instructions, 'Jawab singkat.');
  assert.deepEqual(messages[0], { role: 'system', content: 'Jawab singkat.' });
  assert.equal(messages.length, 2);
});

test('input array part input_text digabung', () => {
  const { messages } = convertResponsesInput({
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Baris satu. ' },
          { type: 'input_text', text: 'Baris dua.' },
        ],
      },
    ],
  });
  assert.deepEqual(messages, [{ role: 'user', content: 'Baris satu. Baris dua.' }]);
});

test('role developer diperlakukan sebagai system', () => {
  const { messages } = convertResponsesInput({
    input: [
      { role: 'developer', content: 'Aturan developer' },
      { role: 'user', content: 'Halo' },
    ],
  });
  assert.deepEqual(messages[0], { role: 'system', content: 'Aturan developer' });
});

test('item function_call & function_call_output dipetakan ke tool calling chat', () => {
  const { messages } = convertResponsesInput({
    input: [
      { role: 'user', content: 'Berapa 2+2?' },
      { type: 'function_call', call_id: 'call_1', name: 'calculate', arguments: '{"expression":"2+2"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '4' },
    ],
  });

  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[1].tool_calls[0].id, 'call_1');
  assert.equal(messages[1].tool_calls[0].function.name, 'calculate');
  assert.deepEqual(messages[2], {
    role: 'tool',
    tool_call_id: 'call_1',
    name: 'tool',
    content: '4',
  });
});

test('contentToText toleran terhadap bentuk aneh', () => {
  assert.equal(contentToText('abc'), 'abc');
  assert.equal(contentToText(null), '');
  assert.equal(contentToText({ text: 'x' }), 'x');
  assert.equal(contentToText([{ type: 'refusal', refusal: 'tidak' }]), 'tidak');
  assert.equal(contentToText([{ type: 'input_image', image_url: 'https://x' }]), '');
});

/* -------------------------- konversi tool -------------------------- */

test('tool format Responses dikonversi ke format chat', () => {
  const { tools, unsupported } = convertResponsesTools([
    {
      type: 'function',
      name: 'calculate',
      description: 'Hitung',
      parameters: { type: 'object', properties: { expression: { type: 'string' } } },
    },
  ]);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].type, 'function');
  assert.equal(tools[0].function.name, 'calculate');
  assert.equal(tools[0].function.description, 'Hitung');
  assert.deepEqual(unsupported, []);
});

test('tool format chat dibiarkan apa adanya', () => {
  const chatTool = {
    type: 'function',
    function: { name: 'x', description: 'd', parameters: { type: 'object', properties: {} } },
  };
  const { tools } = convertResponsesTools([chatTool]);
  assert.deepEqual(tools, [chatTool]);
});

test('tool bawaan OpenAI yang tidak didukung dilaporkan, bukan error', () => {
  const { tools, unsupported } = convertResponsesTools([
    { type: 'web_search_preview' },
    { type: 'function', name: 'ok', parameters: { type: 'object', properties: {} } },
  ]);
  assert.equal(tools.length, 1);
  assert.deepEqual(unsupported, ['web_search_preview']);
});

test('tool tanpa parameter diberi skema objek kosong', () => {
  const { tools } = convertResponsesTools([{ type: 'function', name: 'ping' }]);
  assert.deepEqual(tools[0].function.parameters, { type: 'object', properties: {} });
});

test('tool_choice string & objek function', () => {
  assert.equal(convertResponsesToolChoice(undefined), 'auto');
  assert.equal(convertResponsesToolChoice('required'), 'required');
  assert.deepEqual(convertResponsesToolChoice({ type: 'function', name: 'calculate' }), {
    type: 'function',
    function: { name: 'calculate' },
  });
});

/* -------------------------- objek respons -------------------------- */

test('buildResponseObject: teks menjadi item message output_text', () => {
  const response = buildResponseObject({
    id: 'resp_1',
    model: 'stub',
    createdAt: 123,
    text: 'Halo dunia',
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    meta: { instructions: 'x', maxOutputTokens: 100 },
  });

  assert.equal(response.object, 'responses');
  assert.equal(response.status, 'completed');
  assert.equal(response.output.length, 1);
  assert.equal(response.output[0].type, 'message');
  assert.equal(response.output[0].role, 'assistant');
  assert.equal(response.output[0].content[0].type, 'output_text');
  assert.equal(response.output_text, 'Halo dunia');
  assert.deepEqual(response.usage, {
    input_tokens: 10,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 5,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 15,
  });
});

test('buildResponseObject: tool call client menjadi item function_call', () => {
  const response = buildResponseObject({
    id: 'resp_2',
    model: 'stub',
    createdAt: 1,
    text: '',
    toolCalls: [{ id: 'call_9', name: 'kirim_email', arguments: { to: 'a@b.c' } }],
    finishReason: 'tool_calls',
    usage: {},
  });

  assert.equal(response.output.length, 1);
  const item = response.output[0];
  assert.equal(item.type, 'function_call');
  assert.equal(item.call_id, 'call_9');
  assert.equal(item.name, 'kirim_email');
  assert.deepEqual(JSON.parse(item.arguments), { to: 'a@b.c' });
  assert.equal(response.status, 'completed');
});

test('buildResponseObject: finish length → incomplete', () => {
  const response = buildResponseObject({
    id: 'resp_3',
    model: 'stub',
    createdAt: 1,
    text: 'terpotong',
    finishReason: 'length',
  });
  assert.equal(response.status, 'incomplete');
  assert.deepEqual(response.incomplete_details, { reason: 'max_output_tokens' });
});

test('buildResponseObject: metadata & unsupported tool dilaporkan', () => {
  const response = buildResponseObject({
    id: 'resp_4',
    model: 'stub',
    createdAt: 1,
    text: 'ok',
    meta: { metadata: { sesi: 'a' }, unsupportedTools: ['web_search'], store: false },
  });
  assert.deepEqual(response.metadata, { sesi: 'a' });
  assert.deepEqual(response.unsupported_tools, ['web_search']);
  assert.equal(response.store, false);
});

/* --------------------------- event SSE --------------------------- */

function collectStream() {
  const chunks = [];
  const writer = createResponsesStream({
    write: (chunk) => chunks.push(chunk),
    id: 'resp_stream',
    model: 'stub',
    createdAt: 1,
    meta: {},
  });
  const events = () =>
    chunks
      .join('')
      .split('\n\n')
      .filter(Boolean)
      .map((block) => {
        const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
        return dataLine ? JSON.parse(dataLine.slice(6)) : null;
      })
      .filter(Boolean);
  return { writer, chunks, events };
}

test('stream: urutan event teks sesuai spesifikasi', () => {
  const { writer, events, chunks } = collectStream();
  writer.begin();
  writer.textDelta('Halo ');
  writer.textDelta('dunia');
  const response = writer.finish({ finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 2 } });

  const types = events().map((event) => event.type);
  assert.deepEqual(types, [
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.content_part.added',
    'response.output_text.delta',
    'response.output_text.delta',
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.done',
    'response.completed',
  ]);

  // setiap event SSE memakai baris `event:` dan `data:`
  assert.ok(chunks.every((chunk) => chunk.startsWith('event: ')));
  assert.ok(chunks.every((chunk) => chunk.includes('\ndata: ')));

  const deltas = events().filter((event) => event.type === 'response.output_text.delta');
  assert.equal(deltas.map((event) => event.delta).join(''), 'Halo dunia');
  assert.equal(response.output_text, 'Halo dunia');

  const final = events().at(-1);
  assert.equal(final.response.id, 'resp_stream');
  assert.equal(final.response.status, 'completed');
  assert.equal(final.sequence_number, types.length - 1);
});

test('stream: tool call client menghasilkan event arguments delta', () => {
  const { writer, events } = collectStream();
  writer.begin();
  writer.toolCall({ id: 'call_1', name: 'calculate', arguments: { expression: '1+1' } });
  writer.finish({ finishReason: 'tool_calls', usage: {} });

  const types = events().map((event) => event.type);
  assert.ok(types.includes('response.function_call_arguments.delta'));
  assert.ok(types.includes('response.function_call_arguments.done'));
  assert.ok(types.includes('response.output_item.done'));

  const completed = events().at(-1);
  assert.equal(completed.response.output.length, 1);
  assert.equal(completed.response.output[0].type, 'function_call');
  assert.equal(completed.response.output[0].name, 'calculate');
});

test('stream: fail mengirim event error lalu menutup', () => {
  const { writer, events } = collectStream();
  writer.begin();
  writer.fail(new Error('model mati'));
  writer.textDelta('tidak boleh muncul');

  const types = events().map((event) => event.type);
  assert.deepEqual(types.slice(-1), ['error']);
  assert.equal(events().at(-1).message, 'model mati');
});

/* --------------------------- store memori --------------------------- */

test('response store: LRU sederhana', () => {
  const store = createResponseStore({ limit: 2 });
  store.set('a', { response: { id: 'a' } });
  store.set('b', { response: { id: 'b' } });
  store.set('c', { response: { id: 'c' } });
  assert.equal(store.get('a'), null);
  assert.equal(store.get('c').response.id, 'c');
  assert.equal(store.delete('c'), true);
  assert.equal(store.get('c'), null);
  assert.equal(store.size, 1);
});

/* ---------------------- endpoint lewat handler ---------------------- */

register('./helpers/stub-engine-loader.mjs', import.meta.url);
const { default: handler } = await import('../api/llm.mjs');

function createMock({ method = 'GET', url = '/', body } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.url = url;

  const res = {
    statusCode: 200,
    headers: {},
    chunks: [],
    writableEnded: false,
    setHeader(key, value) {
      this.headers[String(key).toLowerCase()] = value;
    },
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      Object.assign(this.headers, headers);
      return this;
    },
    write(chunk) {
      this.chunks.push(String(chunk));
      return true;
    },
    end(chunk) {
      if (chunk) this.chunks.push(String(chunk));
      this.writableEnded = true;
      return this;
    },
    on() {
      return this;
    },
    get text() {
      return this.chunks.join('');
    },
    get json() {
      return JSON.parse(this.text);
    },
  };

  return { req, res };
}

async function call(options) {
  const { req, res } = createMock(options);
  await handler(req, res);
  return res;
}

function parseSse(text) {
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((block) => block.split('\n').find((line) => line.startsWith('data: ')))
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice(6)));
}

function resetStub(queue = []) {
  globalThis.__stubInferenceQueue = queue;
  globalThis.__stubInferenceCalls = 0;
  globalThis.__stubInferenceArgs = [];
}

test('POST /v1/responses mengembalikan objek responses', async () => {
  resetStub(['Halo dari Responses API.']);

  const res = await call({
    method: 'POST',
    url: '/api/llm?__route=v1/responses',
    body: { model: 'stub', input: 'Halo', max_output_tokens: 512 },
  });

  assert.equal(res.statusCode, 200);
  const body = res.json;
  assert.match(body.id, /^resp_/);
  assert.equal(body.object, 'responses');
  assert.equal(body.status, 'completed');
  assert.equal(body.output_text, 'Halo dari Responses API.');
  assert.equal(body.output[0].content[0].text, 'Halo dari Responses API.');
  assert.equal(body.max_output_tokens, 512);

  const args = globalThis.__stubInferenceArgs[0];
  assert.equal(args.maxTokens, 512);
  assert.deepEqual(args.messages.at(-1), { role: 'user', content: 'Halo' });
});

test('POST /v1/responses bisa diambil ulang lewat GET', async () => {
  resetStub(['Simpan ini.']);

  const created = await call({
    method: 'POST',
    url: '/api/llm?__route=v1/responses',
    body: { input: 'Simpan' },
  });
  const id = created.json.id;

  const fetched = await call({ method: 'GET', url: `/api/llm?__route=v1/responses/${id}` });
  assert.equal(fetched.statusCode, 200);
  assert.equal(fetched.json.id, id);
  assert.equal(fetched.json.output_text, 'Simpan ini.');
});

test('GET /v1/responses/{id} yang tidak dikenal → 404 format OpenAI', async () => {
  const res = await call({ method: 'GET', url: '/api/llm?__route=v1/responses/resp_tidakada' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json.error.code, 'not_found');
});

test('DELETE /v1/responses/{id} menghapus dari cache', async () => {
  resetStub(['Hapus.']);
  const created = await call({
    method: 'POST',
    url: '/api/llm?__route=v1/responses',
    body: { input: 'Hapus' },
  });
  const id = created.json.id;

  const deleted = await call({ method: 'DELETE', url: `/api/llm?__route=v1/responses/${id}` });
  assert.equal(deleted.statusCode, 200);
  assert.deepEqual(deleted.json, { id, object: 'response.deleted', deleted: true });

  const fetched = await call({ method: 'GET', url: `/api/llm?__route=v1/responses/${id}` });
  assert.equal(fetched.statusCode, 404);
});

test('POST /v1/responses streaming mengirim event SSE Responses', async () => {
  resetStub(['Halo stream.']);

  const res = await call({
    method: 'POST',
    url: '/api/llm?__route=v1/responses',
    body: { input: 'Halo', stream: true },
  });

  assert.equal(res.statusCode, 200);
  const events = parseSse(res.text);
  const types = events.map((event) => event.type);
  assert.equal(types[0], 'response.created');
  assert.equal(types.at(-1), 'response.completed');
  assert.ok(types.includes('response.output_text.delta'));

  const text = events
    .filter((event) => event.type === 'response.output_text.delta')
    .map((event) => event.delta)
    .join('');
  assert.equal(text, 'Halo stream.');
  assert.equal(events.at(-1).response.output_text, 'Halo stream.');
});

test('POST /v1/responses tanpa input → 400', async () => {
  resetStub();
  const res = await call({ method: 'POST', url: '/api/llm?__route=v1/responses', body: {} });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json.error.code, 'missing_input');
});

test('POST /v1/responses dengan previous_response_id menyambung riwayat', async () => {
  resetStub(['Jawaban satu.', 'Jawaban dua.']);

  const first = await call({
    method: 'POST',
    url: '/api/llm?__route=v1/responses',
    body: { input: 'Pertanyaan satu' },
  });
  const id = first.json.id;

  const second = await call({
    method: 'POST',
    url: '/api/llm?__route=v1/responses',
    body: { input: 'Pertanyaan dua', previous_response_id: id },
  });

  assert.equal(second.statusCode, 200);
  const messages = globalThis.__stubInferenceArgs.at(-1).messages;
  assert.deepEqual(
    messages.map((message) => message.content),
    ['Pertanyaan satu', 'Pertanyaan dua']
  );
});

test('POST /v1/responses dengan previous_response_id tak dikenal → 404 jelas', async () => {
  resetStub();
  const res = await call({
    method: 'POST',
    url: '/api/llm?__route=v1/responses',
    body: { input: 'Halo', previous_response_id: 'resp_entah' },
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json.error.code, 'previous_response_not_found');
});

test('POST /v1/responses meneruskan tool format Responses ke agent', async () => {
  resetStub(['<tool_call>{"name":"calculate","arguments":{"expression":"2+2"}}</tool_call>', 'Hasilnya 4.']);

  const res = await call({
    method: 'POST',
    url: '/api/llm?__route=v1/responses',
    body: {
      input: 'Berapa 2+2?',
      tools: [
        {
          type: 'function',
          name: 'calculate',
          description: 'Hitung ekspresi',
          parameters: { type: 'object', properties: { expression: { type: 'string' } } },
        },
      ],
      tool_choice: 'required',
    },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json.output_text, 'Hasilnya 4.');
  assert.equal(globalThis.__stubInferenceCalls, 2, 'dua putaran: tool lalu jawaban');
});

test('POST /api/responses juga dilayani', async () => {
  resetStub(['Alias ok.']);
  const res = await call({ method: 'POST', url: '/api/llm?__route=api/responses', body: { input: 'x' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.output_text, 'Alias ok.');
});

/* ------------------------ konfigurasi routing ------------------------ */

test('vercel.json memetakan /v1/responses (termasuk :id) ke api/llm', async () => {
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(new URL('../vercel.json', import.meta.url), 'utf8');
  const config = JSON.parse(raw);
  const routes = config.rewrites.map((rewrite) => rewrite.source);

  for (const source of ['/v1/responses/:path*', '/api/responses/:path*', '/responses/:path*']) {
    assert.ok(routes.includes(source), `${source} harus ada di vercel.json`);
  }

  const responsesRewrite = config.rewrites.find(
    (rewrite) => rewrite.source === '/v1/responses/:path*'
  );
  assert.equal(responsesRewrite.destination, '/api/llm?__route=v1/responses/:path*');
});

test('daftar endpoint 404 menyebut /v1/responses', async () => {
  resetStub();
  const res = await call({ method: 'GET', url: '/api/llm?__route=tidak/ada' });
  assert.equal(res.statusCode, 404);
  assert.ok(res.json.error.available_endpoints.includes('POST /v1/responses'));
});
