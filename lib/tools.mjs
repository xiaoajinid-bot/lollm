/**
 * Registry tool / connector untuk Local LLM on Vercel.
 *
 * Modul ini sengaja tidak mengimpor node-llama-cpp supaya bisa dipakai ulang
 * (unit test, eksekusi langsung via API) tanpa memuat model GGUF.
 *
 * Konsep:
 *  - "tool"  : fungsi yang bisa dipanggil model (calculate, get_current_time, ...)
 *  - "connector": tool yang meneruskan panggilan ke API HTTP eksternal,
 *                 didefinisikan lewat env LLM_CONNECTORS (JSON array).
 */

const TOOL_CALL_OPEN = '<tool_call>';
const TOOL_CALL_CLOSE = '</tool_call>';

const MAX_HTTP_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 8000;

/* ------------------------------------------------------------------ */
/* Helper umum                                                         */
/* ------------------------------------------------------------------ */

function toolError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function truncate(text, max = 4000) {
  const str = typeof text === 'string' ? text : JSON.stringify(text);
  if (!str) return '';
  return str.length > max ? `${str.slice(0, max)}… [dipotong ${str.length - max} karakter]` : str;
}

/** Memotong nilai apa pun; objek yang masih utuh dikembalikan sebagai objek. */
function truncateAny(value, maxChars = 3000) {
  if (typeof value === 'string') return truncate(value, maxChars);
  const str = JSON.stringify(value ?? null);
  if (!str) return null;
  if (str.length <= maxChars) return JSON.parse(str);
  return `${str.slice(0, maxChars)}… [dipotong ${str.length - maxChars} karakter]`;
}

function nowMs() {
  return Math.round(performance.now());
}

/* ------------------------------------------------------------------ */
/* Validasi argumen sederhana (subset JSON Schema)                     */
/* ------------------------------------------------------------------ */

export function validateArguments(schema, rawArgs) {
  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
  const properties = schema?.properties || {};
  const required = Array.isArray(schema?.required) ? schema.required : [];
  const cleaned = {};

  for (const [key, rule] of Object.entries(properties)) {
    let value = args[key];

    if (value === undefined || value === null || value === '') {
      if (rule?.default !== undefined) value = rule.default;
      else if (required.includes(key)) throw toolError(`Argumen "${key}" wajib diisi.`);
      else continue;
    }

    const type = rule?.type;
    if (type === 'number' || type === 'integer') {
      const num = Number(value);
      if (!Number.isFinite(num)) throw toolError(`Argumen "${key}" harus berupa angka.`);
      value = type === 'integer' ? Math.round(num) : num;
      if (typeof rule.minimum === 'number' && value < rule.minimum) value = rule.minimum;
      if (typeof rule.maximum === 'number' && value > rule.maximum) value = rule.maximum;
    } else if (type === 'boolean') {
      value = value === true || value === 'true' || value === 1;
    } else if (type === 'string') {
      value = String(value);
      if (rule.maxLength && value.length > rule.maxLength) value = value.slice(0, rule.maxLength);
    } else if (type === 'array' && !Array.isArray(value)) {
      value = [value];
    } else if (type === 'object' && (typeof value !== 'object' || Array.isArray(value))) {
      throw toolError(`Argumen "${key}" harus berupa objek.`);
    }

    if (Array.isArray(rule?.enum) && rule.enum.length > 0 && !rule.enum.includes(value)) {
      throw toolError(`Argumen "${key}" harus salah satu dari: ${rule.enum.join(', ')}.`);
    }

    cleaned[key] = value;
  }

  return cleaned;
}

/* ------------------------------------------------------------------ */
/* Calculator: parser aritmetika aman (tanpa eval)                     */
/* ------------------------------------------------------------------ */

const CALC_FUNCTIONS = {
  abs: Math.abs,
  ceil: Math.ceil,
  floor: Math.floor,
  round: Math.round,
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  log: Math.log,
  log10: Math.log10,
  exp: Math.exp,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  min: (...a) => Math.min(...a),
  max: (...a) => Math.max(...a),
  pow: (a, b) => Math.pow(a, b),
};

const CALC_CONSTANTS = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };

export function evaluateExpression(expression) {
  const input = String(expression || '').replace(/\s+/g, ' ').trim();
  if (!input) throw toolError('Ekspresi kosong.');
  if (input.length > 200) throw toolError('Ekspresi terlalu panjang (maks 200 karakter).');

  // Normalisasi simbol yang lazim ditulis model
  const normalized = input
    .replace(/×/g, '*')
    .replace(/÷/g, '/')
    .replace(/π/g, 'pi')
    // Koma desimal gaya Indonesia ("1,5" -> "1.5"); titik tetap desimal
    .replace(/(\d),(\d{1,2})(?!\d)/g, '$1.$2')
    .replace(/\^/g, '**');

  let index = 0;

  const peek = () => normalized[index];
  const eat = (token) => {
    if (normalized.startsWith(token, index)) {
      index += token.length;
      return true;
    }
    return false;
  };
  const skipSpace = () => {
    while (normalized[index] === ' ') index += 1;
  };

  function parseExpression() {
    let value = parseTerm();
    for (;;) {
      skipSpace();
      if (eat('+')) value += parseTerm();
      else if (eat('-')) value -= parseTerm();
      else return value;
    }
  }

  function parseTerm() {
    let value = parseUnary();
    for (;;) {
      skipSpace();
      if (eat('*')) value *= parseUnary();
      else if (eat('/')) {
        const divisor = parseUnary();
        if (divisor === 0) throw toolError('Pembagian dengan nol tidak diperbolehkan.');
        value /= divisor;
      } else if (eat('%')) {
        const divisor = parseUnary();
        if (divisor === 0) throw toolError('Modulo dengan nol tidak diperbolehkan.');
        value %= divisor;
      } else return value;
    }
  }

  function parseUnary() {
    skipSpace();
    if (eat('-')) return -parseUnary();
    if (eat('+')) return parseUnary();
    return parsePower();
  }

  function parsePower() {
    const base = parsePrimary();
    skipSpace();
    if (eat('**')) return Math.pow(base, parseUnary());
    return base;
  }

  function parsePrimary() {
    skipSpace();
    if (eat('(')) {
      const value = parseExpression();
      skipSpace();
      if (!eat(')')) throw toolError('Tanda kurung tidak seimbang.');
      return value;
    }

    const numberMatch = /^\d+(\.\d+)?|^\.\d+/.exec(normalized.slice(index));
    if (numberMatch) {
      index += numberMatch[0].length;
      return Number(numberMatch[0]);
    }

    const nameMatch = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(normalized.slice(index));
    if (nameMatch) {
      const name = nameMatch[0].toLowerCase();
      index += nameMatch[0].length;

      if (Object.hasOwn(CALC_CONSTANTS, name)) return CALC_CONSTANTS[name];

      const fn = CALC_FUNCTIONS[name];
      if (!fn) throw toolError(`Fungsi atau konstanta "${name}" tidak dikenal.`);

      skipSpace();
      if (!eat('(')) throw toolError(`Fungsi ${name} harus dipanggil dengan tanda kurung.`);
      const args = [];
      skipSpace();
      if (!eat(')')) {
        for (;;) {
          args.push(parseExpression());
          skipSpace();
          if (eat(',')) continue;
          if (eat(')')) break;
          throw toolError('Argumen fungsi tidak valid.');
        }
      }
      return fn(...args);
    }

    throw toolError(`Karakter tidak valid pada posisi ${index}: "${normalized.slice(index, index + 8)}".`);
  }

  const result = parseExpression();
  skipSpace();
  if (index < normalized.length) {
    throw toolError(`Sisa ekspresi tidak terbaca: "${normalized.slice(index)}".`);
  }
  if (!Number.isFinite(result)) throw toolError('Hasil bukan angka valid.');
  return result;
}

/* ------------------------------------------------------------------ */
/* Konversi satuan                                                     */
/* ------------------------------------------------------------------ */

const UNIT_TABLE = {
  length: {
    base: 'm',
    units: {
      mm: 0.001, cm: 0.01, m: 1, km: 1000, in: 0.0254, inch: 0.0254,
      ft: 0.3048, kaki: 0.3048, yd: 0.9144, mi: 1609.344, mil: 1609.344, nmi: 1852,
    },
  },
  mass: {
    base: 'kg',
    units: {
      mg: 1e-6, g: 0.001, kg: 1, ton: 1000, quintal: 100, oz: 0.028349523125,
      lb: 0.45359237, pon: 0.45359237, st: 6.35029318,
    },
  },
  volume: {
    base: 'l',
    units: {
      ml: 0.001, l: 1, liter: 1, m3: 1000, gal: 3.785411784, qt: 0.946352946,
      pt: 0.473176473, cup: 0.2365882365, floz: 0.0295735295625, tbsp: 0.0147867647813,
    },
  },
  data: {
    base: 'b',
    units: {
      b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4,
      kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
    },
  },
  speed: {
    base: 'm/s',
    units: { 'm/s': 1, 'km/h': 1 / 3.6, kph: 1 / 3.6, mph: 0.44704, knot: 0.514444, 'ft/s': 0.3048 },
  },
  time: {
    base: 's',
    units: { ms: 0.001, s: 1, detik: 1, menit: 60, min: 60, jam: 3600, h: 3600, hari: 86400, d: 86400, minggu: 604800 },
  },
};

const TEMP_UNITS = ['c', 'celsius', 'f', 'fahrenheit', 'k', 'kelvin', 'r', 'rankine'];

function convertTemperature(value, from, to) {
  const toCelsius = () => {
    if (from === 'c') return value;
    if (from === 'f') return (value - 32) * (5 / 9);
    if (from === 'k') return value - 273.15;
    return (value - 491.67) * (5 / 9); // rankine
  };
  const celsius = toCelsius();
  if (to === 'c') return celsius;
  if (to === 'f') return celsius * (9 / 5) + 32;
  if (to === 'k') return celsius + 273.15;
  return (celsius + 273.15) * (9 / 5);
}

export function convertUnits(value, fromRaw, toRaw) {
  const from = String(fromRaw || '').toLowerCase().trim();
  const to = String(toRaw || '').toLowerCase().trim();
  const num = Number(value);
  if (!Number.isFinite(num)) throw toolError('Nilai yang dikonversi harus berupa angka.');
  if (!from || !to) throw toolError('Satuan "from" dan "to" wajib diisi.');

  const norm = (unit) => (unit === 'celsius' ? 'c' : unit === 'fahrenheit' ? 'f' : unit === 'kelvin' ? 'k' : unit === 'rankine' ? 'r' : unit);

  if (TEMP_UNITS.includes(from) && TEMP_UNITS.includes(to)) {
    const result = convertTemperature(num, norm(from), norm(to));
    return { value: Number(result.toFixed(6)), from, to, category: 'temperature' };
  }

  for (const [category, table] of Object.entries(UNIT_TABLE)) {
    if (table.units[from] !== undefined && table.units[to] !== undefined) {
      const inBase = num * table.units[from];
      const result = inBase / table.units[to];
      return {
        value: Number(result.toPrecision(10)),
        from,
        to,
        category,
        base_unit: table.base,
      };
    }
  }

  throw toolError(`Konversi "${from}" → "${to}" tidak didukung.`);
}

/* ------------------------------------------------------------------ */
/* HTTP connector guard (anti SSRF)                                    */
/* ------------------------------------------------------------------ */

const BLOCKED_HOSTNAMES = new Set([
  'localhost', 'localhost.localdomain', 'metadata', 'metadata.google.internal',
  'instance-data', 'kubernetes.default',
]);

function isPrivateIpv4(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const [a, b] = [Number(match[1]), Number(match[2])];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast/reserved
  return false;
}

function isPrivateIpv6(host) {
  const clean = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (clean === '::1' || clean === '::') return true;
  if (clean.startsWith('fc') || clean.startsWith('fd')) return true;
  if (clean.startsWith('fe8') || clean.startsWith('fe9') || clean.startsWith('fea') || clean.startsWith('feb')) return true;
  if (clean.startsWith('::ffff:')) return isPrivateIpv4(clean.slice(7));
  return false;
}

export function parseAllowedHosts(raw = process.env.LLM_TOOL_HTTP_ALLOW_HOSTS) {
  if (!raw) return null; // null = belum dikonfigurasi => semua host ditolak
  return String(raw)
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

export function assertPublicHttpUrl(rawUrl, allowedHosts) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw toolError(`URL tidak valid: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw toolError('Hanya URL http/https yang diizinkan.');
  }
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.local') || host.endsWith('.internal')) {
    throw toolError(`Host "${host}" diblokir oleh kebijakan keamanan.`);
  }
  if (isPrivateIpv4(host) || isPrivateIpv6(host)) {
    throw toolError(`Alamat IP privat/link-local "${host}" diblokir oleh kebijakan keamanan.`);
  }
  if (allowedHosts) {
    const allowed = allowedHosts.some((entry) => host === entry || host.endsWith(`.${entry}`));
    if (!allowed) {
      throw toolError(
        `Host "${host}" tidak ada di allowlist. Tambahkan ke env LLM_TOOL_HTTP_ALLOW_HOSTS bila memang diinginkan.`
      );
    }
  }
  return url;
}

async function fetchJson(url, options = {}, maxBytes = MAX_HTTP_BYTES) {
  const timeoutMs = Math.min(20000, Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS));
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
    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.length;
        text += decoder.decode(value, { stream: true });
        if (bytes >= maxBytes) {
          try {
            await reader.cancel();
          } catch {}
          text += `\n… [respons dipotong pada ${maxBytes} byte]`;
          break;
        }
      }
    }

    return { status: response.status, ok: response.ok, contentType: response.headers.get('content-type') || '', text };
  } catch (err) {
    if (err.name === 'AbortError') throw toolError(`Permintaan ke ${url} melewati batas waktu ${timeoutMs} ms.`, 504);
    throw toolError(`Gagal menghubungi ${url}: ${err.message}`, 502);
  } finally {
    clearTimeout(timer);
  }
}

export function parseMaybeJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function pickPath(value, pathExpression) {
  if (!pathExpression) return value;
  return String(pathExpression)
    .split('.')
    .filter(Boolean)
    .reduce((acc, key) => {
      if (acc === null || acc === undefined) return undefined;
      if (Array.isArray(acc) && /^\d+$/.test(key)) return acc[Number(key)];
      return acc[key];
    }, value);
}

/* ------------------------------------------------------------------ */
/* Definisi tool bawaan                                                */
/* ------------------------------------------------------------------ */

const BUILTIN_TOOL_SPECS = [
  {
    name: 'get_current_time',
    description:
      'Mengambil tanggal dan jam saat ini. Gunakan bila pengguna menanyakan waktu, tanggal, hari, atau "sekarang".',
    parameters: {
      type: 'object',
      properties: {
        timezone: {
          type: 'string',
          description: 'Zona waktu IANA, contoh: Asia/Jakarta. Default Asia/Jakarta.',
          default: 'Asia/Jakarta',
        },
      },
    },
    handler(args) {
      const timezone = args.timezone || 'Asia/Jakarta';
      let formatter;
      try {
        formatter = new Intl.DateTimeFormat('id-ID', {
          timeZone: timezone,
          dateStyle: 'full',
          timeStyle: 'long',
        });
      } catch {
        throw toolError(`Zona waktu "${timezone}" tidak dikenal.`);
      }
      const now = new Date();
      return {
        iso: now.toISOString(),
        timezone,
        formatted: formatter.format(now),
        day: new Intl.DateTimeFormat('id-ID', { timeZone: timezone, weekday: 'long' }).format(now),
        unix: Math.floor(now.getTime() / 1000),
      };
    },
  },
  {
    name: 'calculate',
    description:
      'Menghitung ekspresi matematika (aritmetika, pangkat, akar, fungsi seperti sqrt/min/max). Gunakan untuk perhitungan yang harus akurat.',
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: 'Ekspresi matematika, contoh: "(12.5 * 4) + sqrt(81)" atau "2^10".',
          maxLength: 200,
        },
      },
      required: ['expression'],
    },
    handler(args) {
      const value = evaluateExpression(args.expression);
      return { expression: args.expression, result: value };
    },
  },
  {
    name: 'convert_units',
    description:
      'Mengonversi satuan: panjang, massa, volume, data, kecepatan, waktu, dan suhu (c/f/k/r).',
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'number', description: 'Nilai yang akan dikonversi.' },
        from: { type: 'string', description: 'Satuan asal, contoh: km, lb, c, mb.' },
        to: { type: 'string', description: 'Satuan tujuan, contoh: mi, kg, f, gb.' },
      },
      required: ['value', 'from', 'to'],
    },
    handler(args) {
      return convertUnits(args.value, args.from, args.to);
    },
  },
  {
    name: 'http_fetch',
    description:
      'Mengambil data dari API HTTP publik (JSON/teks). Butuh allowlist host di env LLM_TOOL_HTTP_ALLOW_HOSTS.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL http/https yang akan diambil.' },
        method: { type: 'string', enum: ['GET', 'POST'], default: 'GET' },
        headers: { type: 'object', description: 'Header tambahan (opsional).' },
        body: { type: 'string', description: 'Body mentah untuk POST (opsional).' },
      },
      required: ['url'],
    },
    requiresAllowlist: true,
    async handler(args, ctx) {
      const allowedHosts = parseAllowedHosts(ctx?.allowedHttpHosts ?? process.env.LLM_TOOL_HTTP_ALLOW_HOSTS);
      const url = assertPublicHttpUrl(args.url, allowedHosts);
      const headers = { 'User-Agent': 'vercel-local-llm/1.1', Accept: 'application/json, text/plain;q=0.9' };
      if (args.headers && typeof args.headers === 'object') {
        for (const [key, value] of Object.entries(args.headers)) {
          if (/^[a-z0-9-]+$/i.test(key)) headers[key] = String(value);
        }
      }
      if (args.body && args.method === 'POST' && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }
      const result = await fetchJson(url.toString(), {
        method: args.method || 'GET',
        headers,
        body: args.method === 'POST' ? args.body : undefined,
      });
      const json = parseMaybeJson(result.text);
      return {
        status: result.status,
        content_type: result.contentType,
        data: json ?? truncate(result.text, 3000),
      };
    },
  },
  {
    name: 'wikipedia_summary',
    description:
      'Mengambil ringkasan artikel Wikipedia. Berguna untuk fakta umum, tokoh, tempat, atau sejarah.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Judul artikel, contoh: "Vercel" atau "Bandung".' },
        lang: {
          type: 'string',
          description: 'Kode bahasa Wikipedia: id, en, jv, su. Default id.',
          default: 'id',
        },
      },
      required: ['title'],
    },
    async handler(args, ctx) {
      const lang = String(args.lang || 'id').toLowerCase();
      if (!/^[a-z]{2,3}(-[a-z]{2,8})?$/.test(lang)) throw toolError('Kode bahasa Wikipedia tidak valid.');
      const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
        String(args.title).replace(/\s+/g, '_')
      )}`;
      const allowedHosts = ctx?.allowedHttpHosts ?? process.env.LLM_TOOL_HTTP_ALLOW_HOSTS;
      // wikipedia.org selalu diizinkan untuk tool ini (host tetap, bukan input pengguna)
      assertPublicHttpUrl(url, allowedHosts ? [...parseAllowedHosts(allowedHosts), 'wikipedia.org'] : null);
      const result = await fetchJson(url, { headers: { Accept: 'application/json' } });
      const json = parseMaybeJson(result.text);
      if (!result.ok) {
        throw toolError(`Wikipedia menolak permintaan (HTTP ${result.status}).`, 502);
      }
      return {
        title: json?.title ?? args.title,
        lang,
        extract: json?.extract ?? truncate(result.text, 1500),
        url: json?.content_urls?.desktop?.page ?? null,
      };
    },
  },
  {
    name: 'llm_runtime_info',
    description:
      'Mengambil status runtime LLM di server (model aktif, RAM, region Vercel). Gunakan bila pengguna bertanya tentang server atau model.',
    parameters: { type: 'object', properties: {} },
    async handler(_args, ctx) {
      if (typeof ctx?.health !== 'function') throw toolError('Informasi runtime tidak tersedia di konteks ini.', 501);
      const health = await ctx.health();
      return {
        status: health.status,
        active_model: health.active_model,
        region: health.runtime?.vercel_region ?? null,
        rss_mb: health.runtime?.rss_mb ?? null,
        cpu_cores: health.runtime?.cpu_cores ?? null,
        requests_served: health.stats?.requestsServed ?? 0,
      };
    },
  },
];

/* ------------------------------------------------------------------ */
/* Connector dari environment (LLM_CONNECTORS)                         */
/* ------------------------------------------------------------------ */

function substituteTemplate(template, values, env) {
  return String(template ?? '').replace(/\{\{\s*(env:)?([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, isEnv, key) => {
    if (isEnv) {
      const envValue = env?.[key];
      return envValue === undefined ? '' : String(envValue);
    }
    const value = values[key];
    if (value === undefined || value === null) return '';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  });
}

function substituteDeep(node, values, env) {
  if (typeof node === 'string') return substituteTemplate(node, values, env);
  if (Array.isArray(node)) return node.map((item) => substituteDeep(item, values, env));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(node)) out[key] = substituteDeep(value, values, env);
    return out;
  }
  return node;
}

function normalizeConnectorSpec(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) return null;
  const request = raw.request || {};
  const url = String(request.url || raw.url || '').trim();
  if (!url) return null;

  return {
    name,
    description: String(raw.description || `Connector HTTP eksternal (${name}).`).slice(0, 500),
    parameters: raw.parameters && typeof raw.parameters === 'object'
      ? raw.parameters
      : { type: 'object', properties: {} },
    source: 'connector',
    request: {
      url,
      method: String(request.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET',
      headers: request.headers && typeof request.headers === 'object' ? request.headers : undefined,
      body: request.body,
      timeoutMs: Number(request.timeout_ms || raw.timeout_ms) || DEFAULT_TIMEOUT_MS,
    },
    responsePath: raw.response_path || null,
    maxChars: Number(raw.max_chars) > 0 ? Number(raw.max_chars) : 3000,
    requiresAllowlist: true,
    index,
    async handler(args, ctx) {
      const allowedHosts = ctx?.allowedHttpHosts ?? process.env.LLM_TOOL_HTTP_ALLOW_HOSTS;
      const env = ctx?.env ?? process.env;
      const urlString = substituteTemplate(this.request.url, args, env);
      const url = assertPublicHttpUrl(urlString, parseAllowedHosts(allowedHosts));
      const headers = substituteDeep(this.request.headers || {}, args, env);
      const bodyTemplate = this.request.body;
      let body;
      if (this.request.method === 'POST' && bodyTemplate !== undefined) {
        body = typeof bodyTemplate === 'string'
          ? substituteTemplate(bodyTemplate, args, env)
          : JSON.stringify(substituteDeep(bodyTemplate, args, env));
        if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
      }

      const result = await fetchJson(url.toString(), {
        method: this.request.method,
        headers,
        body,
        timeoutMs: this.request.timeoutMs,
      });
      if (!result.ok) {
        throw toolError(`Connector ${this.name} gagal: HTTP ${result.status}.`, 502);
      }
      const parsed = parseMaybeJson(result.text);
      const selected = pickPath(parsed ?? result.text, this.responsePath);
      return {
        connector: this.name,
        status: result.status,
        data: truncateAny(selected, this.maxChars),
      };
    },
  };
}

export function loadConnectors({ env = process.env } = {}) {
  const raw = env.LLM_CONNECTORS;
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const e = toolError(`Env LLM_CONNECTORS bukan JSON valid: ${err.message}`);
    e.connectorConfigError = true;
    throw e;
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.connectors) ? parsed.connectors : [];
  return list.map((item, index) => normalizeConnectorSpec(item, index)).filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

function parseDisabledNames(env = process.env) {
  return String(env.LLM_TOOLS_DISABLED || '')
    .split(',')
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);
}

export function getToolRegistry({ env = process.env, includeConnectors = true } = {}) {
  const disabled = new Set(parseDisabledNames(env));
  const registry = new Map();

  for (const spec of BUILTIN_TOOL_SPECS) {
    if (disabled.has(spec.name.toLowerCase())) continue;
    registry.set(spec.name, { ...spec, source: 'builtin' });
  }

  if (includeConnectors) {
    try {
      for (const spec of loadConnectors({ env })) {
        if (disabled.has(spec.name.toLowerCase())) continue;
        registry.set(spec.name, spec);
      }
    } catch (err) {
      // Konfigurasi connector rusak tidak boleh mematikan tool bawaan
      registry.connectorError = err?.message || 'LLM_CONNECTORS tidak valid.';
    }
  }

  return registry;
}

/** Metadata publik (tanpa handler) untuk endpoint /api/tools & prompt model. */
export function listTools({ env = process.env, names = null, includeConnectors = true } = {}) {
  const registry = getToolRegistry({ env, includeConnectors });
  const selected = names ? new Set(names) : null;
  const allowHostsConfigured = Boolean(env.LLM_TOOL_HTTP_ALLOW_HOSTS);

  return [...registry.values()]
    .filter((spec) => !selected || selected.has(spec.name))
    .map((spec) => ({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      source: spec.source,
      server_side: true,
      available: spec.requiresAllowlist ? allowHostsConfigured : true,
      requires_allowlist: Boolean(spec.requiresAllowlist),
    }));
}

export function toOpenAIToolSchema(spec) {
  return {
    type: 'function',
    function: {
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
    },
  };
}

/** Ubah input `tools` (OpenAI) / `functions` (legacy) menjadi daftar tool internal. */
export function normalizeToolsInput(tools, functions) {
  const collected = [];

  if (Array.isArray(tools)) {
    for (const item of tools) {
      const fn = item?.type === 'function' ? item.function : item?.function || null;
      if (!fn?.name) continue;
      collected.push({
        name: String(fn.name),
        description: String(fn.description || ''),
        parameters: fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} },
      });
    }
  }

  if (Array.isArray(functions)) {
    for (const fn of functions) {
      if (!fn?.name) continue;
      collected.push({
        name: String(fn.name),
        description: String(fn.description || ''),
        parameters: fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} },
      });
    }
  }

  const seen = new Set();
  return collected.filter((tool) => {
    if (seen.has(tool.name)) return false;
    seen.add(tool.name);
    return true;
  });
}

export function resolveToolChoice(toolChoice, availableNames) {
  if (toolChoice === 'none') return { mode: 'none', only: [] };
  if (toolChoice && typeof toolChoice === 'object') {
    const forced = toolChoice.function?.name || toolChoice.name;
    if (forced) return { mode: 'required', only: [String(forced)] };
  }
  if (toolChoice === 'required' || toolChoice === 'any') {
    return { mode: 'required', only: availableNames.slice() };
  }
  return { mode: 'auto', only: [] };
}

/* ------------------------------------------------------------------ */
/* Eksekusi tool                                                       */
/* ------------------------------------------------------------------ */

export async function executeToolCall({ name, args, ctx = {}, env = process.env }) {
  const registry = ctx.registry || getToolRegistry({ env });
  const spec = registry.get(name);
  const startedAt = nowMs();

  if (!spec) {
    return {
      ok: false,
      name,
      error: `Tool "${name}" tidak tersedia di server.`,
      available: [...registry.keys()],
      duration_ms: nowMs() - startedAt,
      server_side: false,
    };
  }

  try {
    if (spec.requiresAllowlist && !(ctx.allowedHttpHosts ?? env.LLM_TOOL_HTTP_ALLOW_HOSTS) && spec.source === 'connector') {
      throw toolError(
        `Connector ${spec.name} memerlukan allowlist. Set env LLM_TOOL_HTTP_ALLOW_HOSTS berisi host connector tersebut.`,
        403
      );
    }

    const validated = validateArguments(spec.parameters, args);
    const result = await spec.handler.call(spec, validated, { ...ctx, env });
    return {
      ok: true,
      name: spec.name,
      source: spec.source,
      arguments: validated,
      result,
      duration_ms: nowMs() - startedAt,
      server_side: true,
    };
  } catch (err) {
    return {
      ok: false,
      name: spec.name,
      source: spec.source,
      arguments: args ?? {},
      error: err?.message || 'Eksekusi tool gagal.',
      duration_ms: nowMs() - startedAt,
      server_side: true,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Prompt contract & parser keluaran model                             */
/* ------------------------------------------------------------------ */

export function buildToolInstructions(toolSpecs, { required = false } = {}) {
  if (!Array.isArray(toolSpecs) || toolSpecs.length === 0) return '';

  const lines = toolSpecs.map((spec) => {
    const schema = JSON.stringify(spec.parameters ?? { type: 'object', properties: {} });
    return `- ${spec.name}: ${spec.description} (skema argumen: ${schema})`;
  });

  return [
    'TOOL CALLING',
    'Kamu punya akses ke tool berikut:',
    ...lines,
    '',
    'ATURAN WAJIB:',
    '1. Bila butuh data nyata, perhitungan akurat, atau akses API, panggil tool.',
    `2. Format panggilan tool HARUS tepat seperti ini (tanpa teks lain di pesan itu):`,
    `${TOOL_CALL_OPEN}{"name":"nama_tool","arguments":{"param":"nilai"}}${TOOL_CALL_CLOSE}`,
    '3. Setelah memanggil tool, tunggu hasil dikirim sebagai pesan role "tool". JANGAN mengarang hasil.',
    '4. Bila tidak perlu tool, jawab langsung dengan teks biasa tanpa blok tool_call.',
    '5. Satu pesan maksimal memuat satu panggilan tool. Gunakan argumen sesuai skema.',
    required ? '6. Pada permintaan ini kamu WAJIB memanggil salah satu tool di atas.' : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function coerceArguments(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw === 'string') {
    const parsed = parseMaybeJson(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  }
  return typeof raw === 'object' ? raw : {};
}

function pushCall(list, name, args, raw) {
  const cleanName = String(name || '').trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(cleanName)) return;
  list.push({ name: cleanName, arguments: coerceArguments(args), raw });
}

/** Mencari objek JSON seimbang di dalam teks (mengabaikan string literal). */
function findJsonObjects(text) {
  const results = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === '}') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          const raw = text.slice(start, i + 1);
          const parsed = parseMaybeJson(raw);
          if (parsed && typeof parsed === 'object') results.push({ raw, parsed, index: start });
        }
      }
    }
  }
  return results;
}

/**
 * Mengurai panggilan tool dari teks keluaran model. Mendukung:
 *  - <tool_call>{...}</tool_call>
 *  - blok ```json {...} ```
 *  - JSON telanjang {"name":..., "arguments":...}
 *  - bentuk {"tool_calls":[{"function":{"name":...}}]}
 */
export function parseToolCalls(text) {
  const input = String(text || '');
  const calls = [];
  if (!input.includes('{')) return calls;

  // 1. Tag <tool_call>…</tool_call>
  const tagRegex = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let tagMatch;
  while ((tagMatch = tagRegex.exec(input)) !== null) {
    const blockRaw = tagMatch[1].trim();
    const objects = findJsonObjects(blockRaw);
    const parsed = parseMaybeJson(blockRaw);
    if (parsed && typeof parsed === 'object') objects.push({ raw: blockRaw, parsed });
    for (const { raw, parsed: obj } of objects) {
      if (obj?.name) pushCall(calls, obj.name, obj.arguments ?? obj.parameters ?? obj.args, raw);
      else if (Array.isArray(obj?.tool_calls)) {
        for (const call of obj.tool_calls) {
          pushCall(calls, call?.function?.name ?? call?.name, call?.function?.arguments ?? call?.arguments, raw);
        }
      }
    }
  }

  // 2. Objek JSON bebas (termasuk di dalam blok kode ```json)
  for (const { raw, parsed } of findJsonObjects(input)) {
    if (calls.some((call) => call.raw === raw)) continue;
    if (parsed?.name && typeof parsed.name === 'string') {
      pushCall(calls, parsed.name, parsed.arguments ?? parsed.parameters ?? parsed.args, raw);
    } else if (Array.isArray(parsed?.tool_calls)) {
      for (const call of parsed.tool_calls) {
        pushCall(calls, call?.function?.name ?? call?.name, call?.function?.arguments ?? call?.arguments, raw);
      }
    } else if (parsed.type === 'function' && parsed.function?.name) {
      pushCall(calls, parsed.function.name, parsed.function.arguments, raw);
    }
  }

  // Deduplikasi berdasarkan raw + nama
  const seen = new Set();
  return calls.filter((call) => {
    const key = `${call.name}::${call.raw}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Membuang blok panggilan tool dari teks agar tidak tampil sebagai jawaban. */
export function stripToolCalls(text, calls = parseToolCalls(text)) {
  let output = String(text || '');
  if (!output) return '';

  output = output.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '');
  if (calls.length > 0) {
    for (const call of calls) {
      if (!call.raw) continue;
      output = output.split(call.raw).join('');
    }
  }
  // Bersihkan pagar kode yang menjadi kosong
  output = output.replace(/```(?:json|tool|tool_call)?\s*```/gi, '');
  return output.trim();
}

export const TOOL_CALL_MARKERS = [TOOL_CALL_OPEN, '```json', '"tool_calls"', '"name":', '"name" :'];

export function detectToolCallStart(text) {
  const haystack = String(text || '');
  let best = -1;
  for (const marker of TOOL_CALL_MARKERS) {
    const index = haystack.indexOf(marker);
    if (index >= 0 && (best === -1 || index < best)) best = index;
  }
  return best;
}

export const __internals = {
  BUILTIN_TOOL_SPECS,
  findJsonObjects,
  truncate,
  isPrivateIpv4,
  isPrivateIpv6,
  substituteTemplate,
};
