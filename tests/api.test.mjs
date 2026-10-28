import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { register } from 'node:module';
import test from 'node:test';

// Engine diarahkan ke stub (tanpa node-llama-cpp / model GGUF)
register('./helpers/stub-engine-loader.mjs', import.meta.url);
const { default: handler } = await import('../api/llm.mjs');

const CALC_TOOL = {
  type: 'function',
  function: {
    name: 'calculate',
    description: 'Menghitung ekspresi matematika.',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string' } },
      required: ['expression'],
    },
  },
};

const CLIENT_TOOL = {
  type: 'function',
  function: {
    name: 'kirim_email',
    description: 'Tool milik client.',
    parameters: { type: 'object', properties: {} },
  },
};

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
      for (const [key, value] of Object.entries(headers)) {
        this.headers[String(key).toLowerCase()] = value;
      }
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
    once() {
      return this;
    },
    emit() {
      return true;
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

function resetStub(queue = []) {
  globalThis.__stubInferenceQueue = queue;
  globalThis.__stubInferenceCalls = 0;
  globalThis.__stubInferenceArgs = [];
}

function parseSse(text) {
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === '[DONE]') continue;
    events.push(JSON.parse(payload));
  }
  return events;
}

test('GET /api/tools mengembalikan katalog tool', async () => {
  resetStub();
  const res = await call({ method: 'GET', url: '/api/llm?__route=api/tools' });

  assert.equal(res.statusCode, 200);
  const body = res.json;
  assert.equal(body.object, 'list');
  const names = body.data.map((tool) => tool.function.name);
  for (const expected of ['calculate', 'get_current_time', 'convert_units', 'wikipedia_summary']) {
    assert.ok(names.includes(expected), `${expected} harus ada di katalog`);
  }
  assert.equal(typeof body.config.max_rounds, 'number');
  assert.equal(body.data[0].type, 'function');
});

test('GET /api/tools?names= memfilter katalog', async () => {
  resetStub();
  const res = await call({ method: 'GET', url: '/api/llm?__route=api/tools&names=calculate' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json.data.map((tool) => tool.function.name), ['calculate']);
});

test('POST /api/tools mengeksekusi tool secara langsung', async () => {
  resetStub();
  const ok = await call({
    method: 'POST',
    url: '/api/llm?__route=api/tools',
    body: { name: 'calculate', arguments: { expression: '6*7' } },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.result.result, 42);

  const unknown = await call({
    method: 'POST',
    url: '/api/llm?__route=api/tools',
    body: { name: 'tidak_ada', arguments: {} },
  });
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json.ok, false);

  const noName = await call({ method: 'POST', url: '/api/llm?__route=api/tools', body: {} });
  assert.equal(noName.statusCode, 400);
});

test('chat non-stream tanpa tools tetap kompatibel', async () => {
  resetStub(['Halo dari stub.']);
  const res = await call({
    method: 'POST',
    url: '/api/llm?__route=v1/chat/completions',
    body: { messages: [{ role: 'user', content: 'Halo' }] },
  });

  assert.equal(res.statusCode, 200);
  const body = res.json;
  assert.equal(body.choices[0].message.role, 'assistant');
  assert.equal(body.choices[0].message.content, 'Halo dari stub.');
  assert.equal(body.choices[0].finish_reason, 'stop');
  assert.equal(body.tool_trace, undefined);
  assert.equal(globalThis.__stubInferenceCalls, 1);
});

test('chat non-stream dengan tools mengeksekusi tool server', async () => {
  resetStub([
    '<tool_call>{"name":"calculate","arguments":{"expression":"6*7"}}</tool_call>',
    'Hasilnya 42.',
  ]);

  const res = await call({
    method: 'POST',
    url: '/api/llm?__route=v1/chat/completions',
    body: { messages: [{ role: 'user', content: 'Berapa 6*7?' }], tools: [CALC_TOOL] },
  });

  assert.equal(res.statusCode, 200);
  const body = res.json;
  assert.equal(body.choices[0].message.content, 'Hasilnya 42.');
  assert.equal(body.choices[0].message.tool_calls, undefined, 'tool server tidak dikembalikan ke client');
  assert.equal(body.choices[0].finish_reason, 'stop');
  assert.equal(body.tool_trace[0].name, 'calculate');
  assert.equal(body.tool_trace[0].ok, true);
  assert.equal(body.tool_rounds, 2);
  assert.equal(globalThis.__stubInferenceCalls, 2);
});

test('chat non-stream mengembalikan tool_calls untuk tool milik client', async () => {
  resetStub(['<tool_call>{"name":"kirim_email","arguments":{"to":"a@b.c"}}</tool_call>']);

  const res = await call({
    method: 'POST',
    url: '/api/llm?__route=v1/chat/completions',
    body: { messages: [{ role: 'user', content: 'Kirim email' }], tools: [CLIENT_TOOL] },
  });

  assert.equal(res.statusCode, 200);
  const body = res.json;
  assert.equal(body.choices[0].finish_reason, 'tool_calls');
  const call0 = body.choices[0].message.tool_calls[0];
  assert.equal(call0.type, 'function');
  assert.equal(call0.function.name, 'kirim_email');
  assert.deepEqual(JSON.parse(call0.function.arguments), { to: 'a@b.c' });
  assert.match(call0.id, /^call_/);
});

test('chat streaming dengan tools mengirim status tool lalu jawaban final', async () => {
  resetStub([
    'Saya hitung ya.\n<tool_call>{"name":"calculate","arguments":{"expression":"8*8"}}</tool_call>',
    'Hasilnya 64.',
  ]);

  const res = await call({
    method: 'POST',
    url: '/api/llm?__route=v1/chat/completions',
    body: { messages: [{ role: 'user', content: '8*8?' }], tools: [CALC_TOOL], stream: true },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');

  const text = res.text;
  assert.ok(text.includes(': status'), 'ada event status');
  assert.match(text, /"phase":"tool_call"/);
  assert.match(text, /"phase":"tool_result"/);
  assert.match(text, /"phase":"round"/);
  assert.ok(text.trimEnd().endsWith('data: [DONE]'));
  assert.ok(!text.includes('<tool_call>'), 'JSON tool_call tidak boleh bocor ke stream');

  const events = parseSse(text);
  const contentDeltas = events
    .flatMap((event) => event.choices?.[0]?.delta?.content ?? [])
    .join('');
  assert.ok(contentDeltas.includes('Saya hitung ya.'));
  assert.ok(contentDeltas.includes('Hasilnya 64.'));

  const finalEvent = events[events.length - 1];
  assert.equal(finalEvent.choices[0].finish_reason, 'stop');
  assert.equal(finalEvent.usage.total_tokens, 24, 'usage diakumulasi 2 putaran');
  assert.equal(finalEvent.tool_trace[0].name, 'calculate');
});

test('chat streaming mengirim delta tool_calls untuk tool client', async () => {
  resetStub(['<tool_call>{"name":"kirim_email","arguments":{"to":"x@y.z"}}</tool_call>']);

  const res = await call({
    method: 'POST',
    url: '/api/llm?__route=v1/chat/completions',
    body: { messages: [{ role: 'user', content: 'kirim' }], tools: [CLIENT_TOOL], stream: true },
  });

  const events = parseSse(res.text);
  const toolDeltas = events.flatMap((event) => event.choices?.[0]?.delta?.tool_calls ?? []);
  assert.equal(toolDeltas.length, 2, 'chunk nama + chunk argumen');
  assert.equal(toolDeltas[0].function.name, 'kirim_email');
  assert.deepEqual(JSON.parse(toolDeltas[1].function.arguments), { to: 'x@y.z' });

  const finalEvent = events[events.length - 1];
  assert.equal(finalEvent.choices[0].finish_reason, 'tool_calls');
});

test('tool_choice none menonaktifkan tool pada request', async () => {
  resetStub(['Jawaban langsung.']);

  const res = await call({
    method: 'POST',
    url: '/api/llm?__route=v1/chat/completions',
    body: {
      messages: [{ role: 'user', content: 'Halo' }],
      tools: [CALC_TOOL],
      tool_choice: 'none',
    },
  });

  assert.equal(res.json.choices[0].message.content, 'Jawaban langsung.');
  assert.equal(globalThis.__stubInferenceCalls, 1);
  assert.equal(globalThis.__stubInferenceArgs[0].extraSystemPrompt, '');
});

test('error 404 menyertakan daftar endpoint termasuk tools', async () => {
  resetStub();
  const res = await call({ method: 'GET', url: '/api/llm?__route=tidak/ada' });
  assert.equal(res.statusCode, 404);
  assert.ok(res.json.error.available_endpoints.includes('GET /api/tools'));
  assert.ok(res.json.error.available_endpoints.includes('POST /api/tools'));
});

test('GET /api/health memakai engine (stub) tanpa error', async () => {
  resetStub();
  const res = await call({ method: 'GET', url: '/api/llm?__route=api/health' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.status, 'warm');
});

/* ------------------------- UTCP endpoints ------------------------- */

const UTCP_MANUAL_URL_ENV = JSON.stringify([
  { name: 'weather_api', call_template_type: 'http', url: 'https://utcp.example.com/manual' },
]);

function withEnv(vars, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

function stubUtcpFetch() {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });

    if (String(url).includes('api.example.com/weather/')) {
      const payload = JSON.stringify({ city: 'Bandung', temp_c: 27, condition: 'berawan' });
      return {
        ok: true,
        status: 200,
        headers: { get: (key) => (String(key).toLowerCase() === 'content-type' ? 'application/json' : null) },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(payload));
            controller.close();
          },
        }),
      };
    }

    const payload = JSON.stringify({
      utcp_version: '1.0.0',
      manual_version: '1.0.0',
      tools: [
        {
          name: 'get_weather',
          description: 'Cuaca terkini',
          inputs: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
          outputs: {},
          tags: ['weather'],
          tool_call_template: {
            call_template_type: 'http',
            http_method: 'GET',
            url: 'https://api.example.com/weather/{city}',
          },
        },
      ],
    });
    return {
      ok: true,
      status: 200,
      headers: { get: (key) => (String(key).toLowerCase() === 'content-type' ? 'application/json' : null) },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(payload));
          controller.close();
        },
      }),
    };
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

test('GET /.well-known/utcp menyajikan manual UTCP server ini', async () => {
  resetStub();
  const res = await call({ method: 'GET', url: '/api/llm?__route=.well-known/utcp' });

  assert.equal(res.statusCode, 200);
  const manual = res.json;
  assert.equal(manual.utcp_version, '1.0.0');
  assert.ok(Array.isArray(manual.tools) && manual.tools.length >= 5);

  // Tool yang butuh allowlist (http_fetch) tidak diiklankan bila allowlist belum diset
  assert.ok(!manual.tools.some((tool) => tool.name === 'http_fetch'));

  const calculate = manual.tools.find((tool) => tool.name === 'calculate');
  assert.ok(calculate, 'tool calculate harus ada di manual');
  assert.equal(calculate.tool_call_template.call_template_type, 'http');
  assert.match(calculate.tool_call_template.url, /\/api\/tools\?tool=calculate$/);
  assert.equal(manual.tools[0].tool_call_template.http_method, 'POST');
});

test('GET /api/utcp merangkum manual terdaftar', async () => {
  resetStub();
  await withEnv({ LLM_UTCP_MANUALS: UTCP_MANUAL_URL_ENV, LLM_TOOL_HTTP_ALLOW_HOSTS: 'utcp.example.com,api.example.com' }, async () => {
    const stub = stubUtcpFetch();
    try {
      const res = await call({ method: 'GET', url: '/api/llm?__route=api/utcp' });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json.ok, true);
      assert.equal(res.json.configured, true);
      assert.equal(res.json.manuals.count, 1);
      assert.equal(res.json.manuals.tools, 1);
      assert.match(res.json.manuals.data[0].tool_names[0], /^weather_api\.get_weather$/);
      assert.ok(res.json.own_tools >= 6);
    } finally {
      stub.restore();
    }
  });
});

test('POST /api/utcp/discover mengembalikan tools dari URL manual', async () => {
  resetStub();
  await withEnv({ LLM_TOOL_HTTP_ALLOW_HOSTS: 'utcp.example.com' }, async () => {
    const stub = stubUtcpFetch();
    try {
      const res = await call({
        method: 'POST',
        url: '/api/llm?__route=api/utcp/discover',
        body: { url: 'https://utcp.example.com/manual', name: 'demo' },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json.ok, true);
      assert.equal(res.json.manual.name, 'demo');
      assert.equal(res.json.manual.tools[0].name, 'get_weather');
      assert.equal(res.json.manual.tools[0].supported, true);
    } finally {
      stub.restore();
    }
  });
});

test('POST /api/utcp/call mengeksekusi tool UTCP terdaftar', async () => {
  resetStub();
  await withEnv(
    {
      LLM_UTCP_MANUALS: UTCP_MANUAL_URL_ENV,
      LLM_TOOL_HTTP_ALLOW_HOSTS: 'utcp.example.com,api.example.com',
    },
    async () => {
      const stub = stubUtcpFetch();
      try {
        const res = await call({
          method: 'POST',
          url: '/api/llm?__route=api/utcp/call',
          body: { tool: 'weather_api.get_weather', arguments: { city: 'Bandung' } },
        });
        assert.equal(res.statusCode, 200);
        assert.equal(res.json.ok, true);
        assert.equal(res.json.protocol, 'http');
        assert.deepEqual(res.json.result.data, { city: 'Bandung', temp_c: 27, condition: 'berawan' });
        assert.ok(
          stub.calls.some((item) => item.url.includes('api.example.com/weather/Bandung')),
          'path parameter {city} harus tersubstitusi'
        );

        const unknown = await call({
          method: 'POST',
          url: '/api/llm?__route=api/utcp/call',
          body: { tool: 'tidak.ada', arguments: {} },
        });
        assert.equal(unknown.statusCode, 404);
      } finally {
        stub.restore();
      }
    }
  );
});

test('GET /api/tools menyertakan tool UTCP dan POST /api/tools?tool= bisa memanggilnya', async () => {
  resetStub();
  await withEnv(
    {
      LLM_UTCP_MANUALS: UTCP_MANUAL_URL_ENV,
      LLM_TOOL_HTTP_ALLOW_HOSTS: 'utcp.example.com,api.example.com',
    },
    async () => {
      const stub = stubUtcpFetch();
      try {
        const listed = await call({ method: 'GET', url: '/api/llm?__route=api/tools' });
        const names = listed.json.data.map((tool) => tool.function.name);
        assert.ok(names.includes('weather_api.get_weather'), 'tool UTCP harus muncul di /api/tools');
        const utcpTool = listed.json.data.find((tool) => tool.function.name === 'weather_api.get_weather');
        assert.equal(utcpTool.source, 'utcp');
        assert.equal(utcpTool.utcp.manual, 'weather_api');
        assert.equal(listed.json.config.utcp_configured, true);

        // Panggilan gaya manual UTCP: nama tool di query, argumen di query
        const called = await call({
          method: 'POST',
          url: '/api/llm?__route=api/tools&tool=weather_api.get_weather&city=Bandung',
        });
        assert.equal(called.statusCode, 200);
        assert.equal(called.json.ok, true);
        assert.equal(called.json.protocol, 'utcp');

        // Panggilan native lewat body juga tetap jalan
        const native = await call({
          method: 'POST',
          url: '/api/llm?__route=api/tools',
          body: { name: 'calculate', arguments: { expression: '3*3' } },
        });
        assert.equal(native.json.result.result, 9);
      } finally {
        stub.restore();
      }
    }
  );
});
