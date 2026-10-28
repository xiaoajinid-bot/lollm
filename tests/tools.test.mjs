import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertPublicHttpUrl,
  convertUnits,
  detectToolCallStart,
  evaluateExpression,
  executeToolCall,
  getToolRegistry,
  listTools,
  loadConnectors,
  normalizeToolsInput,
  parseAllowedHosts,
  parseToolCalls,
  resolveToolChoice,
  stripToolCalls,
  validateArguments,
} from '../lib/tools.mjs';

test('evaluateExpression menghitung aritmetika & fungsi', () => {
  assert.equal(evaluateExpression('2 + 3 * 4'), 14);
  assert.equal(evaluateExpression('(2 + 3) * 4'), 20);
  assert.equal(evaluateExpression('2^10'), 1024);
  assert.equal(evaluateExpression('sqrt(81) + max(2, 7)'), 16);
  assert.equal(evaluateExpression('-5 + +2'), -3);
  assert.equal(evaluateExpression('10 % 3'), 1);
  assert.equal(evaluateExpression('round(pi * 100)'), 314);
  assert.equal(evaluateExpression('1,5 * 2'), 3, 'koma desimal Indonesia');
  assert.equal(evaluateExpression('2.5 * 4'), 10);
});

test('evaluateExpression menolak input tidak aman', () => {
  assert.throws(() => evaluateExpression('1 / 0'), /Pembagian dengan nol/);
  assert.throws(() => evaluateExpression('process.exit(1)'), /tidak dikenal/);
  assert.throws(() => evaluateExpression('(1 + 2'), /kurung/i);
  assert.throws(() => evaluateExpression(''), /kosong/i);
  assert.throws(() => evaluateExpression('2 $ 3'), /tidak terbaca|tidak valid/);
  assert.throws(() => evaluateExpression('1'.repeat(201)), /terlalu panjang/);
});

test('convertUnits mendukung beberapa kategori', () => {
  assert.equal(convertUnits(1, 'km', 'mi').value, 0.6213711922);
  assert.equal(convertUnits(100, 'c', 'f').value, 212);
  assert.equal(convertUnits(1, 'gb', 'mb').value, 1024);
  assert.equal(convertUnits(60, 'km/h', 'm/s').value, 16.66666667);
  assert.equal(convertUnits(1, 'jam', 'menit').value, 60);
  assert.throws(() => convertUnits(1, 'km', 'kg'), /tidak didukung/);
});

test('validateArguments menegakkan skema', () => {
  const schema = {
    type: 'object',
    properties: {
      expression: { type: 'string' },
      count: { type: 'integer', minimum: 1, maximum: 5 },
      mode: { type: 'string', enum: ['a', 'b'], default: 'a' },
    },
    required: ['expression'],
  };

  assert.deepEqual(validateArguments(schema, { expression: '1+1', count: 99 }), {
    expression: '1+1',
    count: 5,
    mode: 'a',
  });
  assert.throws(() => validateArguments(schema, {}), /wajib diisi/);
  assert.throws(() => validateArguments(schema, { expression: '1', mode: 'z' }), /harus salah satu/);
});

test('parseToolCalls mengenali berbagai format keluaran model', () => {
  const tag = parseToolCalls('Saya cek dulu.\n<tool_call>{"name":"calculate","arguments":{"expression":"2+2"}}</tool_call>');
  assert.equal(tag.length, 1);
  assert.equal(tag[0].name, 'calculate');
  assert.deepEqual(tag[0].arguments, { expression: '2+2' });

  const bare = parseToolCalls('{"name": "get_current_time", "arguments": {"timezone":"Asia/Jakarta"}}');
  assert.equal(bare[0].name, 'get_current_time');

  const fenced = parseToolCalls('```json\n{"name":"convert_units","arguments":{"value":1,"from":"km","to":"mi"}}\n```');
  assert.equal(fenced[0].name, 'convert_units');

  const openAiStyle = parseToolCalls(
    '{"tool_calls":[{"function":{"name":"calculate","arguments":"{\\"expression\\":\\"9*9\\"}"}}]}'
  );
  assert.equal(openAiStyle[0].name, 'calculate');
  assert.deepEqual(openAiStyle[0].arguments, { expression: '9*9' });

  const aliasArgs = parseToolCalls('{"name":"calculate","parameters":{"expression":"1+2"}}');
  assert.deepEqual(aliasArgs[0].arguments, { expression: '1+2' });

  assert.deepEqual(parseToolCalls('Tidak ada tool di sini.'), []);
  assert.deepEqual(parseToolCalls('<tool_call>{"name":"calculate"}</tool_call>')[0].arguments, {});
});

test('stripToolCalls membersihkan blok panggilan tanpa menghapus prosa', () => {
  const text = 'Sebentar, saya hitung.\n<tool_call>{"name":"calculate","arguments":{"expression":"2+2"}}</tool_call>';
  assert.equal(stripToolCalls(text), 'Sebentar, saya hitung.');

  const fenced = 'Hasil nanti.\n```json\n{"name":"calculate","arguments":{}}\n```';
  assert.equal(stripToolCalls(fenced), 'Hasil nanti.');
});

test('detectToolCallStart menemukan penanda paling awal', () => {
  assert.equal(detectToolCallStart('halo <tool_call>{"name":"calculate"}'), 5);
  assert.equal(detectToolCallStart('halo ```json\n{"name":"x"}'), 5);
  assert.equal(detectToolCallStart('tidak ada penanda'), -1);
});

test('assertPublicHttpUrl memblokir alamat privat dan menerapkan allowlist', () => {
  assert.throws(() => assertPublicHttpUrl('http://localhost:3000/x'), /diblokir/);
  assert.throws(() => assertPublicHttpUrl('http://127.0.0.1/'), /privat/);
  assert.throws(() => assertPublicHttpUrl('http://169.254.169.254/latest/meta-data'), /privat/);
  assert.throws(() => assertPublicHttpUrl('http://192.168.1.5/'), /privat/);
  assert.throws(() => assertPublicHttpUrl('http://[::1]/'), /privat/);
  assert.throws(() => assertPublicHttpUrl('file:///etc/passwd'), /http/);
  assert.throws(() => assertPublicHttpUrl('https://api.example.com', ['other.com']), /allowlist/);
  assert.ok(assertPublicHttpUrl('https://id.wikipedia.org/x', ['wikipedia.org']));
  assert.ok(assertPublicHttpUrl('https://api.github.com/x', null));
});

test('parseAllowedHosts membaca env koma', () => {
  assert.equal(parseAllowedHosts(undefined), null);
  assert.deepEqual(parseAllowedHosts('a.com, b.com'), ['a.com', 'b.com']);
});

test('registry memuat tool bawaan dan menghormati LLM_TOOLS_DISABLED', () => {
  const names = [...getToolRegistry({ env: {} }).keys()];
  for (const expected of ['calculate', 'get_current_time', 'convert_units', 'http_fetch', 'wikipedia_summary', 'llm_runtime_info']) {
    assert.ok(names.includes(expected), `${expected} harus terdaftar`);
  }

  const disabled = [...getToolRegistry({ env: { LLM_TOOLS_DISABLED: 'wikipedia_summary, calculate' } }).keys()];
  assert.ok(!disabled.includes('wikipedia_summary'));
  assert.ok(!disabled.includes('calculate'));
});

test('listTools menandai tool yang butuh allowlist', () => {
  const tools = listTools({ env: {}, names: ['http_fetch', 'calculate'] });
  const httpTool = tools.find((t) => t.name === 'http_fetch');
  const calc = tools.find((t) => t.name === 'calculate');
  assert.equal(httpTool.available, false);
  assert.equal(httpTool.requires_allowlist, true);
  assert.equal(calc.available, true);
  assert.equal(calc.source, 'builtin');
});

test('executeToolCall menjalankan tool nyata dan menangani error dengan rapi', async () => {
  const ok = await executeToolCall({ name: 'calculate', args: { expression: '(7+3)*2' }, env: {} });
  assert.equal(ok.ok, true);
  assert.equal(ok.result.result, 20);
  assert.equal(ok.source, 'builtin');

  const badArgs = await executeToolCall({ name: 'calculate', args: {}, env: {} });
  assert.equal(badArgs.ok, false);
  assert.match(badArgs.error, /wajib diisi/);

  const unknown = await executeToolCall({ name: 'tidak_ada', args: {}, env: {} });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.server_side, false);
  assert.ok(Array.isArray(unknown.available));
});

test('normalizeToolsInput mendukung tools & functions legacy', () => {
  const fromTools = normalizeToolsInput([
    { type: 'function', function: { name: 'a', description: 'A', parameters: { type: 'object' } } },
    { type: 'function', function: { name: 'a' } },
  ]);
  assert.equal(fromTools.length, 1);

  const fromFunctions = normalizeToolsInput(undefined, [{ name: 'b', description: 'B' }]);
  assert.equal(fromFunctions[0].name, 'b');
  assert.deepEqual(fromFunctions[0].parameters, { type: 'object', properties: {} });
});

test('resolveToolChoice memetakan mode OpenAI', () => {
  assert.equal(resolveToolChoice('none', ['a']).mode, 'none');
  assert.equal(resolveToolChoice('auto', ['a']).mode, 'auto');
  assert.equal(resolveToolChoice({ type: 'function', function: { name: 'a' } }, ['a']).mode, 'required');
  assert.deepEqual(resolveToolChoice({ type: 'function', function: { name: 'a' } }, ['a']).only, ['a']);
  assert.equal(resolveToolChoice('required', ['a', 'b']).mode, 'required');
});

test('loadConnectors mem-parse env dan mengeksekusi HTTP connector', async () => {
  const env = {
    LLM_CONNECTORS: JSON.stringify([
      {
        name: 'cuaca_demo',
        description: 'Cuaca demo',
        parameters: {
          type: 'object',
          properties: { kota: { type: 'string' }, token: { type: 'string', default: 'rahasia' } },
          required: ['kota'],
        },
        request: {
          url: 'https://api.example.com/cuaca?kota={{kota}}&token={{token}}&key={{env:DEMO_KEY}}',
          method: 'GET',
          headers: { Authorization: 'Bearer {{env:DEMO_KEY}}' },
        },
        response_path: 'data.summary',
      },
    ]),
    LLM_TOOL_HTTP_ALLOW_HOSTS: 'api.example.com',
    DEMO_KEY: 'k123',
  };

  assert.equal(loadConnectors({ env }).length, 1);
  assert.throws(() => loadConnectors({ env: { LLM_CONNECTORS: '{bukan json' } }), /JSON valid/);

  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, options) => {
    seen.push({ url: String(url), options });
    const payload = JSON.stringify({ data: { summary: 'Cerah 27°C' } });
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(payload));
          controller.close();
        },
      }),
    };
  };
  try {
    const result = await executeToolCall({
      name: 'cuaca_demo',
      args: { kota: 'Bandung' },
      env,
    });

    assert.equal(result.ok, true, result.error);
    assert.equal(result.source, 'connector');
    assert.equal(result.result.data, 'Cerah 27°C', 'response_path diterapkan');
    assert.match(seen[0].url, /kota=Bandung/);
    assert.match(seen[0].url, /token=rahasia/);
    assert.match(seen[0].url, /key=k123/, 'substitusi {{env:...}}');
    assert.equal(seen[0].options.headers.Authorization, 'Bearer k123');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('connector tanpa allowlist ditolak', async () => {
  const env = {
    LLM_CONNECTORS: JSON.stringify([
      { name: 'tanpa_izin', request: { url: 'https://api.example.com/x' } },
    ]),
  };
  const result = await executeToolCall({ name: 'tanpa_izin', args: {}, env });
  assert.equal(result.ok, false);
  assert.match(result.error, /allowlist/);
});

test('jsonQuery/response path tidak membocorkan objek besar', async () => {
  const big = 'x'.repeat(5000);
  const env = {
    LLM_CONNECTORS: JSON.stringify([
      { name: 'besar', request: { url: 'https://api.example.com/big' }, max_chars: 100 },
    ]),
    LLM_TOOL_HTTP_ALLOW_HOSTS: 'api.example.com',
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'text/plain' },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big));
        controller.close();
      },
    }),
  });
  try {
    const result = await executeToolCall({ name: 'besar', args: {}, env });
    assert.equal(result.ok, true);
    assert.ok(String(result.result.data).length <= 160, 'hasil dipotong');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('konfigurasi connector rusak tidak mematikan tool bawaan', async () => {
  const env = { LLM_CONNECTORS: '{rusak' };
  const registry = getToolRegistry({ env });
  assert.ok(registry.has('calculate'), 'tool bawaan tetap tersedia');
  assert.match(registry.connectorError, /JSON valid/);

  const result = await executeToolCall({ name: 'calculate', args: { expression: '2+2' }, env });
  assert.equal(result.ok, true);
});
