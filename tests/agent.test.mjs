import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeMessages, runToolAgent, toEngineMessages } from '../lib/agent.mjs';
import { toOpenAIToolSchema } from '../lib/tools.mjs';

const CALC_TOOL = toOpenAIToolSchema({
  name: 'calculate',
  description: 'Menghitung ekspresi matematika.',
  parameters: {
    type: 'object',
    properties: { expression: { type: 'string' } },
    required: ['expression'],
  },
});

const CLIENT_TOOL = {
  type: 'function',
  function: {
    name: 'ambil_data_internal',
    description: 'Tool milik client.',
    parameters: { type: 'object', properties: {} },
  },
};

function chunkText(text, size = 7) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

/** runInference palsu: mengembalikan keluaran skrip berurutan sambil streaming. */
function scriptedInference(script) {
  const calls = [];
  const fn = async (args) => {
    const index = Math.min(calls.length, script.length - 1);
    const step = script[index];
    calls.push(args);
    const text = typeof step === 'function' ? step(args) : step;
    if (args.onTokenChunk) {
      for (const chunk of chunkText(text)) args.onTokenChunk(chunk);
    }
    return {
      text,
      finishReason: 'stop',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      timings: { generation_ms: 120, cold_load: false },
    };
  };
  fn.calls = calls;
  return fn;
}

test('tanpa tools, agent hanya memanggil inferensi sekali', async () => {
  const runInference = scriptedInference(['Halo! Ada yang bisa dibantu?']);
  const result = await runToolAgent({
    messages: [{ role: 'user', content: 'Halo' }],
    runInference,
  });

  assert.equal(result.text, 'Halo! Ada yang bisa dibantu?');
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.rounds, 1);
  assert.deepEqual(result.toolCalls, []);
  assert.equal(runInference.calls.length, 1);
  assert.equal(runInference.calls[0].extraSystemPrompt, '');
});

test('tool server dieksekusi lalu jawaban final dihasilkan', async () => {
  const runInference = scriptedInference([
    'Sebentar, saya hitung.\n<tool_call>{"name":"calculate","arguments":{"expression":"(7+3)*2"}}</tool_call>',
    'Hasilnya 20.',
  ]);

  const streamed = [];
  const toolEvents = [];
  const result = await runToolAgent({
    messages: [{ role: 'user', content: 'Berapa (7+3)*2?' }],
    tools: [CALC_TOOL],
    runInference,
    onTextChunk: (chunk) => streamed.push(chunk),
    onToolCall: (call) => toolEvents.push(['call', call.name]),
    onToolResult: (info) => toolEvents.push(['result', info.ok]),
  });

  assert.equal(runInference.calls.length, 2, 'satu putaran tool + satu jawaban final');
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.trace.length, 1);
  assert.equal(result.trace[0].name, 'calculate');
  assert.equal(result.trace[0].ok, true);
  assert.deepEqual(toolEvents, [['call', 'calculate'], ['result', true]]);

  // Prompt tool benar-benar disuntikkan pada putaran pertama
  assert.match(runInference.calls[0].extraSystemPrompt, /KEBIJAKAN TOOL/);
  assert.match(runInference.calls[0].extraSystemPrompt, /calculate/);

  // Hasil tool diteruskan kembali ke model sebagai pesan role "tool"
  const secondMessages = runInference.calls[1].messages;
  const toolMessage = secondMessages.find((m) => String(m.content).includes('[hasil tool calculate]'));
  assert.ok(toolMessage, 'pesan hasil tool harus diteruskan ke model');
  assert.match(toolMessage.content, /"result":20/);

  const streamedText = streamed.join('');
  assert.ok(streamedText.includes('Sebentar, saya hitung.'));
  assert.ok(!streamedText.includes('<tool_call>'), 'blok tool_call tidak boleh bocor ke client');
  assert.ok(!streamedText.includes('"arguments"'));
  assert.ok(streamedText.includes('Hasilnya 20.'));
  assert.equal(result.text, streamedText.trim() === result.text.trim() ? result.text : streamedText.replace(/^\s+/, ''));
});

test('tool milik client dikembalikan sebagai tool_calls tanpa dieksekusi', async () => {
  const runInference = scriptedInference([
    '<tool_call>{"name":"ambil_data_internal","arguments":{"id":7}}</tool_call>',
  ]);

  const result = await runToolAgent({
    messages: [{ role: 'user', content: 'Ambil data 7' }],
    tools: [CLIENT_TOOL],
    runInference,
  });

  assert.equal(result.finishReason, 'tool_calls');
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, 'ambil_data_internal');
  assert.deepEqual(result.toolCalls[0].arguments, { id: 7 });
  assert.ok(result.toolCalls[0].id);
  assert.equal(runInference.calls.length, 1, 'tidak ada putaran tambahan');
});

test('putaran tool dibatasi dan diakhiri dengan jawaban final', async () => {
  const loopCall = '<tool_call>{"name":"calculate","arguments":{"expression":"1+1"}}</tool_call>';
  const runInference = scriptedInference([loopCall, loopCall, 'Jawaban akhir tanpa tool: 2.']);

  const result = await runToolAgent({
    messages: [{ role: 'user', content: 'Hitung terus' }],
    tools: [CALC_TOOL],
    maxRounds: 2,
    runInference,
  });

  assert.equal(runInference.calls.length, 3, '2 putaran tool + 1 paksa jawaban final');
  assert.equal(result.trace.length, 2);
  assert.match(runInference.calls[2].extraSystemPrompt, /Jangan memanggil tool lagi/);
  assert.match(result.text, /Jawaban akhir/);
});

test('tool_choice none menonaktifkan tool calling', async () => {
  const runInference = scriptedInference(['Jawaban langsung.']);
  const result = await runToolAgent({
    messages: [{ role: 'user', content: 'Halo' }],
    tools: [CALC_TOOL],
    toolChoice: 'none',
    runInference,
  });

  assert.equal(runInference.calls.length, 1);
  assert.equal(runInference.calls[0].extraSystemPrompt, '');
  assert.equal(result.text, 'Jawaban langsung.');
});

test('tool_choice menunjuk tool tertentu membatasi tool yang ditawarkan', async () => {
  const runInference = scriptedInference([
    '<tool_call>{"name":"calculate","arguments":{"expression":"3*3"}}</tool_call>',
    'Sembilan.',
  ]);

  await runToolAgent({
    messages: [{ role: 'user', content: '3*3' }],
    tools: [CALC_TOOL, CLIENT_TOOL],
    toolChoice: { type: 'function', function: { name: 'calculate' } },
    runInference,
  });

  const instructions = runInference.calls[0].extraSystemPrompt;
  assert.match(instructions, /calculate/);
  assert.ok(!instructions.includes('ambil_data_internal'), 'tool lain tidak ditawarkan');
  assert.match(instructions, /WAJIB memanggil/);
});

test('tool yang gagal tetap dikirim sebagai hasil error ke model', async () => {
  const runInference = scriptedInference([
    '<tool_call>{"name":"calculate","arguments":{}}</tool_call>',
    'Maaf, argumennya kurang.',
  ]);

  const result = await runToolAgent({
    messages: [{ role: 'user', content: 'hitung' }],
    tools: [CALC_TOOL],
    runInference,
  });

  assert.equal(result.trace[0].ok, false);
  assert.match(result.trace[0].result_preview, /ERROR/);
  const toolMessage = runInference.calls[1].messages.find((m) => String(m.content).includes('[hasil tool calculate]'));
  assert.match(toolMessage.content, /"ok":false/);
  assert.match(result.text, /argumennya kurang/);
});

test('usage diakumulasi lintas putaran', async () => {
  const runInference = scriptedInference([
    '<tool_call>{"name":"calculate","arguments":{"expression":"1+1"}}</tool_call>',
    'Dua.',
  ]);

  const result = await runToolAgent({
    messages: [{ role: 'user', content: '1+1' }],
    tools: [CALC_TOOL],
    runInference,
  });

  assert.equal(result.usage.completion_tokens, 10);
  assert.equal(result.usage.prompt_tokens, 20);
  assert.equal(result.usage.total_tokens, 30);
  assert.equal(result.timings.generation_ms, 120);
});

test('normalizeMessages merapikan riwayat OpenAI termasuk role tool', () => {
  const normalized = normalizeMessages([
    { role: 'system', content: 'aturan' },
    { role: 'user', content: [{ type: 'text', text: 'halo' }] },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'calculate', arguments: '{"expression":"1+1"}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', name: 'calculate', content: '{"ok":true}' },
  ]);

  assert.equal(normalized[0].role, 'system');
  assert.equal(normalized[1].content, 'halo');
  assert.equal(normalized[2].tool_calls[0].name, 'calculate');
  assert.deepEqual(normalized[2].tool_calls[0].arguments, { expression: '1+1' });
  assert.equal(normalized[3].role, 'tool');
  assert.equal(normalized[3].name, 'calculate');
});

test('toEngineMessages memberi label hasil tool dan panggilan tool', () => {
  const engineMessages = toEngineMessages([
    { role: 'user', content: 'halo' },
    { role: 'assistant', content: '', tool_calls: [{ name: 'calculate', arguments: { expression: '1+1' } }] },
    { role: 'tool', name: 'calculate', content: '{"ok":true,"result":2}' },
  ]);

  assert.equal(engineMessages[0].role, 'user');
  assert.match(engineMessages[1].content, /memanggil tool calculate/);
  assert.match(engineMessages[2].content, /\[hasil tool calculate\]/);
});

test('prompt singkat didukung tanpa array messages', async () => {
  const runInference = scriptedInference(['Halo juga.']);
  const result = await runToolAgent({ prompt: 'Halo', runInference });
  assert.equal(result.text, 'Halo juga.');
  assert.equal(runInference.calls[0].messages[0].content, 'Halo');
});

test('tanpa messages/prompt agent melempar 400', async () => {
  await assert.rejects(
    () => runToolAgent({ runInference: async () => ({ text: '' }) }),
    (err) => err.statusCode === 400
  );
});

test('nudge: permintaan berdata memaksa koreksi bila model menjawab tanpa tool', async () => {
  const runInference = scriptedInference([
    'Kira-kira sore.', // putaran 1: tidak memanggil tool
    '<tool_call>{"name":"calculate","arguments":{"expression":"7+3"}}</tool_call>', // koreksi
    'Hasilnya 10.',
  ]);

  const streamed = [];
  const result = await runToolAgent({
    messages: [{ role: 'user', content: 'Jam berapa sekarang dan berapa 7+3?' }],
    tools: [CALC_TOOL],
    runInference,
    onTextChunk: (chunk) => streamed.push(chunk),
  });

  assert.equal(runInference.calls.length, 3, 'putaran 1 + koreksi + jawaban final');
  assert.equal(result.trace.length, 1);
  assert.equal(result.trace[0].name, 'calculate');

  const text = streamed.join('');
  assert.ok(!text.includes('Kira-kira sore.'), 'teks putaran pertama yang dibuang tidak boleh tampil');
  assert.ok(text.includes('Hasilnya 10.'));
  assert.match(runInference.calls[1].extraSystemPrompt, /WAJIB memanggil/);
});

test('nudge: bila model tetap menolak, jawaban asli tetap ditampilkan', async () => {
  const runInference = scriptedInference(['Sekitar sore.', 'Saya tidak punya tool.']);

  const streamed = [];
  const result = await runToolAgent({
    messages: [{ role: 'user', content: 'Jam berapa sekarang?' }],
    tools: [CALC_TOOL],
    runInference,
    onTextChunk: (chunk) => streamed.push(chunk),
  });

  assert.equal(runInference.calls.length, 2);
  assert.deepEqual(result.toolCalls, []);
  assert.equal(result.trace.length, 0);
  assert.ok(streamed.join('').includes('Sekitar sore.'), 'jawaban asli harus ditampilkan');
});

test('nudge: sapaan tidak memaksa tool', async () => {
  const runInference = scriptedInference(['Halo! Ada yang bisa dibantu?']);
  const result = await runToolAgent({
    messages: [{ role: 'user', content: 'Halo, apa kabar?' }],
    tools: [CALC_TOOL],
    runInference,
  });

  assert.equal(runInference.calls.length, 1, 'tanpa putaran koreksi');
  assert.equal(result.trace.length, 0);
  assert.match(result.text, /Halo!/);
});

test('nudge: LLM_TOOL_FIRST=off mematikan koreksi otomatis', async () => {
  const runInference = scriptedInference(['Sekitar sore.']);
  const result = await runToolAgent({
    messages: [{ role: 'user', content: 'Jam berapa sekarang?' }],
    tools: [CALC_TOOL],
    env: { LLM_TOOL_FIRST: 'off' },
    runInference,
  });

  assert.equal(runInference.calls.length, 1);
  assert.equal(result.trace.length, 0);
});
