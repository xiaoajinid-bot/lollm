import crypto from 'node:crypto';
import {
  DEFAULT_MODEL_ID,
  MODEL_CATALOG,
  ensureModelLoaded,
  getSystemHealth,
  resolveModelSpec,
  runChatInference,
} from '../lib/llm-engine.mjs';
import { executeToolCall, getToolRegistry, listTools } from '../lib/tools.mjs';
import { DEFAULT_MAX_OUTPUT_TOKENS } from '../lib/model-limits.mjs';
import {
  describeModelStorage,
  modelSourcePlan,
  probeModelSource,
} from '../lib/model-storage.mjs';
import {
  deleteStoredModel,
  saveModelToStorage,
  storeOverview,
} from '../lib/model-store.mjs';
import { runToolAgent } from '../lib/agent.mjs';
import {
  UTCP_MANUAL_VERSION,
  UTCP_PROTOCOL_VERSION,
  buildOwnManual,
  buildRegistryEntries,
  callUtcpTool,
  describeManuals,
  discoverManual,
  loadConfiguredManuals,
} from '../lib/utcp.mjs';

// Safe dynamic import hint for Vercel NFT bundler on Linux x64
import('@node-llama-cpp/linux-x64').catch(() => {});

const AVAILABLE_ENDPOINTS = [
  'GET /api/health',
  'POST /api/warmup',
  'GET /v1/models',
  'GET /api/storage',
  'GET /api/storage/check',
  'GET /api/store',
  'POST /api/store/save',
  'POST /api/store/delete',
  'POST /v1/chat/completions',
  'GET /api/tools',
  'POST /api/tools',
  'GET /.well-known/utcp',
  'GET /api/utcp',
  'POST /api/utcp/discover',
  'POST /api/utcp/call',
  'GET /api/tags',
  'POST /api/generate',
];

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Requested-With'
  );
}

function sendJson(res, statusCode, payload) {
  setCorsHeaders(res);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload, null, 2));
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body;
  }
  if (typeof req.body === 'string') {
    return req.body.trim() ? JSON.parse(req.body) : {};
  }
  if (Buffer.isBuffer(req.body)) {
    const str = req.body.toString('utf8').trim();
    return str ? JSON.parse(str) : {};
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function resolveRoute(req) {
  const url = new URL(req.url || '/', 'http://localhost');
  const rewritten = url.searchParams.get('__route');
  if (rewritten) {
    return `/${rewritten.replace(/^\/+/, '')}`;
  }
  return url.pathname.replace(/\/+$/, '') || '/';
}

/** Membaca konfigurasi tool calling dari body request (OpenAI & legacy). */
function readToolConfig(body) {
  const tools = Array.isArray(body.tools) ? body.tools : undefined;
  const functions = Array.isArray(body.functions) ? body.functions : undefined;
  const toolChoice = body.tool_choice ?? body.function_call ?? 'auto';
  const maxRoundsRaw = body.max_tool_rounds ?? body.maxToolRounds ?? body.tool_rounds;
  const maxRounds = Number(maxRoundsRaw) > 0 ? Number(maxRoundsRaw) : undefined;
  return { tools, functions, toolChoice, maxRounds };
}

function toolContext(utcpTools = []) {
  return { health: getSystemHealth, utcpTools };
}

function requestOrigin(req) {
  const host = req.headers?.['x-forwarded-host'] || req.headers?.host || 'localhost';
  const proto = req.headers?.['x-forwarded-proto'] || (String(host).startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

/** Discovery manual UTCP terdaftar (env LLM_UTCP_MANUALS), di-cache di memori. */
async function resolveUtcp(req) {
  try {
    const result = await loadConfiguredManuals({ env: process.env });
    return {
      configured: result.configured,
      manuals: result.manuals,
      errors: result.errors,
      entries: buildRegistryEntries(result.manuals, { env: process.env }),
    };
  } catch (err) {
    return { configured: false, manuals: [], errors: [{ manual: 'config', message: err.message }], entries: [] };
  }
}

function toOpenAIToolCall(call) {
  return {
    id: call.id,
    type: 'function',
    function: {
      name: call.name,
      arguments: JSON.stringify(call.arguments ?? {}),
    },
  };
}

export default async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const route = resolveRoute(req);

  try {
    // 1. Health & Telemetry
    if (req.method === 'GET' && (route === '/api/health' || route === '/api/llm')) {
      const health = await getSystemHealth();
      sendJson(res, 200, health);
      return;
    }

    // 1b. Penyimpanan model (S3 / Vercel Blob / base URL)
    if (req.method === 'GET' && route === '/api/storage') {
      sendJson(res, 200, {
        ok: true,
        storage: describeModelStorage(process.env, MODEL_CATALOG),
        hint: 'Set env LLM_S3_* atau LLM_BLOB_BASE_URL, lalu cek dengan GET /api/storage/check.',
      });
      return;
    }

    // 1c. Verifikasi objek model benar-benar ada di sumber yang dikonfigurasi
    if ((req.method === 'GET' || req.method === 'POST') && route === '/api/storage/check') {
      const storage = describeModelStorage(process.env, MODEL_CATALOG);
      const results = await Promise.all(
        MODEL_CATALOG.map(async (spec) => {
          const plan = modelSourcePlan(spec, process.env);
          if (!plan.length) {
            return {
              id: spec.id,
              expected_size_mb: spec.sizeMb,
              ok: false,
              error: 'tidak ada sumber aktif untuk model ini',
            };
          }
          const probe = await probeModelSource({ source: plan[0] });
          return { id: spec.id, expected_size_mb: spec.sizeMb, checked_source: plan[0].source, ...probe };
        })
      );

      const ok = results.every((item) => item.ok);
      sendJson(res, ok ? 200 : 502, {
        ok,
        checked_at: new Date().toISOString(),
        storage,
        results,
      });
      return;
    }

    // 1d. Model Store: katalog + isi bucket + kemampuan storage
    if (req.method === 'GET' && route === '/api/store') {
      const overview = await storeOverview({ env: process.env, catalog: MODEL_CATALOG });
      sendJson(res, 200, overview);
      return;
    }

    // 1e. Simpan model katalog ke storage (stream sumber -> bucket)
    if (req.method === 'POST' && route === '/api/store/save') {
      const body = await readJsonBody(req);
      const spec = resolveModelSpec(String(body.model || body.id || ''));
      if (!spec) {
        sendJson(res, 404, {
          ok: false,
          error: {
            message: `Model "${body.model}" tidak dikenal.`,
            available: MODEL_CATALOG.map((item) => item.id),
          },
        });
        return;
      }

      const result = await saveModelToStorage({
        spec,
        env: process.env,
        force: Boolean(body.force),
      });
      sendJson(res, 200, { ok: true, model: spec.id, ...result });
      return;
    }

    // 1f. Hapus objek model dari storage
    if (req.method === 'POST' && route === '/api/store/delete') {
      const body = await readJsonBody(req);
      const result = await deleteStoredModel({ key: body.key, env: process.env });
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    // 2. OpenAI-Compatible Models List
    if (req.method === 'GET' && (route === '/v1/models' || route === '/api/models')) {
      const health = await getSystemHealth();
      const cacheMap = new Map(health.cached_models.map((m) => [m.id, m]));
      const storageMap = new Map((health.model_storage?.models || []).map((m) => [m.id, m]));
      const created = Math.floor(Date.now() / 1000);
      sendJson(res, 200, {
        object: 'list',
        default_model: DEFAULT_MODEL_ID,
        data: MODEL_CATALOG.map((m) => {
          const state = cacheMap.get(m.id);
          return {
            id: m.id,
            object: 'model',
            created,
            owned_by: 'local-vercel-llama-cpp',
            name: m.name,
            family: m.family,
            parameters: m.parameters,
            quantization: m.quantization,
            size_mb: m.sizeMb,
            context_length: m.contextLength,
            badge: m.badge,
            description: m.description,
            loaded_in_ram: Boolean(state?.loaded_in_ram),
            cached_on_tmp: Boolean(state?.cached_on_tmp),
            storage_source: storageMap.get(m.id)?.source || null,
          };
        }),
      });
      return;
    }

    // 3. Ollama-Compatible Model Tags
    if (req.method === 'GET' && route === '/api/tags') {
      const nowIso = new Date().toISOString();
      sendJson(res, 200, {
        models: MODEL_CATALOG.map((m) => ({
          name: m.id,
          model: m.id,
          modified_at: nowIso,
          size: m.sizeMb * 1024 * 1024,
          details: {
            format: 'gguf',
            family: m.family,
            parameter_size: m.parameters,
            quantization_level: m.quantization,
          },
        })),
      });
      return;
    }

    // 4. Tool / Connector Catalog
    if (req.method === 'GET' && (route === '/api/tools' || route === '/v1/tools')) {
      const url = new URL(req.url || '/', 'http://localhost');
      const namesParam = url.searchParams.get('names');
      const names = namesParam
        ? namesParam.split(',').map((n) => n.trim()).filter(Boolean)
        : null;
      const utcp = await resolveUtcp(req);
      const tools = listTools({ names, utcpTools: utcp.entries });
      const connectorError = getToolRegistry().connectorError || null;

      sendJson(res, 200, {
        object: 'list',
        data: tools.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
          source: tool.source,
          server_side: tool.server_side,
          available: tool.available,
          requires_allowlist: tool.requires_allowlist,
          ...(tool.utcp ? { utcp: tool.utcp } : {}),
        })),
        count: tools.length,
        config: {
          http_allowlist_configured: Boolean(process.env.LLM_TOOL_HTTP_ALLOW_HOSTS),
          connectors_configured: (process.env.LLM_CONNECTORS || '').trim().length > 0,
          disabled: (process.env.LLM_TOOLS_DISABLED || '')
            .split(',')
            .map((n) => n.trim())
            .filter(Boolean),
          max_rounds: Number(process.env.LLM_TOOL_MAX_ROUNDS) || 3,
          connectors_error: connectorError,
          utcp_configured: utcp.configured,
          utcp_manuals: describeManuals(utcp.manuals, { errors: utcp.errors }),
        },
      });
      return;
    }

    // 5. Direct Tool Invocation (debug / integrasi non-LLM)
    if (req.method === 'POST' && (route === '/api/tools' || route === '/v1/tools')) {
      if (process.env.LLM_TOOLS_DIRECT_INVOKE === 'disabled') {
        sendJson(res, 403, {
          error: {
            message: 'Pemanggilan tool langsung dinonaktifkan (LLM_TOOLS_DIRECT_INVOKE=disabled).',
            type: 'permission_error',
          },
        });
        return;
      }
      const body = await readJsonBody(req);
      const url = new URL(req.url || '/', 'http://localhost');
      const queryName = url.searchParams.get('tool') || url.searchParams.get('name');

      // Argumen boleh datang dari query string (dipakai manual UTCP)
      const queryArgs = {};
      for (const [key, value] of url.searchParams.entries()) {
        if (key === 'tool' || key === 'name' || key === '__route') continue;
        queryArgs[key] = value;
      }

      const name = String(queryName || body.name || body.tool || '').trim();
      if (!name) {
        sendJson(res, 400, {
          error: {
            message: 'Parameter "name" wajib diisi.',
            type: 'invalid_request_error',
            available: [...getToolRegistry().keys()],
          },
        });
        return;
      }
      const bodyArgs = body.arguments ?? body.args ?? {};
      const extraArgs = Object.fromEntries(
        Object.entries(body).filter(([key]) => !['name', 'tool', 'arguments', 'args'].includes(key))
      );
      const args = { ...queryArgs, ...bodyArgs, ...extraArgs };
      const utcp = await resolveUtcp(req);
      const execution = await executeToolCall({ name, args, ctx: toolContext(utcp.entries) });
      sendJson(res, execution.ok ? 200 : execution.server_side === false ? 404 : 400, {
        ok: execution.ok,
        tool: name,
        source: execution.source,
        arguments: execution.arguments ?? args,
        result: execution.result ?? null,
        error: execution.error ?? null,
        duration_ms: execution.duration_ms,
        protocol: execution.source === 'utcp' ? 'utcp' : 'native',
      });
      return;
    }

    // 5b. UTCP — manual milik server ini (well-known discovery)
    if (
      req.method === 'GET' &&
      (route === '/.well-known/utcp' || route === '/api/utcp/manual' || route === '/utcp/manual')
    ) {
      // Hanya tool yang benar-benar bisa dipanggil dari luar (tidak butuh allowlist kosong)
      const ownTools = listTools({ env: process.env }).filter((tool) => tool.available);
      const manual = buildOwnManual({
        origin: requestOrigin(req),
        tools: ownTools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          source: tool.source,
        })),
      });

      setCorsHeaders(res);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
      res.end(JSON.stringify(manual, null, 2));
      return;
    }

    // 5c. UTCP — status manual terdaftar
    if (req.method === 'GET' && (route === '/api/utcp' || route === '/v1/utcp')) {
      const utcp = await resolveUtcp(req);
      const ownTools = listTools({ env: process.env });

      sendJson(res, 200, {
        ok: true,
        utcp_version: UTCP_PROTOCOL_VERSION,
        manual_version: UTCP_MANUAL_VERSION,
        own_manual_url: `${requestOrigin(req)}/.well-known/utcp`,
        own_tools: ownTools.length,
        configured: utcp.configured,
        manuals: describeManuals(utcp.manuals, { errors: utcp.errors }),
        supported_call_protocols: ['http', 'streamable_http', 'mcp', 'sse'],
        config: {
          env_var: 'LLM_UTCP_MANUALS',
          allow_hosts_configured: Boolean(process.env.LLM_TOOL_HTTP_ALLOW_HOSTS),
          file_protocol_enabled: String(process.env.LLM_UTCP_ALLOW_FILE || '').toLowerCase() === 'true',
        },
      });
      return;
    }

    // 5d. UTCP — discovery manual (ad-hoc)
    if (req.method === 'POST' && route === '/api/utcp/discover') {
      const body = await readJsonBody(req);
      const template = body.manual || body.template || (body.url ? { call_template_type: 'http', url: body.url } : null);
      if (!template) {
        sendJson(res, 400, {
          error: {
            message: 'Kirim "url" atau "manual" (call template UTCP).',
            type: 'invalid_request_error',
            example: { url: 'https://contoh.com/.well-known/utcp' },
          },
        });
        return;
      }

      try {
        const manual = await discoverManual(template, {
          env: process.env,
          manualName: body.name || template.name,
        });
        sendJson(res, 200, {
          ok: true,
          manual: {
            name: manual.name,
            utcp_version: manual.utcp_version,
            manual_version: manual.manual_version,
            tools: body.include_tools === false
              ? manual.tools.map((tool) => ({
                  name: tool.name,
                  call_type: tool.call_type,
                  supported: tool.supported,
                }))
              : manual.tools,
            errors: manual.errors,
          },
        });
      } catch (err) {
        sendJson(res, err.statusCode || 502, {
          ok: false,
          error: { message: err.message, type: 'utcp_error' },
        });
      }
      return;
    }

    // 5e. UTCP — panggil tool lewat protokol UTCP
    if (req.method === 'POST' && route === '/api/utcp/call') {
      const body = await readJsonBody(req);
      const toolName = String(body.tool || body.name || '').trim();
      if (!toolName) {
        sendJson(res, 400, {
          error: { message: 'Parameter "tool" wajib diisi.', type: 'invalid_request_error' },
        });
        return;
      }

      const args = body.arguments ?? body.args ?? {};
      const utcp = await resolveUtcp(req);
      const entry = utcp.entries.find((item) => item.name === toolName);

      if (!entry) {
        sendJson(res, 404, {
          ok: false,
          error: {
            message: `Tool UTCP "${toolName}" tidak terdaftar.`,
            type: 'not_found',
            available: utcp.entries.map((item) => item.name),
          },
        });
        return;
      }

      const started = Date.now();
      try {
        const result = await entry.handler(args);
        sendJson(res, 200, {
          ok: true,
          tool: toolName,
          protocol: entry.utcp?.call_template_type || 'utcp',
          result,
          duration_ms: Date.now() - started,
        });
      } catch (err) {
        sendJson(res, err.statusCode || 502, {
          ok: false,
          tool: toolName,
          error: { message: err.message, type: 'utcp_error' },
          duration_ms: Date.now() - started,
        });
      }
      return;
    }

    // 6. Warmup / Preload Model into Serverless RAM + /tmp
    if (req.method === 'POST' && route === '/api/warmup') {
      const body = await readJsonBody(req);
      const requestedModel = body.model || DEFAULT_MODEL_ID;
      const loaded = await ensureModelLoaded(requestedModel);
      const health = await getSystemHealth();
      sendJson(res, 200, {
        ok: true,
        model: loaded.spec.id,
        name: loaded.spec.name,
        cold_load: loaded.coldLoad,
        load_ms: loaded.loadMs,
        health,
      });
      return;
    }

    // 7. OpenAI-Compatible Chat Completions (/v1/chat/completions & /api/chat)
    if (
      req.method === 'POST' &&
      (route === '/v1/chat/completions' ||
        route === '/api/chat' ||
        route === '/api/llm')
    ) {
      const body = await readJsonBody(req);
      const requestedModel = body.model || DEFAULT_MODEL_ID;
      const stream = Boolean(body.stream);
      const temperature = body.temperature ?? 0.65;
      const topP = body.top_p ?? body.topP ?? 0.9;
      const maxTokens =
        body.max_tokens ?? body.max_completion_tokens ?? body.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

      const { tools, functions, toolChoice, maxRounds } = readToolConfig(body);

      const completionId = `chatcmpl-${crypto.randomBytes(10).toString('hex')}`;
      const created = Math.floor(Date.now() / 1000);

      const abortController = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) {
          abortController.abort();
        }
      });

      // Progress unduhan model perlu diteruskan ke SSE saat streaming
      const progressRef = { current: null };
      const utcp = await resolveUtcp(req);

      const agentParams = {
        messages: body.messages,
        prompt: body.prompt,
        tools,
        functions,
        toolChoice,
        maxRounds,
        temperature,
        topP,
        maxTokens,
        env: process.env,
        ctx: toolContext(utcp.entries),
        registry: getToolRegistry({ env: process.env, utcpTools: utcp.entries }),
        runInference: (args) => {
          const { signal, ...rest } = args || {};
          return runChatInference({
            modelId: requestedModel,
            onProgress: progressRef.current || undefined,
            ...rest,
            signal: signal || abortController.signal,
          });
        },
      };

      if (stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
          'Access-Control-Allow-Origin': '*',
        });

        res.write(
          `: status ${JSON.stringify({ phase: 'starting', model: requestedModel })}\n\n`
        );

        let sentRole = false;

        const writeDelta = (delta, finishReason = null, extra = {}) => {
          if (res.writableEnded) return;
          const payload = {
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model: requestedModel,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
            ...extra,
          };
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        };

        const ensureRole = () => {
          if (sentRole) return;
          sentRole = true;
          writeDelta({ role: 'assistant', content: '' });
        };

        const writeStatus = (payload) => {
          if (!res.writableEnded) res.write(`: status ${JSON.stringify(payload)}\n\n`);
        };

        progressRef.current = (progress) => {
          writeStatus({
            phase: 'downloading',
            model: progress.modelId,
            percent: progress.percent,
            downloaded_mb: Math.round(progress.downloadedBytes / 1024 / 1024),
            total_mb: Math.round(progress.totalBytes / 1024 / 1024),
          });
        };

        try {
          const result = await runToolAgent({
            ...agentParams,
            onRound({ round }) {
              if (round > 1) writeStatus({ phase: 'round', round });
            },
            onTextChunk(chunk) {
              if (res.writableEnded) return;
              ensureRole();
              writeDelta({ content: chunk });
            },
            onToolCall(call) {
              writeStatus({
                phase: 'tool_call',
                id: call.id,
                name: call.name,
                arguments: call.arguments,
              });
            },
            onToolResult(info) {
              writeStatus({
                phase: 'tool_result',
                id: info.id,
                name: info.name,
                ok: info.ok,
                duration_ms: info.duration_ms,
                preview: info.result_preview,
              });
            },
          });

          if (!res.writableEnded) {
            if (result.toolCalls?.length) {
              // Tool milik client: kirim panggilan sesuai format OpenAI streaming
              ensureRole();
              result.toolCalls.forEach((call, index) => {
                writeDelta({
                  tool_calls: [
                    {
                      index,
                      id: call.id,
                      type: 'function',
                      function: { name: call.name, arguments: '' },
                    },
                  ],
                });
                writeDelta({
                  tool_calls: [
                    {
                      index,
                      function: { arguments: JSON.stringify(call.arguments ?? {}) },
                    },
                  ],
                });
              });
              writeDelta({}, 'tool_calls', {
                usage: result.usage,
                timings: result.timings,
                tool_trace: result.trace,
              });
            } else {
              ensureRole();
              writeDelta({}, result.finishReason || 'stop', {
                usage: result.usage,
                timings: result.timings,
                ...(result.trace?.length ? { tool_trace: result.trace } : {}),
              });
            }
            res.write('data: [DONE]\n\n');
            res.end();
          }
        } catch (streamErr) {
          if (!res.writableEnded) {
            const errChunk = {
              error: {
                message: streamErr?.message || 'Gagal menjalankan inferensi LLM.',
                type: 'server_error',
              },
            };
            res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          }
        }
        return;
      }

      const result = await runToolAgent(agentParams);

      const message = {
        role: 'assistant',
        content: result.text || '',
      };
      if (result.toolCalls?.length) {
        message.tool_calls = result.toolCalls.map(toOpenAIToolCall);
      }

      sendJson(res, 200, {
        id: completionId,
        object: 'chat.completion',
        created,
        model: requestedModel,
        choices: [
          {
            index: 0,
            message,
            finish_reason: result.finishReason || 'stop',
          },
        ],
        usage: result.usage,
        timings: result.timings,
        ...(result.trace?.length ? { tool_trace: result.trace, tool_rounds: result.rounds } : {}),
      });
      return;
    }

    // 8. Ollama-Compatible Generate Endpoint (/api/generate)
    if (req.method === 'POST' && route === '/api/generate') {
      const body = await readJsonBody(req);
      const requestedModel = body.model || DEFAULT_MODEL_ID;
      const stream = body.stream !== false;
      const messages = [];
      if (body.system) {
        messages.push({ role: 'system', content: String(body.system) });
      }
      messages.push({ role: 'user', content: String(body.prompt || '') });

      const abortController = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) abortController.abort();
      });

      if (stream) {
        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Access-Control-Allow-Origin': '*',
        });

        const result = await runChatInference({
          modelId: requestedModel,
          messages,
          temperature: body.options?.temperature ?? 0.65,
          maxTokens: body.options?.num_predict ?? DEFAULT_MAX_OUTPUT_TOKENS,
          signal: abortController.signal,
          onTokenChunk(chunk) {
            if (!res.writableEnded) {
              res.write(
                `${JSON.stringify({
                  model: requestedModel,
                  created_at: new Date().toISOString(),
                  response: chunk,
                  done: false,
                })}\n`
              );
            }
          },
        });

        if (!res.writableEnded) {
          res.write(
            `${JSON.stringify({
              model: result.modelSpec.id,
              created_at: new Date().toISOString(),
              response: '',
              done: true,
              eval_count: result.usage.completion_tokens,
              eval_duration: result.timings.generation_ms * 1_000_000,
            })}\n`
          );
          res.end();
        }
        return;
      }

      const result = await runChatInference({
        modelId: requestedModel,
        messages,
        temperature: body.options?.temperature ?? 0.65,
        maxTokens: body.options?.num_predict ?? DEFAULT_MAX_OUTPUT_TOKENS,
        signal: abortController.signal,
      });

      sendJson(res, 200, {
        model: result.modelSpec.id,
        created_at: new Date().toISOString(),
        response: result.text,
        done: true,
        eval_count: result.usage.completion_tokens,
        timings: result.timings,
      });
      return;
    }

    sendJson(res, 404, {
      error: {
        message: `Endpoint ${req.method} ${route} tidak ditemukan.`,
        available_endpoints: AVAILABLE_ENDPOINTS,
      },
    });
  } catch (err) {
    const statusCode = err?.statusCode || (err instanceof SyntaxError ? 400 : 500);
    sendJson(res, statusCode, {
      error: {
        message: err?.message || 'Internal Server Error',
        type: statusCode === 400 ? 'invalid_request_error' : 'server_error',
      },
    });
  }
}
