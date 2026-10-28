import crypto from 'node:crypto';
import {
  DEFAULT_MODEL_ID,
  MODEL_CATALOG,
  ensureModelLoaded,
  getSystemHealth,
  runChatInference,
} from '../lib/llm-engine.mjs';

// Safe dynamic import hint for Vercel NFT bundler on Linux x64
import('@node-llama-cpp/linux-x64').catch(() => {});

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

    // 2. OpenAI-Compatible Models List
    if (req.method === 'GET' && (route === '/v1/models' || route === '/api/models')) {
      const health = await getSystemHealth();
      const cacheMap = new Map(health.cached_models.map((m) => [m.id, m]));
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

    // 4. Warmup / Preload Model into Serverless RAM + /tmp
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

    // 5. OpenAI-Compatible Chat Completions (/v1/chat/completions & /api/chat)
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
        body.max_tokens ?? body.max_completion_tokens ?? body.maxTokens ?? 384;

      const completionId = `chatcmpl-${crypto.randomBytes(10).toString('hex')}`;
      const created = Math.floor(Date.now() / 1000);

      const abortController = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) {
          abortController.abort();
        }
      });

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

        try {
          const result = await runChatInference({
            modelId: requestedModel,
            messages: body.messages,
            prompt: body.prompt,
            temperature,
            topP,
            maxTokens,
            signal: abortController.signal,
            onProgress(progress) {
              if (!res.writableEnded) {
                res.write(
                  `: status ${JSON.stringify({
                    phase: 'downloading',
                    model: progress.modelId,
                    percent: progress.percent,
                    downloaded_mb: Math.round(progress.downloadedBytes / 1024 / 1024),
                    total_mb: Math.round(progress.totalBytes / 1024 / 1024),
                  })}\n\n`
                );
              }
            },
            onTokenChunk(textChunk) {
              if (res.writableEnded) return;
              if (!sentRole) {
                sentRole = true;
                const rolePayload = {
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created,
                  model: requestedModel,
                  choices: [
                    {
                      index: 0,
                      delta: { role: 'assistant', content: '' },
                      finish_reason: null,
                    },
                  ],
                };
                res.write(`data: ${JSON.stringify(rolePayload)}\n\n`);
              }

              const deltaPayload = {
                id: completionId,
                object: 'chat.completion.chunk',
                created,
                model: requestedModel,
                choices: [
                  {
                    index: 0,
                    delta: { content: textChunk },
                    finish_reason: null,
                  },
                ],
              };
              res.write(`data: ${JSON.stringify(deltaPayload)}\n\n`);
            },
          });

          if (!res.writableEnded) {
            const finalChunk = {
              id: completionId,
              object: 'chat.completion.chunk',
              created,
              model: result.modelSpec.id,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: result.finishReason,
                },
              ],
              usage: result.usage,
              timings: result.timings,
            };
            res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
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

      const result = await runChatInference({
        modelId: requestedModel,
        messages: body.messages,
        prompt: body.prompt,
        temperature,
        topP,
        maxTokens,
        signal: abortController.signal,
      });

      sendJson(res, 200, {
        id: completionId,
        object: 'chat.completion',
        created,
        model: result.modelSpec.id,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: result.text,
            },
            finish_reason: result.finishReason,
          },
        ],
        usage: result.usage,
        timings: result.timings,
      });
      return;
    }

    // 6. Ollama-Compatible Generate Endpoint (/api/generate)
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
          maxTokens: body.options?.num_predict ?? 384,
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
        maxTokens: body.options?.num_predict ?? 384,
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
        available_endpoints: [
          'GET /api/health',
          'POST /api/warmup',
          'GET /v1/models',
          'POST /v1/chat/completions',
          'GET /api/tags',
          'POST /api/generate',
        ],
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
