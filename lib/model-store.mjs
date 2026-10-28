import {
  deleteS3Object,
  describeModelStorage,
  listS3Objects,
  probeModelSource,
  putObjectFromSource,
  readStorageConfig,
  s3KeyFor,
  s3Writable,
  presignS3GetUrl,
} from './model-storage.mjs';

/**
 * Layanan "Model Store": katalog model yang bisa disimpan, isi bucket, serta
 * aksi simpan/hapus. Dipakai endpoint /api/store dan UI tab Model Store.
 *
 * Tulis/hapus/daftar hanya didukung untuk S3-compatible (bucket + kredensial).
 * Vercel Blob tetap bisa dipakai sebagai sumber unduhan (baca saja).
 */

export const GGUF_SUFFIX = '.gguf';

export function describeCapabilities(env = process.env) {
  const config = readStorageConfig(env);
  const writable = s3Writable(config);
  const blobReadable = Boolean(config.blob.baseUrl);

  let provider = null;
  if (writable) provider = 's3';
  else if (blobReadable) provider = 'blob';
  else if (config.generic.baseUrl) provider = 'url';

  let reason = null;
  if (!writable) {
    reason = blobReadable
      ? 'Vercel Blob dipakai sebagai sumber unduhan (baca saja). Simpan/hapus berkas dilakukan lewat dashboard Vercel atau `vercel blob put`.'
      : 'Isi LLM_S3_BUCKET + LLM_S3_ACCESS_KEY_ID/SECRET_ACCESS_KEY (atau AWS_ACCESS_KEY_ID/SECRET_ACCESS_KEY) untuk mengelola model di storage.';
  }

  return {
    provider,
    can_save: writable,
    can_delete: writable,
    can_list: writable,
    bucket: config.s3.bucket || null,
    prefix: config.s3.prefix,
    reason,
  };
}

function normalizeKey(key) {
  return String(key || '').replace(/^\/+/, '');
}

export function validateObjectKey(key, env = process.env) {
  const normalized = normalizeKey(key);
  if (!normalized) return { ok: false, message: 'Kunci objek kosong.' };
  if (normalized.length > 512) return { ok: false, message: 'Kunci objek terlalu panjang.' };
  if (!normalized.toLowerCase().endsWith(GGUF_SUFFIX)) {
    return { ok: false, message: 'Hanya berkas .gguf yang boleh dikelola.' };
  }
  if (normalized.split('/').includes('..')) {
    return { ok: false, message: 'Kunci objek tidak valid.' };
  }

  const config = readStorageConfig(env);
  const prefix = String(config.s3.prefix || '');
  if (prefix && !normalized.startsWith(prefix)) {
    return { ok: false, message: `Objek harus berada di dalam prefix "${prefix}".` };
  }
  return { ok: true, key: normalized };
}

function specKey(spec, env) {
  const config = readStorageConfig(env);
  return s3KeyFor(spec, config.s3);
}

/** Manual GET (presigned) untuk satu objek — dipakai UI sebagai tautan unduh. */
export function downloadUrlFor(spec, env = process.env) {
  const config = readStorageConfig(env);
  if (!s3Writable(config)) return null;
  return presignS3GetUrl({ ...config.s3, key: s3KeyFor(spec, config.s3) }).url;
}

/**
 * Ringkasan lengkap untuk UI: katalog + isi bucket + kemampuan storage.
 * Kegagalan list tidak fatal; dilaporkan pada `errors`.
 */
export async function storeOverview({ env = process.env, catalog = [], fetchImpl = fetch } = {}) {
  const capabilities = describeCapabilities(env);
  const errors = [];
  let objects = [];
  let truncated = false;
  let listOk = false;

  if (capabilities.can_list) {
    try {
      const listing = await listS3Objects({ env, fetchImpl });
      objects = listing.objects;
      truncated = Boolean(listing.truncated);
      listOk = true;
    } catch (err) {
      errors.push({ scope: 'list', message: err.message });
    }
  }

  const storedByKey = new Map(objects.map((item) => [item.key, item]));

  const catalogView = catalog.map((spec) => {
    const key = specKey(spec, env);
    const stored = storedByKey.get(key) || null;
    return {
      id: spec.id,
      name: spec.name,
      filename: spec.filename,
      size_mb: spec.sizeMb,
      quantization: spec.quantization,
      parameters: spec.parameters,
      context_length: spec.contextLength,
      badge: spec.badge,
      description: spec.description,
      download_url: spec.downloadUrl,
      storage_key: key,
      in_storage: listOk ? Boolean(stored) : null,
      stored_size_mb: stored ? stored.size_mb : null,
      last_modified: stored ? stored.last_modified : null,
    };
  });

  const byKey = new Map(catalog.map((spec) => [specKey(spec, env), spec]));

  return {
    ok: errors.length === 0,
    capabilities,
    storage: describeModelStorage(env, catalog),
    catalog: catalogView,
    objects: objects.map((item) => {
      const spec = byKey.get(item.key);
      return {
        ...item,
        matched_model: spec ? spec.id : null,
        download_url: spec ? downloadUrlFor(spec, env) : null,
      };
    }),
    truncated,
    errors,
  };
}

/** Salin model dari sumber publik (Hugging Face / CDN) ke bucket. */
export async function saveModelToStorage({
  spec,
  env = process.env,
  fetchImpl = fetch,
  force = false,
}) {
  const capabilities = describeCapabilities(env);
  if (!capabilities.can_save) {
    const err = new Error(capabilities.reason);
    err.statusCode = 501;
    throw err;
  }

  const config = readStorageConfig(env);
  const key = s3KeyFor(spec, config.s3);
  const startedAt = Date.now();

  if (!force) {
    const existing = await probeModelSource({
      source: {
        source: 's3',
        label: 'S3',
        url: presignS3GetUrl({ ...config.s3, key }).url,
        headers: {},
      },
      fetchImpl,
    }).catch(() => null);

    if (existing?.ok) {
      return {
        ok: true,
        skipped: true,
        key,
        size_mb: existing.size_mb,
        message: 'Model sudah ada di storage.',
        duration_ms: Date.now() - startedAt,
      };
    }
  }

  const result = await putObjectFromSource({
    sourceUrl: spec.downloadUrl,
    key,
    sizeBytes: spec.sizeMb * 1024 * 1024,
    env,
    fetchImpl,
  });

  return {
    ok: true,
    skipped: false,
    key,
    bytes: result.bytes,
    size_mb: Math.round(result.bytes / 1024 / 1024),
    duration_ms: Date.now() - startedAt,
    message: `Tersimpan di ${capabilities.bucket}/${key}`,
  };
}

/** Hapus objek model dari bucket setelah validasi kunci. */
export async function deleteStoredModel({ key, env = process.env, fetchImpl = fetch }) {
  const capabilities = describeCapabilities(env);
  if (!capabilities.can_delete) {
    const err = new Error(capabilities.reason);
    err.statusCode = 501;
    throw err;
  }

  const validated = validateObjectKey(key, env);
  if (!validated.ok) {
    const err = new Error(validated.message);
    err.statusCode = 400;
    throw err;
  }

  return deleteS3Object({ key: validated.key, env, fetchImpl });
}
