import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Sumber penyimpanan model GGUF.
 *
 * Serverless Vercel tetap harus punya file GGUF di disk lokal (/tmp) sebelum
 * llama.cpp bisa memuatnya. Yang bisa diperbaiki adalah DARI MANA file itu
 * diambil: bucket S3 sendiri (satu region, tanpa rate limit Hugging Face,
 * bisa privat) atau Vercel Blob. Hugging Face tetap dipakai sebagai fallback.
 *
 * Tidak ada dependency baru: SigV4 dihitung manual dengan node:crypto.
 */

export const STORAGE_SOURCES = ['s3', 'blob', 'url', 'huggingface'];
export const STORAGE_MODES = ['auto', ...STORAGE_SOURCES];
const DEFAULT_PREFIX = 'models/';
const DEFAULT_PRESIGN_TTL = 900;

/* ------------------------------------------------------------- utilitas SigV4 */

function encodeRfc3986(value) {
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

const sha256Hex = (input) => crypto.createHash('sha256').update(input, 'utf8').digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();

/** 2026-10-28T12:00:00.000Z -> 20261028T120000Z */
function amzDateTime(date = new Date()) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function guessRegion(endpointHost = '') {
  if (endpointHost.includes('.r2.cloudflarestorage.com')) return 'auto';
  const match = endpointHost.match(/s3[.-]([a-z0-9-]+)\.amazonaws\.com/);
  return match ? match[1] : '';
}

function joinUrl(base, key) {
  return `${String(base).replace(/\/+$/, '')}/${key.replace(/^\/+/, '')}`;
}

/** URL objek S3 (path-style untuk endpoint kustom, virtual-host untuk AWS). */
export function buildS3ObjectUrl({
  bucket,
  key,
  region = 'us-east-1',
  endpoint = '',
  forcePathStyle,
}) {
  if (!bucket) throw new Error('LLM_S3_BUCKET belum diisi');
  if (!key) throw new Error('Nama objek S3 kosong');

  const base = new URL(endpoint || `https://s3.${region}.amazonaws.com`);
  const usePathStyle =
    forcePathStyle === undefined
      ? !/amazonaws\.com$/i.test(base.host) && !/amazonaws\.com:/i.test(base.host)
      : Boolean(forcePathStyle);

  const prefix = base.pathname.replace(/\/+$/, '');
  const encodedKey = String(key)
    .split('/')
    .map(encodeRfc3986)
    .join('/');

  if (usePathStyle) {
    return {
      url: `${base.protocol}//${base.host}${prefix}/${encodeRfc3986(bucket)}/${encodedKey}`,
      host: base.host,
      path: `${prefix}/${encodeRfc3986(bucket)}/${encodedKey}`,
      pathStyle: true,
    };
  }

  return {
    url: `${base.protocol}//${bucket}.${base.host}${prefix}/${encodedKey}`,
    host: `${bucket}.${base.host}`,
    path: `${prefix}/${encodedKey}`,
    pathStyle: false,
  };
}

/**
 * Presigned GET (SigV4 query auth, UNSIGNED-PAYLOAD).
 * Cukup untuk objek privat tanpa membocorkan kredensial ke klien.
 */
export function presignS3GetUrl(options) {
  const {
    accessKeyId,
    secretAccessKey,
    sessionToken,
    region = 'us-east-1',
    expiresIn = DEFAULT_PRESIGN_TTL,
    now = new Date(),
  } = options;

  if (!accessKeyId || !secretAccessKey) {
    throw new Error('Kredensial S3 (LLM_S3_ACCESS_KEY_ID / LLM_S3_SECRET_ACCESS_KEY) belum diisi');
  }

  const { url, host, path: canonicalPath } = buildS3ObjectUrl(options);
  const dateTime = amzDateTime(now);
  const dateStamp = dateTime.slice(0, 8);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;

  const params = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${accessKeyId}/${scope}`],
    ['X-Amz-Date', dateTime],
    ['X-Amz-Expires', String(expiresIn)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  if (sessionToken) params.push(['X-Amz-Security-Token', sessionToken]);
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const canonicalQuery = params
    .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`)
    .join('&');

  const canonicalRequest = [
    'GET',
    canonicalPath,
    canonicalQuery,
    `host:${host}`,
    '',
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    dateTime,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), 's3'),
    'aws4_request'
  );
  const signature = hmac(signingKey, stringToSign).toString('hex');

  return {
    url: `${url}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    signature,
    expiresAt: now.getTime() + Number(expiresIn) * 1000,
    canonicalRequest,
    stringToSign,
    scope,
  };
}

/* --------------------------------------------------------------- konfigurasi */

export function readStorageConfig(env = process.env) {
  const endpoint = String(env.LLM_S3_ENDPOINT || '').trim();
  const host = endpoint ? new URL(endpoint).host : '';
  const region = (env.LLM_S3_REGION || guessRegion(host) || 'us-east-1').trim();

  const s3 = {
    bucket: String(env.LLM_S3_BUCKET || '').trim(),
    region,
    endpoint,
    accessKeyId: String(env.LLM_S3_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID || '').trim(),
    secretAccessKey: String(env.LLM_S3_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY || '').trim(),
    sessionToken: String(env.LLM_S3_SESSION_TOKEN || env.AWS_SESSION_TOKEN || '').trim(),
    prefix: env.LLM_S3_PREFIX === undefined ? DEFAULT_PREFIX : String(env.LLM_S3_PREFIX),
    publicBaseUrl: String(env.LLM_S3_PUBLIC_BASE_URL || '').trim(),
    forcePathStyle: false,
    expiresIn: Math.min(604800, Math.max(60, Number(env.LLM_S3_PRESIGN_TTL) || DEFAULT_PRESIGN_TTL)),
  };

  const hasPathStyleEnv = env.LLM_S3_FORCE_PATH_STYLE !== undefined && env.LLM_S3_FORCE_PATH_STYLE !== '';
  s3.forcePathStyle = hasPathStyleEnv
    ? parseBool(env.LLM_S3_FORCE_PATH_STYLE, false)
    : endpoint
      ? !/amazonaws\.com/i.test(host)
      : false;

  const blob = {
    baseUrl: String(env.LLM_BLOB_BASE_URL || '').trim(),
    token: String(env.BLOB_READ_WRITE_TOKEN || '').trim(),
    private: parseBool(env.LLM_BLOB_PRIVATE, false),
  };

  const generic = { baseUrl: String(env.LLM_MODEL_BASE_URL || '').trim() };

  const modeRaw = String(env.LLM_MODEL_SOURCE || 'auto').trim().toLowerCase();
  const mode = STORAGE_MODES.includes(modeRaw) ? modeRaw : 'auto';

  return { mode, modeRequested: modeRaw, s3, blob, generic };
}

/** true bila ada sumber selain Hugging Face yang aktif. */
function s3Configured(s3) {
  return Boolean(s3.bucket && (s3.publicBaseUrl || (s3.accessKeyId && s3.secretAccessKey)));
}

export function s3KeyFor(spec, s3) {
  const prefix = String(s3.prefix || '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  return prefix ? `${prefix}/${spec.filename}` : spec.filename;
}

function buildS3Source(spec, s3) {
  if (!s3Configured(s3)) return null;
  const key = s3KeyFor(spec, s3);

  if (s3.publicBaseUrl && !(s3.accessKeyId && s3.secretAccessKey)) {
    return {
      source: 's3',
      label: 'S3 (publik/CDN)',
      url: joinUrl(s3.publicBaseUrl, key),
      headers: {},
      key,
    };
  }

  const signed = presignS3GetUrl({ ...s3, key });
  return {
    source: 's3',
    label: `S3 (${s3.bucket})`,
    url: signed.url,
    headers: {},
    key,
    expiresAt: signed.expiresAt,
  };
}

function buildBlobSource(spec, blob) {
  if (!blob.baseUrl) return null;
  const headers =
    blob.private && blob.token ? { Authorization: `Bearer ${blob.token}` } : {};
  return {
    source: 'blob',
    label: 'Vercel Blob',
    url: joinUrl(blob.baseUrl, spec.filename),
    headers,
    key: spec.filename,
  };
}

function buildGenericSource(spec, generic) {
  if (!generic.baseUrl) return null;
  return {
    source: 'url',
    label: 'Base URL kustom',
    url: joinUrl(generic.baseUrl, spec.filename),
    headers: {},
    key: spec.filename,
  };
}

function buildHuggingFaceSource(spec) {
  return {
    source: 'huggingface',
    label: 'Hugging Face',
    url: spec.downloadUrl,
    headers: {},
    key: spec.filename,
  };
}

/**
 * Daftar sumber yang dicoba berurutan untuk satu model.
 * Mode `auto` selalu diakhiri Hugging Face; mode eksplisit tidak fallback.
 */
export function modelSourcePlan(spec, env = process.env) {
  const config = readStorageConfig(env);
  const candidates = {
    s3: () => buildS3Source(spec, config.s3),
    blob: () => buildBlobSource(spec, config.blob),
    url: () => buildGenericSource(spec, config.generic),
    huggingface: () => buildHuggingFaceSource(spec),
  };

  const order =
    config.mode === 'auto'
      ? ['s3', 'blob', 'url', 'huggingface']
      : [config.mode];

  return order.map((name) => candidates[name]()).filter(Boolean);
}

/** Ringkasan aman untuk API/UI: tanpa secret, tanpa tanda tangan URL. */
export function describeModelStorage(env = process.env, catalog = []) {
  const config = readStorageConfig(env);

  const models = catalog.map((spec) => {
    const plan = modelSourcePlan(spec, env);
    const first = plan[0] || null;
    return {
      id: spec.id,
      filename: spec.filename,
      size_mb: spec.sizeMb,
      source: first?.source || null,
      source_label: first?.label || null,
      key: first?.key || null,
      url_preview: first ? redactUrl(first.url) : null,
      fallback_sources: plan.slice(1).map((item) => item.source),
    };
  });

  return {
    mode: config.mode,
    mode_requested: config.modeRequested,
    configured: s3Configured(config.s3) || Boolean(config.blob.baseUrl) || Boolean(config.generic.baseUrl),
    s3: {
      configured: s3Configured(config.s3),
      bucket: config.s3.bucket || null,
      region: config.s3.region,
      endpoint: config.s3.endpoint || null,
      prefix: config.s3.prefix,
      path_style: config.s3.forcePathStyle,
      signing: config.s3.publicBaseUrl && !(config.s3.accessKeyId && config.s3.secretAccessKey)
        ? 'public'
        : 'presigned',
      public_base_url: config.s3.publicBaseUrl || null,
      presign_ttl_seconds: config.s3.expiresIn,
      has_credentials: Boolean(config.s3.accessKeyId && config.s3.secretAccessKey),
    },
    blob: {
      configured: Boolean(config.blob.baseUrl),
      base_url: config.blob.baseUrl || null,
      private: config.blob.private,
      has_token: Boolean(config.blob.token),
    },
    generic: { configured: Boolean(config.generic.baseUrl), base_url: config.generic.baseUrl || null },
    models,
  };
}

/** Buang query (tanda tangan & access key) dari URL sebelum ditampilkan. */
export function redactUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    url.search = '';
    return url.toString();
  } catch {
    return String(rawUrl).split('?')[0];
  }
}

/* ---------------------------------------------------------------- unduhan */

/**
 * Unduh satu sumber ke `destPath` secara atomik (`.part` lalu rename).
 * Dipisah dari llm-engine supaya bisa diuji tanpa node-llama-cpp.
 */
export async function downloadModelFile({
  spec,
  source,
  destPath,
  onProgress,
  fetchImpl = fetch,
  emitIntervalMs = 400,
}) {
  const partPath = `${destPath}.part`;
  const startedAt = Date.now();
  let downloadedBytes = 0;

  try {
    const response = await fetchImpl(source.url, {
      headers: { 'User-Agent': 'vercel-local-llm/1.1', ...(source.headers || {}) },
      redirect: 'follow',
    });

    if (!response.ok || !response.body) {
      const err = new Error(`${source.label}: HTTP ${response.status}`);
      err.sourceFailure = true;
      throw err;
    }

    const totalBytes =
      Number(response.headers.get('content-length')) || spec.sizeMb * 1024 * 1024;

    const nodeStream = Readable.fromWeb(response.body);
    let lastEmit = 0;

    nodeStream.on('data', (chunk) => {
      downloadedBytes += chunk.length;
      const percent =
        totalBytes > 0 ? Math.min(99, Math.round((downloadedBytes / totalBytes) * 100)) : 0;
      const now = Date.now();
      if (onProgress && now - lastEmit >= emitIntervalMs) {
        lastEmit = now;
        try {
          onProgress({
            modelId: spec.id,
            source: source.source,
            downloadedBytes,
            totalBytes,
            percent,
            startedAt,
          });
        } catch {}
      }
    });

    await pipeline(nodeStream, fs.createWriteStream(partPath));
    await fsp.rename(partPath, destPath);

    return {
      source: source.source,
      label: source.label,
      bytes: downloadedBytes,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    await fsp.rm(partPath, { force: true }).catch(() => {});
    if (!err.sourceFailure) err.sourceFailure = true;
    throw err;
  }
}

/**
 * Coba sumber berurutan sampai satu berhasil (fallback antar sumber).
 * `onAttempt` dipanggil sebelum tiap percobaan supaya pemanggil bisa
 * memperbarui status progres.
 */
export async function downloadFromPlan({
  spec,
  sources,
  destPath,
  onProgress,
  onAttempt,
  fetchImpl = fetch,
}) {
  if (!sources || !sources.length) {
    const err = new Error(
      `Tidak ada sumber model aktif untuk "${spec.id}". Isi LLM_S3_BUCKET + kredensial, ` +
        'LLM_BLOB_BASE_URL, atau LLM_MODEL_BASE_URL — atau pakai LLM_MODEL_SOURCE=huggingface.'
    );
    err.statusCode = 501;
    throw err;
  }

  const failures = [];

  for (const source of sources) {
    if (typeof onAttempt === 'function') {
      try {
        onAttempt(source);
      } catch {}
    }
    try {
      const result = await downloadModelFile({ spec, source, destPath, onProgress, fetchImpl });
      return { ...result, attempts: failures.length + 1, failures };
    } catch (err) {
      failures.push(err.message);
    }
  }

  const err = new Error(
    `Gagal mengunduh model "${spec.id}" dari semua sumber. ${failures.join(' | ')}`
  );
  err.statusCode = 502;
  err.failures = failures;
  throw err;
}

/**
 * Cek satu sumber tanpa mengunduh isi: GET 1 byte, ambil total dari Content-Range.
 * Dipakai endpoint /api/storage/check untuk memvalidasi konfigurasi env.
 */
export async function probeModelSource({ source, fetchImpl = fetch, timeoutMs = 8000 }) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(source.url, {
      method: 'GET',
      headers: { ...(source.headers || {}), Range: 'bytes=0-0', 'User-Agent': 'vercel-local-llm/1.1' },
      redirect: 'follow',
      signal: controller.signal,
    });
    const contentRange = response.headers.get('content-range') || '';
    const match = contentRange.match(/\/(\d+)$/);
    const sizeBytes = match
      ? Number(match[1])
      : Number(response.headers.get('content-length')) || null;
    try {
      await response.body?.cancel();
    } catch {}

    return {
      source: source.source,
      ok: response.status === 200 || response.status === 206,
      status: response.status,
      size_mb: sizeBytes ? Math.round(sizeBytes / 1024 / 1024) : null,
      url_preview: redactUrl(source.url),
      duration_ms: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      source: source.source,
      ok: false,
      status: null,
      error: err.name === 'AbortError' ? `timeout ${timeoutMs} ms` : err.message,
      url_preview: redactUrl(source.url),
      duration_ms: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

export const __storageInternals = {
  encodeRfc3986,
  amzDateTime,
  sha256Hex,
  hmac,
  guessRegion,
  joinUrl,
};
