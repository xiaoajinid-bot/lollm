import assert from 'node:assert/strict';
import test from 'node:test';

import {
  UTCP_PROTOCOL_VERSION,
  applyPathParams,
  buildOwnManual,
  buildRegistryEntries,
  callUtcpTool,
  convertOpenApiToManual,
  describeManuals,
  discoverManual,
  loadConfiguredManuals,
  mcpCallTool,
  mcpListTools,
  namespaceFor,
  normalizeManual,
  parseManualTemplates,
  qualifyToolName,
  substituteVariables,
} from '../lib/utcp.mjs';
import { executeToolCall, getToolRegistry, listTools } from '../lib/tools.mjs';

const SAMPLE_MANUAL = {
  utcp_version: '1.0.0',
  manual_version: '1.0.0',
  tools: [
    {
      name: 'get_weather',
      description: 'Cuaca terkini',
      inputs: {
        type: 'object',
        properties: { city: { type: 'string' }, units: { type: 'string', enum: ['c', 'f'], default: 'c' } },
        required: ['city'],
      },
      outputs: { type: 'object' },
      tags: ['weather'],
      tool_call_template: {
        call_template_type: 'http',
        http_method: 'GET',
        url: 'https://api.example.com/weather/{city}',
      },
    },
    {
      name: 'list_cli',
      description: 'Tool CLI (tidak didukung serverless)',
      inputs: { type: 'object', properties: {} },
      tool_call_template: { call_template_type: 'cli', commands: [{ command: 'ls' }] },
    },
  ],
};

function responseLike(json, { status = 200, contentType = 'application/json', headers = {} } = {}) {
  const text = typeof json === 'string' ? json : JSON.stringify(json);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (key) => {
        const normalized = String(key).toLowerCase();
        if (normalized === 'content-type') return contentType;
        return headers[normalized] ?? null;
      },
    },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
  };
}

async function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('normalizeManual memvalidasi tool dan menandai protokol tak didukung', () => {
  const manual = normalizeManual(SAMPLE_MANUAL, { manualName: 'weather_api' });
  assert.equal(manual.utcp_version, '1.0.0');
  assert.equal(manual.tools.length, 2);
  assert.equal(manual.tools[0].supported, true);
  assert.equal(manual.tools[0].call_type, 'http');
  assert.equal(manual.tools[1].supported, false);
  assert.match(manual.tools[1].unsupported_reason, /cli/i);
  assert.deepEqual(manual.errors, []);

  assert.throws(
    () => normalizeManual({ tools: [{ tool_call_template: { call_template_type: 'http' } }] }, { strict: true }),
    /tidak valid/
  );
  assert.throws(() => normalizeManual({}), /array "tools"/);
  assert.throws(() => normalizeManual({ tools: [{ name: 'x' }] }, { strict: true }), /tool_call_template/);

  // Mode default mengumpulkan error tanpa menggagalkan seluruh manual
  const lenient = normalizeManual({ tools: [{ name: 'ok', tool_call_template: { call_template_type: 'http', url: 'https://a.com' } }, { bad: true }] });
  assert.equal(lenient.tools.length, 1);
  assert.equal(lenient.errors.length, 1);
});

test('qualifyToolName & namespace mengikuti konvensi UTCP', () => {
  assert.equal(qualifyToolName('weather_api', 'get_weather'), 'weather_api.get_weather');
  assert.equal(qualifyToolName('weather_api', 'other.tool'), 'other.tool');
  assert.equal(namespaceFor('github_api'), 'github__api_');
  assert.equal(namespaceFor('my-service'), 'my__service_');
});

test('substituteVariables mendukung namespace manual, env, dan ${env:...}', () => {
  const env = { github__api_TOKEN: 'ns-token', FALLBACK: 'plain', OTHER: 'x' };
  assert.equal(substituteVariables('Bearer ${TOKEN}', { env, manualName: 'github_api' }), 'Bearer ns-token');
  assert.equal(substituteVariables('${FALLBACK}', { env, manualName: 'github_api' }), 'plain');
  assert.equal(substituteVariables('${env:OTHER}', { env, manualName: 'github_api' }), 'x');
  assert.equal(substituteVariables('${MISSING}', { env, manualName: 'github_api' }), '${MISSING}');
  assert.deepEqual(
    substituteVariables({ a: ['${FALLBACK}'], b: { c: '${env:OTHER}' } }, { env, manualName: 'x' }),
    { a: ['plain'], b: { c: 'x' } }
  );
});

test('applyPathParams mengganti placeholder dan menyisakan argumen lain', () => {
  const result = applyPathParams('https://api.example.com/users/{user_id}/posts/${post_id}', {
    user_id: 'a b',
    post_id: 7,
    limit: 10,
  });
  assert.equal(result.url, 'https://api.example.com/users/a%20b/posts/7');
  assert.deepEqual(result.remaining, { limit: 10 });
});

test('callUtcpTool (http) memetakan path, query, header_fields, body_field, dan auth', async () => {
  const calls = [];
  const tool = {
    name: 'demo.create',
    manual_name: 'demo',
    tool_call_template: {
      call_template_type: 'http',
      http_method: 'POST',
      url: 'https://api.example.com/items/{item_id}',
      body_field: 'payload',
      content_type: 'application/json',
      header_fields: ['X-Trace'],
      headers: { 'X-Static': 'yes' },
      auth: { auth_type: 'api_key', var_name: 'X-Api-Key', api_key_value: '${API_KEY}', in: 'header' },
    },
  };

  const result = await withFetch(
    async (url, options) => {
      calls.push({ url: String(url), options });
      return responseLike({ created: true });
    },
    () =>
      callUtcpTool(
        tool,
        { item_id: 42, payload: { name: 'budi' }, 'X-Trace': 'trace-1', extra: 'q' },
        { env: { LLM_TOOL_HTTP_ALLOW_HOSTS: 'api.example.com', API_KEY: 'secret' } }
      )
  );

  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { created: true });

  const [{ url, options }] = calls;
  assert.match(url, /api\.example\.com\/items\/42/);
  assert.match(url, /extra=q/);
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['X-Trace'], 'trace-1');
  assert.equal(options.headers['X-Static'], 'yes');
  assert.equal(options.headers['X-Api-Key'], 'secret');
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(options.body), { name: 'budi' });
});

test('callUtcpTool (http) mengirim argumen sebagai body untuk POST tanpa body_field', async () => {
  let capturedBody = null;
  const tool = {
    name: 'demo.post',
    tool_call_template: {
      call_template_type: 'http',
      http_method: 'POST',
      url: 'https://api.example.com/echo',
    },
  };

  await withFetch(
    async (url, options) => {
      capturedBody = options.body;
      return responseLike({ ok: true });
    },
    () => callUtcpTool(tool, { a: 1, b: 'dua' }, { env: { LLM_TOOL_HTTP_ALLOW_HOSTS: 'api.example.com' } })
  );

  assert.deepEqual(JSON.parse(capturedBody), { a: 1, b: 'dua' });
});

test('callUtcpTool memblokir host privat tanpa allowlist', async () => {
  const tool = {
    name: 'demo.private',
    tool_call_template: { call_template_type: 'http', http_method: 'GET', url: 'http://169.254.169.254/latest' },
  };
  await assert.rejects(() => callUtcpTool(tool, {}, { env: {} }), /privat|allowlist|diblokir/);
});

test('callUtcpTool menolak protokol yang tidak didukung dengan pesan jelas', async () => {
  await assert.rejects(
    () =>
      callUtcpTool(
        { name: 'x.y', tool_call_template: { call_template_type: 'cli', commands: [] } },
        {},
        { env: {} }
      ),
    /cli/i
  );
});

test('http auth basic & oauth2 client_credentials', async () => {
  const requests = [];
  const basicTool = {
    name: 'demo.basic',
    tool_call_template: {
      call_template_type: 'http',
      http_method: 'GET',
      url: 'https://api.example.com/secure',
      auth: { auth_type: 'basic', username: 'user', password: 'pass' },
    },
  };

  await withFetch(
    async (url, options) => {
      requests.push({ url: String(url), options });
      return responseLike({ ok: true });
    },
    () => callUtcpTool(basicTool, {}, { env: { LLM_TOOL_HTTP_ALLOW_HOSTS: 'api.example.com' } })
  );
  assert.equal(requests[0].options.headers.Authorization, `Basic ${Buffer.from('user:pass').toString('base64')}`);

  const oauthTool = {
    name: 'demo.oauth',
    manual_name: 'demo_oauth',
    tool_call_template: {
      call_template_type: 'http',
      http_method: 'GET',
      url: 'https://api.example.com/protected',
      auth: {
        auth_type: 'oauth2',
        token_url: 'https://auth.example.com/token',
        client_id: 'cid',
        client_secret: '${CLIENT_SECRET}',
      },
    },
  };

  const seen = [];
  await withFetch(
    async (url, options) => {
      seen.push({ url: String(url), options });
      if (String(url).includes('/token')) return responseLike({ access_token: 'tok-123', expires_in: 3600 });
      return responseLike({ ok: true });
    },
    () =>
      callUtcpTool(oauthTool, {}, {
        env: { LLM_TOOL_HTTP_ALLOW_HOSTS: 'api.example.com,auth.example.com', CLIENT_SECRET: 's3cr3t' },
      })
  );

  const tokenRequest = seen.find((item) => item.url.includes('/token'));
  assert.ok(tokenRequest, 'harus meminta token OAuth');
  assert.match(String(tokenRequest.options.body), /client_id=cid/);
  assert.match(String(tokenRequest.options.body), /client_secret=s3cr3t/);
  const apiRequest = seen.find((item) => item.url.includes('/protected'));
  assert.equal(apiRequest.options.headers.Authorization, 'Bearer tok-123');
});

test('convertOpenApiToManual membuat tool dari paths', () => {
  const spec = {
    openapi: '3.0.0',
    servers: [{ url: 'https://api.example.com/v1' }],
    paths: {
      '/users/{userId}': {
        get: {
          operationId: 'getUser',
          summary: 'Ambil user',
          parameters: [
            { name: 'userId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'verbose', in: 'query', schema: { type: 'boolean' } },
            { name: 'X-Tenant', in: 'header', schema: { type: 'string' } },
          ],
        },
      },
      '/users': {
        post: {
          operationId: 'createUser',
          requestBody: {
            content: {
              'application/json': {
                schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
              },
            },
          },
        },
      },
    },
  };

  const manual = convertOpenApiToManual(spec, { manualName: 'users_api' });
  assert.equal(manual.tools.length, 2);

  const getUser = manual.tools.find((tool) => tool.name === 'getUser');
  assert.equal(getUser.inputs.properties.userId.type, 'string');
  assert.deepEqual(getUser.inputs.required, ['userId']);
  assert.deepEqual(getUser.tool_call_template.header_fields, ['X-Tenant']);
  assert.equal(getUser.tool_call_template.url, 'https://api.example.com/v1/users/{userId}');

  const createUser = manual.tools.find((tool) => tool.name === 'createUser');
  assert.deepEqual(createUser.inputs.required, ['name']);
  assert.equal(createUser.tool_call_template.http_method, 'POST');
});

test('discoverManual (http) mendeteksi UTCP manual dan OpenAPI', async () => {
  const utcp = await withFetch(
    async () => responseLike(SAMPLE_MANUAL),
    () => discoverManual({ call_template_type: 'http', url: 'https://api.example.com/utcp' }, {
      env: { LLM_TOOL_HTTP_ALLOW_HOSTS: 'api.example.com' },
    })
  );
  assert.equal(utcp.tools.length, 2);
  assert.equal(utcp.tools[0].name, 'get_weather');

  const openapi = await withFetch(
    async () =>
      responseLike({
        openapi: '3.0.0',
        servers: [{ url: 'https://api.example.com' }],
        paths: { '/ping': { get: { operationId: 'ping', summary: 'Ping' } } },
      }),
    () => discoverManual({ call_template_type: 'http', url: 'https://api.example.com/openapi.json' }, {
      env: { LLM_TOOL_HTTP_ALLOW_HOSTS: 'api.example.com' },
    })
  );
  assert.equal(openapi.tools[0].name, 'ping');

  await assert.rejects(
    () =>
      withFetch(
        async () => responseLike({ hello: 'world' }),
        () => discoverManual({ call_template_type: 'http', url: 'https://api.example.com/x' }, {
          env: { LLM_TOOL_HTTP_ALLOW_HOSTS: 'api.example.com' },
        })
      ),
    /bukan UTCP manual/
  );
});

test('discoverManual (text) dan validasi error konfigurasi', async () => {
  const manual = await discoverManual({
    call_template_type: 'text',
    content: JSON.stringify(SAMPLE_MANUAL),
  });
  assert.equal(manual.tools.length, 2);

  await assert.rejects(
    () => discoverManual({ call_template_type: 'text', content: 'bukan json' }),
    /JSON valid/
  );
  assert.throws(() => parseManualTemplates('{rusak'), /JSON valid/);
  assert.deepEqual(parseManualTemplates('[]'), []);
});

test('discoverManual menolak template file tanpa izin', async () => {
  await assert.rejects(
    () => discoverManual({ call_template_type: 'file', file_path: '/tmp/x.json' }, { env: {} }),
    /dinonaktifkan/
  );
});

test('MCP client: tools/list dan tools/call via streamable HTTP', async () => {
  const rpcCalls = [];
  const mcpServer = {
    transport: 'http',
    url: 'https://mcp.example.com/mcp',
    timeout: 10,
  };

  const handler = async (url, options) => {
    const payload = JSON.parse(options.body);
    rpcCalls.push(payload.method);

    if (payload.method === 'initialize') {
      return responseLike(
        { jsonrpc: '2.0', id: payload.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'mock' } } },
        { headers: { 'mcp-session-id': 'sess-1' } }
      );
    }
    if (payload.method === 'notifications/initialized') {
      return responseLike('', { status: 202 });
    }
    if (payload.method === 'tools/list') {
      // Balasan dalam format SSE (didukung MCP streamable HTTP)
      const body = `event: message\ndata: ${JSON.stringify({
        jsonrpc: '2.0',
        id: payload.id,
        result: {
          tools: [
            {
              name: 'echo',
              description: 'Mengembalikan teks',
              inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
            },
          ],
        },
      })}\n\n`;
      return responseLike(body, { contentType: 'text/event-stream' });
    }
    if (payload.method === 'tools/call') {
      return responseLike({
        jsonrpc: '2.0',
        id: payload.id,
        result: { content: [{ type: 'text', text: `echo: ${payload.params.arguments.text}` }] },
      });
    }
    return responseLike({ jsonrpc: '2.0', id: payload.id, error: { code: -32601, message: 'unknown' } });
  };

  const template = {
    name: 'mcp_demo',
    call_template_type: 'mcp',
    config: { mcpServers: { mock: mcpServer } },
  };

  const tools = await withFetch(handler, () =>
    mcpListTools(template, { env: { LLM_TOOL_HTTP_ALLOW_HOSTS: 'mcp.example.com' }, manualName: 'mcp_demo' })
  );
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'echo');
  assert.equal(tools[0].tool_call_template.call_template_type, 'mcp');
  assert.equal(tools[0].tool_call_template.server_name, 'mock');

  const result = await withFetch(handler, () =>
    mcpCallTool(template, 'echo', { text: 'halo' }, {
      env: { LLM_TOOL_HTTP_ALLOW_HOSTS: 'mcp.example.com' },
      manualName: 'mcp_demo',
    })
  );
  assert.equal(result.isError, false);
  assert.equal(result.content, 'echo: halo');
  assert.deepEqual(rpcCalls.slice(0, 3), ['initialize', 'notifications/initialized', 'tools/list']);
});

test('MCP memblokir transport stdio di serverless', async () => {
  await assert.rejects(
    () =>
      mcpListTools(
        { call_template_type: 'mcp', config: { mcpServers: { local: { transport: 'stdio', command: 'node' } } } },
        { env: {} }
      ),
    /stdio/i
  );
});

test('registry mengintegrasikan tool UTCP & bisa dieksekusi', async () => {
  const manual = normalizeManual(SAMPLE_MANUAL, { manualName: 'weather_api' });
  const entries = buildRegistryEntries([manual], { env: { LLM_TOOL_HTTP_ALLOW_HOSTS: 'api.example.com' } });

  assert.equal(entries.length, 1, 'tool cli tidak ikut masuk registry');
  assert.equal(entries[0].name, 'weather_api.get_weather');
  assert.equal(entries[0].source, 'utcp');

  const listed = listTools({ names: ['weather_api.get_weather'], utcpTools: entries, env: {} });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].utcp.manual, 'weather_api');
  assert.equal(listed[0].utcp.call_template_type, 'http');

  const registry = getToolRegistry({ env: {}, utcpTools: entries });
  assert.ok(registry.has('weather_api.get_weather'));

  const result = await withFetch(
    async () => responseLike({ city: 'Bandung', temp_c: 27 }),
    () =>
      executeToolCall({
        name: 'weather_api.get_weather',
        args: { city: 'Bandung' },
        env: { LLM_TOOL_HTTP_ALLOW_HOSTS: 'api.example.com' },
        ctx: { utcpTools: entries },
      })
  );

  assert.equal(result.ok, true);
  assert.equal(result.source, 'utcp');
  assert.deepEqual(result.result.data, { city: 'Bandung', temp_c: 27 });
});

test('tool UTCP menghormati LLM_TOOLS_DISABLED', () => {
  const manual = normalizeManual(SAMPLE_MANUAL, { manualName: 'weather_api' });
  const entries = buildRegistryEntries([manual], { env: {} });
  const registry = getToolRegistry({ env: { LLM_TOOLS_DISABLED: 'weather_api.get_weather' }, utcpTools: entries });
  assert.ok(!registry.has('weather_api.get_weather'));
});

test('buildOwnManual menghasilkan manual yang bisa dipanggil lewat /api/tools', () => {
  const manual = buildOwnManual({
    origin: 'https://lollm-psi.vercel.app',
    tools: [
      {
        name: 'calculate',
        description: 'Hitung',
        parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] },
        source: 'builtin',
      },
    ],
  });

  assert.equal(manual.utcp_version, UTCP_PROTOCOL_VERSION);
  assert.equal(manual.tools.length, 1);
  const tool = manual.tools[0];
  assert.equal(tool.name, 'calculate');
  assert.ok(tool.tags.includes('builtin'));
  assert.equal(tool.tool_call_template.http_method, 'POST');
  assert.equal(tool.tool_call_template.url, 'https://lollm-psi.vercel.app/api/tools?tool=calculate');
  assert.deepEqual(tool.inputs.required, ['expression']);
});

test('describeManuals merangkum manual & error', () => {
  const manual = normalizeManual(SAMPLE_MANUAL, { manualName: 'weather_api' });
  const summary = describeManuals([manual], { errors: [{ manual: 'x', message: 'gagal' }] });
  assert.equal(summary.count, 1);
  assert.equal(summary.tools, 2);
  assert.equal(summary.data[0].supported_tools, 1);
  assert.deepEqual(summary.data[0].protocols.sort(), ['cli', 'http']);
  assert.equal(summary.errors[0].manual, 'x');
});

test('loadConfiguredManuals meng-cache hasil discovery', async () => {
  let fetchCount = 0;
  const env = {
    LLM_UTCP_MANUALS: JSON.stringify([{ name: 'cached_api', call_template_type: 'http', url: 'https://api.example.com/utcp' }]),
    LLM_TOOL_HTTP_ALLOW_HOSTS: 'api.example.com',
  };

  await withFetch(
    async () => {
      fetchCount += 1;
      return responseLike(SAMPLE_MANUAL);
    },
    async () => {
      const first = await loadConfiguredManuals({ env, force: true });
      assert.equal(first.manuals.length, 1);
      const second = await loadConfiguredManuals({ env });
      assert.equal(second.manuals.length, 1);
    }
  );

  assert.equal(fetchCount, 1, 'discovery kedua memakai cache');

  const empty = await loadConfiguredManuals({ env: {} });
  assert.equal(empty.configured, false);

  const broken = await loadConfiguredManuals({ env: { LLM_UTCP_MANUALS: '{rusak' } });
  assert.equal(broken.manuals.length, 0);
  assert.match(broken.errors[0].message, /JSON valid/);
});
