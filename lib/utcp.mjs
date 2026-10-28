/**
 * UTCP (Universal Tool Calling Protocol) — implementasi subset kompatibel.
 *
 * Referensi: https://github.com/universal-tool-calling-protocol/typescript-utcp
 *
 * Yang didukung (cocok untuk lingkungan serverless):
 *  - Manual discovery: `http`, `text`, `mcp` (streamable HTTP), `file` (opt-in)
 *  - Call template: `http`, `streamable_http`, `mcp` (HTTP), `sse` (terbatas)
 *  - Konversi OpenAPI 3 / Swagger 2 sederhana → UTCP manual
 *  - Publish manual sendiri di `/.well-known/utcp`
 *
 * Tidak didukung (dan dilaporkan jelas, bukan gagal diam-diam):
 *  - `cli` (butuh proses shell), `websocket`/`grpc` (butuh koneksi persisten),
 *    `mcp` transport `stdio` (butuh child process)
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { assertPublicHttpUrl, parseAllowedHosts, validateArguments } from './tools.mjs';

export const UTCP_PROTOCOL_VERSION = '1.0.0';
export const UTCP_MANUAL_VERSION = '1.0.0';

const MAX_MANUAL_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 10000;
const DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000;

export const SUPPORTED_MANUAL_PROTOCOLS = ['http', 'text', 'mcp', 'file'];
export const SUPPORTED_CALL_PROTOCOLS = ['http', 'streamable_http', 'mcp', 'sse'];
export const UNSUPPORTED_PROTOCOLS = {
  cli: 'Transport "cli" butuh proses shell; tidak tersedia di Vercel Serverless.',
  websocket: 'Transport "websocket" butuh koneksi persisten; tidak tersedia di serverless.',
  grpc: 'Transport "grpc" tidak tersedia di runtime ini.',
  file: 'Tool dengan template "file" hanya untuk discovery manual, bukan pemanggilan.',
  text: 'Template "text" hanya untuk discovery manual, bukan pemanggilan tool.',
};

const TOOL_NAME_RE = /^[a-zA-Z0-9_.:-]{1,96}$/;

function utcpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function truncate(text, max = 4000) {
  const str = typeof text === 'string' ? text : JSON.stringify(text);
  if (!str) return '';
  return str.length > max ? `${str.slice(0, max)}… [dipotong ${str.length - max} karakter]` : str;
}

function parseMaybeJson(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

/* ------------------------------------------------------------------ */
/* Nama & namespace                                                    */
/* ------------------------------------------------------------------ */

export function normalizeNamespace(manualName) {
  const clean = String(manualName || 'manual')
    .trim()
    // UTCP: nama manual jadi namespace, tanda hubung/titik dinormalisasi ke "_"
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return clean || 'manual';
}

export function namespaceFor(manualName) {
  return `${normalizeNamespace(manualName).replace(/_/g, '__')}_`;
}

/** `manual.tool` — sesuai konvensi UTCP. */
export function qualifyToolName(manualName, toolName) {
  const manual = normalizeNamespace(manualName);
  const rawName = String(toolName || '').trim();
  if (!rawName) return '';
  if (rawName.includes('.')) return rawName; // sudah namespaced
  return `${manual}.${rawName}`;
}

/* ------------------------------------------------------------------ */
/* Substitusi variabel ala UTCP                                        */
/* ------------------------------------------------------------------ */

/**
 * Mendukung `${VAR}`, `${manual__name_VAR}` (namespace UTCP) dan `${env:VAR}`.
 * Prioritas: namespace manual → env biasa → variabel kontekstual.
 */
export function substituteVariables(value, { env = process.env, manualName = '', variables = {} } = {}) {
  const namespace = namespaceFor(manualName);

  if (typeof value === 'string') {
    return value.replace(/\$\{\s*(env:)?([A-Za-z0-9_]+)\s*\}/g, (match, isEnv, key) => {
      const namespacedKey = `${namespace}${key}`;
      const candidates = isEnv ? [key, namespacedKey] : [namespacedKey, key];
      for (const candidate of candidates) {
        if (variables && variables[candidate] !== undefined) return String(variables[candidate]);
        if (env && env[candidate] !== undefined) return String(env[candidate]);
      }
      return match; // biarkan apa adanya agar terlihat salah konfigurasi
    });
  }

  if (Array.isArray(value)) {
    return value.map((item) => substituteVariables(item, { env, manualName, variables }));
  }

  if (isPlainObject(value)) {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = substituteVariables(item, { env, manualName, variables });
    }
    return output;
  }

  return value;
}

/* ------------------------------------------------------------------ */
/* HTTP helper                                                         */
/* ------------------------------------------------------------------ */

async function httpRequest(url, options = {}) {
  const timeoutMs = Math.min(30000, Math.max(500, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: options.headers,
      body: options.body,
      redirect: 'follow',
      signal: controller.signal,
    });

    let text = '';
    let bytes = 0;
    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.length;
        text += decoder.decode(value, { stream: true });
        if (bytes >= MAX_RESPONSE_BYTES) {
          try {
            await reader.cancel();
          } catch {}
          text += `\n… [respons dipotong pada ${MAX_RESPONSE_BYTES} byte]`;
          break;
        }
      }
    }

    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      contentType: String(response.headers.get('content-type') || ''),
      text,
    };
  } catch (err) {
    if (err.name === 'AbortError') throw utcpError(`Permintaan ${url} melewati batas waktu ${timeoutMs} ms.`, 504);
    throw utcpError(`Gagal menghubungi ${url}: ${err.message}`, 502);
  } finally {
    clearTimeout(timer);
  }
}

function buildAuthHeaders(auth, { env, manualName, variables }) {
  if (!auth || !isPlainObject(auth)) return { headers: {}, query: {}, tokenUrl: null };

  const resolve = (raw) => String(substituteVariables(raw ?? '', { env, manualName, variables }));
  const type = String(auth.auth_type || '').toLowerCase();

  if (type === 'api_key' || type === 'apikey') {
    const value = resolve(auth.api_key_value ?? auth.value ?? auth.api_key ?? '');
    const keyName = String(auth.var_name ?? auth.key_name ?? 'X-API-Key');
    const location = String(auth.in ?? auth.location ?? 'header').toLowerCase();
    if (location === 'query') return { headers: {}, query: { [keyName]: value }, tokenUrl: null };
    return { headers: { [keyName]: value }, query: {}, tokenUrl: null };
  }

  if (type === 'basic') {
    const username = resolve(auth.username ?? '');
    const password = resolve(auth.password ?? '');
    const encoded = Buffer.from(`${username}:${password}`).toString('base64');
    return { headers: { Authorization: `Basic ${encoded}` }, query: {}, tokenUrl: null };
  }

  if (type === 'oauth2') {
    return {
      headers: {},
      query: {},
      tokenUrl: auth.token_url ? resolve(auth.token_url) : null,
      oauth: {
        clientId: resolve(auth.client_id ?? ''),
        clientSecret: resolve(auth.client_secret ?? ''),
        scopes: auth.scopes ?? [],
        grantType: auth.grant_type || 'client_credentials',
      },
    };
  }

  return { headers: {}, query: {}, tokenUrl: null };
}

const oauthCache = globalThis.__utcpOauthCache || (globalThis.__utcpOauthCache = new Map());

async function getOAuthToken(authInfo, { env, manualName, variables }) {
  const cacheKey = `${manualName}:${authInfo.tokenUrl}:${authInfo.oauth.clientId}`;
  const cached = oauthCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;

  const body = new URLSearchParams();
  body.set('grant_type', authInfo.oauth.grantType || 'client_credentials');
  body.set('client_id', authInfo.oauth.clientId);
  if (authInfo.oauth.clientSecret) body.set('client_secret', authInfo.oauth.clientSecret);
  if (Array.isArray(authInfo.oauth.scopes) && authInfo.oauth.scopes.length) {
    body.set('scope', authInfo.oauth.scopes.join(' '));
  }

  const tokenUrl = assertPublicHttpUrl(authInfo.tokenUrl, parseAllowedHosts(env.LLM_TOOL_HTTP_ALLOW_HOSTS));
  const response = await httpRequest(tokenUrl.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': 'lollm-utcp/1.0',
    },
    body: body.toString(),
  });

  if (!response.ok) throw utcpError(`OAuth token request gagal (HTTP ${response.status}).`, 502);
  const json = parseMaybeJson(response.text) || {};
  const token = json.access_token;
  if (!token) throw utcpError('Respons OAuth tidak memuat access_token.', 502);

  const ttl = Number(json.expires_in) > 0 ? Number(json.expires_in) * 1000 : 300_000;
  oauthCache.set(cacheKey, { token, expiresAt: Date.now() + ttl });
  return token;
}

/** Ganti `{param}` dan `${param}` pada URL dengan argumen tool. */
export function applyPathParams(urlTemplate, args = {}) {
  let used = new Set();
  const replaced = String(urlTemplate).replace(/\$\{([A-Za-z0-9_]+)\}|\{([A-Za-z0-9_]+)\}/g, (match, dollarKey, braceKey) => {
    const key = dollarKey || braceKey;
    if (!(key in args)) return match;
    used.add(key);
    const value = args[key];
    return encodeURIComponent(typeof value === 'object' ? JSON.stringify(value) : String(value));
  });

  const remaining = { ...args };
  for (const key of used) delete remaining[key];
  return { url: replaced, remaining };
}

/* ------------------------------------------------------------------ */
/* Discovery manual                                                    */
/* ------------------------------------------------------------------ */

export function normalizeToolDefinition(raw, { manualName = 'manual' } = {}) {
  if (!isPlainObject(raw)) throw utcpError('Definisi tool harus berupa objek.');

  const name = String(raw.name || '').trim();
  if (!TOOL_NAME_RE.test(name) || (!name.includes('.') && name.length === 0)) {
    throw utcpError(`Nama tool "${name}" tidak valid (harus 1-96 karakter: huruf, angka, _ . : -).`);
  }

  const template = raw.tool_call_template;
  if (!isPlainObject(template) || !template.call_template_type) {
    throw utcpError(`Tool "${name}" tidak punya "tool_call_template.call_template_type".`);
  }

  const callType = String(template.call_template_type).toLowerCase();
  const inputs = isPlainObject(raw.inputs) ? raw.inputs : { type: 'object', properties: {} };
  const outputs = isPlainObject(raw.outputs) ? raw.outputs : {};

  return {
    name,
    description: String(raw.description || ''),
    inputs,
    outputs,
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    average_response_size: Number(raw.average_response_size) || undefined,
    tool_call_template: { ...template, call_template_type: callType },
    manual_name: manualName,
    call_type: callType,
    supported: SUPPORTED_CALL_PROTOCOLS.includes(callType),
    unsupported_reason: SUPPORTED_CALL_PROTOCOLS.includes(callType)
      ? null
      : UNSUPPORTED_PROTOCOLS[callType] || `Transport "${callType}" belum didukung.`,
  };
}

export function normalizeManual(raw, { manualName = 'manual', strict = false } = {}) {
  if (!isPlainObject(raw)) throw utcpError('Manual UTCP harus berupa objek JSON.');

  const sourceTools = Array.isArray(raw.tools) ? raw.tools : null;
  if (!sourceTools) throw utcpError('Manual UTCP harus punya array "tools".');

  const tools = [];
  const errors = [];

  for (const item of sourceTools) {
    try {
      tools.push(normalizeToolDefinition(item, { manualName }));
    } catch (err) {
      errors.push(err.message);
      if (strict) throw err;
    }
  }

  if (strict && tools.length === 0 && sourceTools.length > 0) {
    throw utcpError(`Tidak ada tool valid di manual: ${errors.join('; ')}`);
  }

  return {
    name: normalizeNamespace(raw.name || manualName),
    utcp_version: String(raw.utcp_version || UTCP_PROTOCOL_VERSION),
    manual_version: String(raw.manual_version || UTCP_MANUAL_VERSION),
    tools,
    errors,
  };
}

/** Konversi OpenAPI 3 / Swagger 2 sederhana menjadi UTCP manual. */
export function convertOpenApiToManual(spec, { manualName = 'openapi', baseUrl = '' } = {}) {
  if (!isPlainObject(spec) || !isPlainObject(spec.paths)) {
    throw utcpError('Spesifikasi OpenAPI tidak valid (tidak ada "paths").');
  }

  const servers = Array.isArray(spec.servers) ? spec.servers : [];
  const serverUrl = stripTrailingSlash(
    baseUrl || servers[0]?.url || (spec.host ? `${spec.schemes?.[0] || 'https'}://${spec.host}${spec.basePath || ''}` : '')
  );

  const tools = [];
  const methods = ['get', 'post', 'put', 'patch', 'delete'];

  for (const [rawPath, pathItem] of Object.entries(spec.paths)) {
    if (!isPlainObject(pathItem)) continue;
    for (const method of methods) {
      const operation = pathItem[method];
      if (!isPlainObject(operation)) continue;

      const derivedName =
        operation.operationId ||
        `${method}_${rawPath.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;
      const name = String(derivedName).replace(/[^a-zA-Z0-9_.:-]+/g, '_').slice(0, 96);
      if (!TOOL_NAME_RE.test(name)) continue;

      const properties = {};
      const required = [];
      const headerFields = [];

      const parameters = [
        ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
        ...(Array.isArray(operation.parameters) ? operation.parameters : []),
      ];

      for (const param of parameters) {
        if (!isPlainObject(param) || !param.name) continue;
        const schema = isPlainObject(param.schema) ? param.schema : { type: param.type || 'string' };
        properties[param.name] = { ...schema, description: param.description || schema.description || '' };
        if (param.required) required.push(param.name);
        if (String(param.in).toLowerCase() === 'header') headerFields.push(param.name);
      }

      const requestBodySchema =
        operation.requestBody?.content?.['application/json']?.schema ||
        operation.requestBody?.content?.['application/x-www-form-urlencoded']?.schema;
      if (isPlainObject(requestBodySchema) && requestBodySchema.type === 'object') {
        for (const [key, schema] of Object.entries(requestBodySchema.properties || {})) {
          properties[key] = isPlainObject(schema) ? schema : { type: 'string' };
        }
        for (const key of requestBodySchema.required || []) {
          if (!required.includes(key)) required.push(key);
        }
      }

      tools.push({
        name,
        description: String(operation.summary || operation.description || `${method.toUpperCase()} ${rawPath}`),
        inputs: { type: 'object', properties, ...(required.length ? { required } : {}) },
        outputs: {},
        tags: Array.isArray(operation.tags) ? operation.tags.map(String) : [],
        tool_call_template: {
          call_template_type: 'http',
          http_method: method.toUpperCase(),
          url: `${serverUrl}${rawPath}`,
          content_type: requestBodySchema ? 'application/json' : 'application/json',
          ...(headerFields.length ? { header_fields: headerFields } : {}),
        },
      });
    }
  }

  return normalizeManual(
    { utcp_version: UTCP_PROTOCOL_VERSION, manual_version: UTCP_MANUAL_VERSION, tools },
    { manualName }
  );
}

/* ------------------------------------------------------------------ */
/* MCP client (transport HTTP / streamable HTTP)                       */
/* ------------------------------------------------------------------ */

function parseSsePayload(text, requestId) {
  const events = String(text).split(/\n\n+/);
  const messages = [];
  for (const event of events) {
    const dataLines = event
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());
    if (!dataLines.length) continue;
    const payload = parseMaybeJson(dataLines.join('\n'));
    if (!payload) continue;
    if (requestId === undefined || payload.id === requestId) messages.push(payload);
  }
  return messages;
}

async function mcpRpc(server, { method, params, requestId = 1, env, manualName, variables, sessionId }) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'User-Agent': 'lollm-utcp/1.0',
    ...substituteVariables(server.headers || {}, { env, manualName, variables }),
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  const url = assertPublicHttpUrl(
    substituteVariables(server.url, { env, manualName, variables }),
    parseAllowedHosts(env.LLM_TOOL_HTTP_ALLOW_HOSTS)
  );

  const response = await httpRequest(url.toString(), {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params: params ?? {} }),
    timeoutMs: Number(server.timeout) > 0 ? Number(server.timeout) * 1000 : DEFAULT_TIMEOUT_MS,
  });

  const newSession = response.headers.get('mcp-session-id') || sessionId;

  if (!response.ok) {
    throw utcpError(`MCP ${method} gagal: HTTP ${response.status} ${truncate(response.text, 300)}`, 502);
  }

  const contentType = response.contentType.toLowerCase();
  const messages = contentType.includes('text/event-stream')
    ? parseSsePayload(response.text, requestId)
    : [parseMaybeJson(response.text)].filter(Boolean);

  const matching = messages.find((message) => message.id === requestId) || messages[messages.length - 1];
  if (!matching) throw utcpError(`MCP ${method} tidak mengembalikan respons JSON-RPC yang valid.`, 502);
  if (matching.error) {
    throw utcpError(`MCP ${method} error ${matching.error.code}: ${matching.error.message}`, 502);
  }
  return { result: matching.result, sessionId: newSession };
}

function resolveMcpServer(template, { env, manualName, variables }) {
  const config = template.config || {};
  const servers = config.mcpServers || {};
  const entries = Object.entries(servers);
  if (entries.length === 0) throw utcpError('Template MCP tidak memuat "config.mcpServers".');

  // Tool template UTCP menyimpan nama server pada field `server_name` (opsional)
  const wanted = template.server_name || template.server;
  const chosen = wanted ? entries.find(([name]) => name === wanted) : entries[0];
  if (!chosen) throw utcpError(`MCP server "${wanted}" tidak ditemukan di config.mcpServers.`);

  const [serverName, server] = chosen;
  if (!isPlainObject(server)) throw utcpError(`Konfigurasi MCP server "${serverName}" tidak valid.`);

  const transport = String(server.transport || 'http').toLowerCase();
  if (transport === 'stdio') {
    throw utcpError(UNSUPPORTED_PROTOCOLS.cli.replace('cli', 'mcp stdio'), 501);
  }
  if (transport !== 'http' && transport !== 'streamable_http' && transport !== 'sse') {
    throw utcpError(`Transport MCP "${transport}" belum didukung.`, 501);
  }
  if (!server.url) throw utcpError(`MCP server "${serverName}" tidak punya "url".`);

  return {
    serverName,
    server: {
      ...server,
      headers: substituteVariables(server.headers || {}, { env, manualName, variables }),
      timeout: Number(server.timeout) || 30,
    },
  };
}

export async function mcpInitialize(server, options) {
  const init = await mcpRpc(server, {
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'lollm-utcp', version: '1.0.0' },
    },
    requestId: 1,
    ...options,
  });

  // Notification (best effort): server boleh membalas 202/204 tanpa body
  try {
    await mcpRpc(server, {
      method: 'notifications/initialized',
      params: {},
      requestId: undefined,
      sessionId: init.sessionId,
      ...options,
    });
  } catch {
    /* opsional */
  }

  return { serverInfo: init.result?.serverInfo || null, sessionId: init.sessionId };
}

export async function mcpListTools(template, options = {}) {
  const { serverName, server } = resolveMcpServer(template, options);
  const { sessionId } = await mcpInitialize(server, options);

  const list = await mcpRpc(server, {
    method: 'tools/list',
    params: {},
    requestId: 2,
    sessionId,
    ...options,
  });

  const tools = Array.isArray(list.result?.tools) ? list.result.tools : [];
  return tools.map((tool) => ({
    name: String(tool.name),
    description: String(tool.description || ''),
    inputs: isPlainObject(tool.inputSchema) ? tool.inputSchema : { type: 'object', properties: {} },
    outputs: {},
    tags: ['mcp'],
    tool_call_template: {
      call_template_type: 'mcp',
      name: template.name,
      server_name: serverName,
      config: template.config,
    },
  }));
}

export async function mcpCallTool(template, toolName, args, options = {}) {
  const { serverName, server } = resolveMcpServer(template, options);
  void serverName;
  const { sessionId } = await mcpInitialize(server, options);

  const response = await mcpRpc(server, {
    method: 'tools/call',
    params: { name: toolName, arguments: args ?? {} },
    requestId: 3,
    sessionId,
    ...options,
  });

  const result = response.result || {};
  const content = Array.isArray(result.content) ? result.content : [];
  const textParts = content
    .map((part) => {
      if (part?.type === 'text') return part.text;
      if (part?.type === 'json') return JSON.stringify(part.json);
      return part?.text || null;
    })
    .filter(Boolean);

  return {
    isError: Boolean(result.isError),
    content: textParts.length ? textParts.join('\n') : truncate(JSON.stringify(result.raw ?? result), 6000),
    structured: result.structuredContent ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Pemanggilan tool (call template executor)                           */
/* ------------------------------------------------------------------ */

async function httpCall(template, args, { env, manualName, variables }) {
  const allowedHosts = parseAllowedHosts(env.LLM_TOOL_HTTP_ALLOW_HOSTS);
  const safeArgs = isPlainObject(args) ? args : {};

  const headers = {
    'User-Agent': 'lollm-utcp/1.0',
    Accept: 'application/json, text/plain;q=0.9',
    ...substituteVariables(template.headers || {}, { env, manualName, variables }),
  };

  for (const field of Array.isArray(template.header_fields) ? template.header_fields : []) {
    if (field in safeArgs) {
      headers[field] = String(safeArgs[field]);
      delete safeArgs[field];
    }
  }

  let body;
  const bodyField = template.body_field;
  if (bodyField && bodyField in safeArgs) {
    const raw = safeArgs[bodyField];
    body = typeof raw === 'string' ? raw : JSON.stringify(raw);
    headers['Content-Type'] = headers['Content-Type'] || template.content_type || 'application/json';
    delete safeArgs[bodyField];
  }

  const { url: resolvedPath, remaining } = applyPathParams(
    substituteVariables(template.url, { env, manualName, variables }),
    safeArgs
  );

  const target = new URL(resolvedPath);
  const method = String(template.http_method || 'GET').toUpperCase();

  if (body === undefined && method !== 'GET' && method !== 'HEAD' && Object.keys(remaining).length > 0) {
    body = JSON.stringify(remaining);
    headers['Content-Type'] = headers['Content-Type'] || template.content_type || 'application/json';
    for (const key of Object.keys(remaining)) delete remaining[key];
  }

  for (const [key, value] of Object.entries(remaining)) {
    if (value === undefined) continue;
    target.searchParams.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }

  const authInfo = buildAuthHeaders(template.auth || template.auth_tools, { env, manualName, variables });
  Object.assign(headers, authInfo.headers);
  for (const [key, value] of Object.entries(authInfo.query)) target.searchParams.set(key, value);
  if (authInfo.oauth && authInfo.tokenUrl) {
    headers.Authorization = `Bearer ${await getOAuthToken(authInfo, { env, manualName, variables })}`;
  }

  assertPublicHttpUrl(target.toString(), allowedHosts);

  const response = await httpRequest(target.toString(), {
    method,
    headers,
    body,
    timeoutMs: Number(template.timeout) > 0 ? Number(template.timeout) * 1000 : DEFAULT_TIMEOUT_MS,
  });

  if (!response.ok) {
    throw utcpError(
      `Tool HTTP ${method} ${target.pathname} gagal: HTTP ${response.status} ${truncate(response.text, 300)}`,
      502
    );
  }

  const json = parseMaybeJson(response.text);
  return {
    status: response.status,
    content_type: response.contentType,
    data: json ?? truncate(response.text, 6000),
  };
}

async function streamableHttpCall(template, args, { env, manualName, variables }) {
  const allowedHosts = parseAllowedHosts(env.LLM_TOOL_HTTP_ALLOW_HOSTS);
  const target = assertPublicHttpUrl(
    substituteVariables(template.url, { env, manualName, variables }),
    allowedHosts
  );

  const headers = {
    'Content-Type': template.content_type || 'application/json',
    Accept: 'text/event-stream, application/json',
    'User-Agent': 'lollm-utcp/1.0',
    ...substituteVariables(template.headers || {}, { env, manualName, variables }),
  };

  const response = await httpRequest(target.toString(), {
    method: String(template.http_method || 'POST').toUpperCase(),
    headers,
    body: JSON.stringify(args ?? {}),
    timeoutMs: Number(template.timeout) > 0 ? Number(template.timeout) : 30000,
  });

  if (!response.ok) {
    throw utcpError(`Streamable HTTP gagal: HTTP ${response.status} ${truncate(response.text, 300)}`, 502);
  }

  return {
    status: response.status,
    chunks_received: Math.ceil(response.text.length / Math.max(1, Number(template.chunk_size) || 4096)),
    data: parseMaybeJson(response.text) ?? truncate(response.text, 6000),
  };
}

async function sseCall(template, args, { env, manualName, variables }) {
  const allowedHosts = parseAllowedHosts(env.LLM_TOOL_HTTP_ALLOW_HOSTS);
  const target = assertPublicHttpUrl(
    substituteVariables(template.url, { env, manualName, variables }),
    allowedHosts
  );

  const url = new URL(target.toString());
  for (const [key, value] of Object.entries(args || {})) {
    if (value === undefined) continue;
    url.searchParams.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }

  const headers = {
    Accept: 'text/event-stream',
    'User-Agent': 'lollm-utcp/1.0',
    ...substituteVariables(template.headers || {}, { env, manualName, variables }),
  };

  const response = await httpRequest(url.toString(), {
    method: 'GET',
    headers,
    timeoutMs: Math.min(20000, Number(template.retry_timeout) || 10000),
  });

  if (!response.ok) {
    throw utcpError(`SSE gagal: HTTP ${response.status}`, 502);
  }

  const events = String(response.text)
    .split(/\n\n+/)
    .map((block) => {
      const eventType = block
        .split('\n')
        .find((line) => line.startsWith('event:'))
        ?.slice(6)
        .trim();
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      return data ? { event: eventType || 'message', data: parseMaybeJson(data) ?? data } : null;
    })
    .filter(Boolean)
    .filter((event) => !template.event_type || event.event === template.event_type);

  if (events.length === 0) throw utcpError('SSE tidak mengirim event apa pun dalam batas waktu.', 504);
  return { events_received: events.length, data: events.map((event) => event.data) };
}

/** Eksekusi tool UTCP berdasarkan `tool_call_template`. */
export async function callUtcpTool(tool, args = {}, options = {}) {
  const { env = process.env, variables = {} } = options;
  const template = tool?.tool_call_template;
  if (!isPlainObject(template)) throw utcpError('Tool UTCP tidak punya tool_call_template.');

  const manualName = tool.manual_name || template.name || 'manual';
  const ctx = { env, variables, manualName };
  const callType = String(template.call_template_type || '').toLowerCase();

  switch (callType) {
    case 'http':
      return httpCall(template, args, ctx);
    case 'streamable_http':
      return streamableHttpCall(template, args, ctx);
    case 'sse':
      return sseCall(template, args, ctx);
    case 'mcp': {
      const toolName = String(tool.name).includes('.') ? String(tool.name).split('.').pop() : String(tool.name);
      return mcpCallTool(template, toolName, args, ctx);
    }
    default:
      throw utcpError(UNSUPPORTED_PROTOCOLS[callType] || `Transport "${callType}" belum didukung.`, 501);
  }
}

/* ------------------------------------------------------------------ */
/* Entry registry (dipakai lib/tools.mjs)                              */
/* ------------------------------------------------------------------ */

export function buildRegistryEntries(manuals, { env = process.env, variables = {} } = {}) {
  const entries = [];

  for (const manual of manuals) {
    for (const tool of manual.tools || []) {
      if (!tool.supported) continue;
      entries.push({
        name: qualifyToolName(manual.name, tool.name),
        description: tool.description || `Tool UTCP dari manual ${manual.name}.`,
        parameters: tool.inputs,
        outputs: tool.outputs || {},
        source: 'utcp',
        utcp: { manual: manual.name, tool: tool.name, call_template_type: tool.call_type },
        requiresAllowlist: false,
        async handler(args) {
          const validated = validateArguments(tool.inputs, args);
          return callUtcpTool(tool, validated, { env, variables });
        },
      });
    }
  }

  return entries;
}

/* ------------------------------------------------------------------ */
/* Manual milik server ini                                             */
/* ------------------------------------------------------------------ */

/**
 * Manual UTCP untuk tool bawaan server ini. Setiap tool dipanggil lewat
 * `POST /api/tools?tool=<nama>` sehingga klien UTCP mana pun bisa memakainya.
 */
export function buildOwnManual({ origin, tools = [], connectors = [] }) {
  const base = stripTrailingSlash(origin || '');
  const manualTools = [];

  for (const tool of tools) {
    const name = tool.name || tool.function?.name;
    if (!name) continue;
    const parameters = tool.parameters || tool.function?.parameters || { type: 'object', properties: {} };
    const description = tool.description || tool.function?.description || '';
    const source = tool.source || 'builtin';

    manualTools.push({
      name,
      description,
      inputs: parameters,
      outputs: {},
      tags: [source, 'lollm'],
      tool_call_template: {
        call_template_type: 'http',
        name: 'lollm',
        http_method: 'POST',
        url: `${base}/api/tools?tool=${encodeURIComponent(name)}`,
        content_type: 'application/json',
      },
    });
  }

  for (const connector of connectors) {
    manualTools.push({
      name: connector.name,
      description: connector.description,
      inputs: connector.parameters,
      outputs: {},
      tags: ['connector', 'lollm'],
      tool_call_template: {
        call_template_type: 'http',
        name: 'lollm',
        http_method: 'POST',
        url: `${base}/api/tools?tool=${encodeURIComponent(connector.name)}`,
        content_type: 'application/json',
      },
    });
  }

  return {
    utcp_version: UTCP_PROTOCOL_VERSION,
    manual_version: UTCP_MANUAL_VERSION,
    tools: manualTools,
  };
}

/* ------------------------------------------------------------------ */
/* Discovery manual eksternal                                          */
/* ------------------------------------------------------------------ */

export async function discoverManual(template, { env = process.env, variables = {}, manualName } = {}) {
  if (!isPlainObject(template)) throw utcpError('Manual call template harus berupa objek.');
  const callType = String(template.call_template_type || 'http').toLowerCase();
  const name = normalizeNamespace(manualName || template.name || 'manual');

  if (callType === 'http') {
    if (!template.url) throw utcpError('Manual HTTP harus punya "url".');
    const allowedHosts = parseAllowedHosts(env.LLM_TOOL_HTTP_ALLOW_HOSTS);
    const resolvedUrl = substituteVariables(template.url, { env, manualName: name, variables });
    const target = assertPublicHttpUrl(resolvedUrl, allowedHosts);

    const method = String(template.http_method || 'GET').toUpperCase();
    const response = await httpRequest(target.toString(), {
      method,
      headers: {
        Accept: 'application/json, application/yaml;q=0.9, text/yaml;q=0.8, */*;q=0.5',
        'User-Agent': 'lollm-utcp/1.0',
        ...substituteVariables(template.headers || {}, { env, manualName: name, variables }),
      },
      body:
        method === 'GET' || method === 'HEAD'
          ? undefined
          : JSON.stringify(substituteVariables(template.body ?? {}, { env, manualName: name, variables })),
      timeoutMs: Number(template.timeout) > 0 ? Number(template.timeout) * 1000 : DEFAULT_TIMEOUT_MS,
    });

    if (!response.ok) {
      throw utcpError(`Discovery manual ${name} gagal: HTTP ${response.status}`, 502);
    }

    const json =
      parseMaybeJson(response.text) ||
      (() => {
        throw utcpError(`Manual ${name} bukan JSON valid (YAML belum didukung tanpa parser).`, 415);
      })();

    if (json && json.utcp_version && Array.isArray(json.tools)) {
      return normalizeManual({ ...json, name }, { manualName: name });
    }
    if (json && (json.openapi || json.swagger || json.paths)) {
      return convertOpenApiToManual(json, { manualName: name, baseUrl: target.origin });
    }
    throw utcpError('Respons bukan UTCP manual maupun spesifikasi OpenAPI.', 415);
  }

  if (callType === 'text') {
    const content = typeof template.content === 'string' ? template.content : JSON.stringify(template.content ?? null);
    const json = parseMaybeJson(content);
    if (!json) throw utcpError('Template "text" tidak memuat JSON valid.');
    if (json.utcp_version && Array.isArray(json.tools)) {
      return normalizeManual({ ...json, name }, { manualName: name });
    }
    if (json.openapi || json.swagger || json.paths) {
      return convertOpenApiToManual(json, { manualName: name });
    }
    throw utcpError('Konten "text" bukan UTCP manual maupun OpenAPI.');
  }

  if (callType === 'mcp') {
    const serverTools = await mcpListTools(template, { env, variables, manualName: name });
    return normalizeManual(
      {
        name,
        utcp_version: UTCP_PROTOCOL_VERSION,
        manual_version: UTCP_MANUAL_VERSION,
        tools: serverTools,
      },
      { manualName: name }
    );
  }

  if (callType === 'file') {
    if (String(env.LLM_UTCP_ALLOW_FILE || '').toLowerCase() !== 'true') {
      throw utcpError('Template "file" dinonaktifkan. Set LLM_UTCP_ALLOW_FILE=true bila memang diperlukan.', 403);
    }
    const root = path.resolve(env.LLM_UTCP_FILE_ROOT || '/tmp');
    const filePath = path.resolve(root, String(template.file_path || ''));
    if (!filePath.startsWith(`${root}${path.sep}`)) {
      throw utcpError('file_path berada di luar LLM_UTCP_FILE_ROOT.', 403);
    }
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat || stat.size > MAX_MANUAL_BYTES) throw utcpError('Berkas manual tidak ada atau terlalu besar.', 404);
    const json = parseMaybeJson(await fs.readFile(filePath, 'utf8'));
    if (!json) throw utcpError('Berkas manual bukan JSON valid.', 415);
    return normalizeManual({ ...json, name }, { manualName: name });
  }

  throw utcpError(
    UNSUPPORTED_PROTOCOLS[callType] || `Tipe manual "${callType}" belum didukung.`,
    501
  );
}

/* ------------------------------------------------------------------ */
/* Manual terdaftar (env + cache)                                      */
/* ------------------------------------------------------------------ */

const manualCache =
  globalThis.__lollmUtcpCache || (globalThis.__lollmUtcpCache = new Map());

export function parseManualTemplates(rawEnv) {
  if (!rawEnv) return [];
  let parsed;
  try {
    parsed = JSON.parse(rawEnv);
  } catch (err) {
    throw utcpError(`Env LLM_UTCP_MANUALS bukan JSON valid: ${err.message}`);
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.manuals) ? parsed.manuals : [];
  return list.filter((item) => isPlainObject(item) && (item.url || item.content || item.config || item.file_path));
}

export async function loadConfiguredManuals({ env = process.env, force = false } = {}) {
  let templates;
  try {
    templates = parseManualTemplates(env.LLM_UTCP_MANUALS);
  } catch (err) {
    return { manuals: [], errors: [{ manual: 'config', message: err.message }], configured: true };
  }

  if (templates.length === 0) return { manuals: [], errors: [], configured: false };

  const manuals = [];
  const errors = [];

  for (const template of templates) {
    const name = normalizeNamespace(template.name || template.url || 'manual');
    const cacheKey = `${name}:${JSON.stringify(template).length}:${env.LLM_TOOL_HTTP_ALLOW_HOSTS || ''}`;
    const cached = manualCache.get(cacheKey);

    if (!force && cached && cached.expiresAt > Date.now()) {
      manuals.push(cached.manual);
      continue;
    }

    try {
      const manual = await discoverManual(template, { env, manualName: name });
      manualCache.set(cacheKey, { manual, expiresAt: Date.now() + DISCOVERY_CACHE_TTL_MS });
      manuals.push(manual);
    } catch (err) {
      errors.push({ manual: name, message: err?.message || 'Discovery gagal.' });
    }
  }

  return { manuals, errors, configured: true };
}

export function describeManuals(manuals, { errors = [] } = {}) {
  return {
    count: manuals.length,
    tools: manuals.reduce((total, manual) => total + manual.tools.length, 0),
    errors,
    data: manuals.map((manual) => ({
      name: manual.name,
      utcp_version: manual.utcp_version,
      manual_version: manual.manual_version,
      tools: manual.tools.length,
      supported_tools: manual.tools.filter((tool) => tool.supported).length,
      protocols: [...new Set(manual.tools.map((tool) => tool.call_type))],
      tool_names: manual.tools.map((tool) => qualifyToolName(manual.name, tool.name)),
    })),
  };
}

export const __utcpInternals = { httpRequest, mcpRpc, parseSsePayload, oauthCache, manualCache, TOOL_NAME_RE };
