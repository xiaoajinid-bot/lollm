import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildS3ObjectUrl,
  describeModelStorage,
  downloadFromPlan,
  downloadModelFile,
  modelSourcePlan,
  presignS3GetUrl,
  probeModelSource,
  readStorageConfig,
  redactUrl,
  s3KeyFor,
} from '../lib/model-storage.mjs';

const SPEC = {
  id: 'demo-model',
  filename: 'demo-model.gguf',
  sizeMb: 10,
  downloadUrl: 'https://huggingface.co/contoh/demo-model.gguf',
};

const CREDS = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};

const S3_ENV = {
  LLM_S3_BUCKET: 'lollm-models',
  LLM_S3_REGION: 'ap-southeast-2',
  LLM_S3_ACCESS_KEY_ID: CREDS.accessKeyId,
  LLM_S3_SECRET_ACCESS_KEY: CREDS.secretAccessKey,
};

/* ------------------------------------------------------------------- SigV4 */

test('SigV4 cocok dengan contoh resmi AWS (presigned GET)', () => {
  const result = presignS3GetUrl({
    bucket: 'examplebucket',
    key: 'test.txt',
    region: 'us-east-1',
    endpoint: 'https://s3.amazonaws.com',
    expiresIn: 86400,
    now: new Date('2013-05-24T00:00:00Z'),
    ...CREDS,
  });

  // Vektor dari dokumentasi AWS "Authenticating Requests: Using Query Parameters"
  assert.equal(
    result.signature,
    'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'
  );
  assert.equal(
    result.canonicalRequest,
    [
      'GET',
      '/test.txt',
      'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host',
      'host:examplebucket.s3.amazonaws.com',
      '',
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n')
  );
  assert.match(result.url, /^https:\/\/examplebucket\.s3\.amazonaws\.com\/test\.txt\?/);
  assert.ok(result.url.endsWith(`X-Amz-Signature=${result.signature}`));
});

test('presign menyertakan X-Amz-Security-Token untuk kredensial STS', () => {
  const base = { bucket: 'bucket-a', key: 'models/a.gguf', region: 'us-east-1' };
  const now = new Date('2026-01-02T03:04:05Z');
  const tanpa = presignS3GetUrl({ ...base, ...CREDS, now });
  const dengan = presignS3GetUrl({ ...base, ...CREDS, sessionToken: 'TOKEN-SEMENTARA', now });

  assert.ok(!tanpa.url.includes('X-Amz-Security-Token'));
  assert.ok(dengan.url.includes('X-Amz-Security-Token=TOKEN-SEMENTARA'));
  assert.notEqual(dengan.signature, tanpa.signature);
});

test('buildS3ObjectUrl: virtual-host untuk AWS, path-style untuk endpoint kustom', () => {
  const aws = buildS3ObjectUrl({ bucket: 'b', key: 'models/x.gguf', region: 'us-east-1' });
  assert.equal(aws.url, 'https://b.s3.us-east-1.amazonaws.com/models/x.gguf');
  assert.equal(aws.pathStyle, false);

  const r2 = buildS3ObjectUrl({
    bucket: 'b',
    key: 'models/x.gguf',
    region: 'auto',
    endpoint: 'https://acc.r2.cloudflarestorage.com',
  });
  assert.equal(r2.url, 'https://acc.r2.cloudflarestorage.com/b/models/x.gguf');
  assert.equal(r2.pathStyle, true);

  const minio = buildS3ObjectUrl({
    bucket: 'models',
    key: 'a/b.gguf',
    endpoint: 'http://localhost:9000',
    forcePathStyle: true,
  });
  assert.equal(minio.url, 'http://localhost:9000/models/a/b.gguf');
});

test('buildS3ObjectUrl meng-encode karakter khusus per segmen', () => {
  const built = buildS3ObjectUrl({ bucket: 'b', key: 'folder/demo model+q4.gguf' });
  assert.equal(built.path, '/folder/demo%20model%2Bq4.gguf');
});

/* -------------------------------------------------------------- konfigurasi */

test('readStorageConfig menebak region, path-style, dan prefix', () => {
  const r2 = readStorageConfig({
    LLM_S3_BUCKET: 'b',
    LLM_S3_ENDPOINT: 'https://acc.r2.cloudflarestorage.com',
  });
  assert.equal(r2.s3.region, 'auto');
  assert.equal(r2.s3.forcePathStyle, true);
  assert.equal(r2.s3.prefix, 'models/');

  const aws = readStorageConfig({ LLM_S3_BUCKET: 'b', LLM_S3_REGION: 'eu-west-1' });
  assert.equal(aws.s3.region, 'eu-west-1');
  assert.equal(aws.s3.forcePathStyle, false);

  const override = readStorageConfig({
    LLM_S3_BUCKET: 'b',
    LLM_S3_ENDPOINT: 'https://acc.r2.cloudflarestorage.com',
    LLM_S3_FORCE_PATH_STYLE: 'false',
    LLM_S3_PREFIX: 'gguf/',
  });
  assert.equal(override.s3.forcePathStyle, false);
  assert.equal(override.s3.prefix, 'gguf/');
});

test('kredensial bisa diambil dari env AWS standar', () => {
  const config = readStorageConfig({
    LLM_S3_BUCKET: 'b',
    AWS_ACCESS_KEY_ID: 'AKIA-ENV',
    AWS_SECRET_ACCESS_KEY: 'SECRET-ENV',
  });
  assert.equal(config.s3.accessKeyId, 'AKIA-ENV');
  assert.equal(config.s3.secretAccessKey, 'SECRET-ENV');
});

test('kunci objek = prefix + nama file', () => {
  assert.equal(s3KeyFor(SPEC, { prefix: 'models/' }), 'models/demo-model.gguf');
  assert.equal(s3KeyFor(SPEC, { prefix: '/gguf' }), 'gguf/demo-model.gguf');
  assert.equal(s3KeyFor(SPEC, { prefix: '' }), 'demo-model.gguf');
});

/* ------------------------------------------------------------- urutan sumber */

test('mode auto: S3 → Blob → base URL → Hugging Face', () => {
  const plan = modelSourcePlan(SPEC, {
    ...S3_ENV,
    LLM_BLOB_BASE_URL: 'https://store.public.blob.vercel-storage.com',
    LLM_MODEL_BASE_URL: 'https://cdn.contoh.com/models',
  });
  assert.deepEqual(
    plan.map((item) => item.source),
    ['s3', 'blob', 'url', 'huggingface']
  );
  assert.ok(plan[0].url.includes('lollm-models.s3.ap-southeast-2.amazonaws.com'));
  assert.ok(plan[0].url.includes('X-Amz-Signature='));
  assert.equal(plan[1].url, 'https://store.public.blob.vercel-storage.com/demo-model.gguf');
});

test('tanpa konfigurasi storage hanya Hugging Face yang dipakai', () => {
  const plan = modelSourcePlan(SPEC, {});
  assert.deepEqual(plan.map((item) => item.source), ['huggingface']);
  assert.equal(plan[0].url, SPEC.downloadUrl);
});

test('mode eksplisit tidak fallback ke sumber lain', () => {
  const plan = modelSourcePlan(SPEC, { ...S3_ENV, LLM_MODEL_SOURCE: 's3' });
  assert.deepEqual(plan.map((item) => item.source), ['s3']);

  const hf = modelSourcePlan(SPEC, { ...S3_ENV, LLM_MODEL_SOURCE: 'huggingface' });
  assert.deepEqual(hf.map((item) => item.source), ['huggingface']);
});

test('mode tidak dikenal diperlakukan sebagai auto', () => {
  const config = readStorageConfig({ LLM_MODEL_SOURCE: 'dropbox' });
  assert.equal(config.mode, 'auto');
  assert.equal(config.modeRequested, 'dropbox');
});

test('S3 publik tanpa kredensial memakai base URL tanpa tanda tangan', () => {
  const plan = modelSourcePlan(SPEC, {
    LLM_S3_BUCKET: 'lollm-models',
    LLM_S3_PUBLIC_BASE_URL: 'https://cdn.contoh.com',
  });
  assert.equal(plan[0].source, 's3');
  assert.equal(plan[0].url, 'https://cdn.contoh.com/models/demo-model.gguf');
  assert.ok(!plan[0].url.includes('X-Amz-Signature'));
});

test('Blob privat mengirim header Authorization', () => {
  const plan = modelSourcePlan(SPEC, {
    LLM_BLOB_BASE_URL: 'https://store.public.blob.vercel-storage.com',
    BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_rahasia',
    LLM_BLOB_PRIVATE: 'true',
  });
  assert.equal(plan[0].headers.Authorization, 'Bearer vercel_blob_rw_rahasia');
});

/* ---------------------------------------------------------------- describe */

test('describeModelStorage tidak membocorkan secret maupun tanda tangan URL', () => {
  const describe = describeModelStorage(
    {
      ...S3_ENV,
      LLM_S3_SECRET_ACCESS_KEY: 'SUPER-SECRET-KEY',
      LLM_S3_ACCESS_KEY_ID: 'AKIA-RAHASIA',
    },
    [SPEC]
  );

  const serialized = JSON.stringify(describe);
  assert.ok(!serialized.includes('SUPER-SECRET-KEY'));
  assert.ok(!serialized.includes('AKIA-RAHASIA'));
  assert.ok(!serialized.includes('X-Amz-Signature'));

  assert.equal(describe.configured, true);
  assert.equal(describe.s3.bucket, 'lollm-models');
  assert.equal(describe.s3.signing, 'presigned');
  assert.equal(describe.models[0].source, 's3');
  assert.equal(describe.models[0].url_preview, 'https://lollm-models.s3.ap-southeast-2.amazonaws.com/models/demo-model.gguf');
  assert.deepEqual(describe.models[0].fallback_sources, ['huggingface']);
});

test('redactUrl membuang query string', () => {
  assert.equal(
    redactUrl('https://b.s3.amazonaws.com/k.gguf?X-Amz-Signature=abc&X-Amz-Credential=xyz'),
    'https://b.s3.amazonaws.com/k.gguf'
  );
  assert.equal(redactUrl(null), null);
});

/* ----------------------------------------------------------------- unduhan */

async function withTempDir(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lollm-storage-'));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test('downloadModelFile menulis file, melaporkan progres, dan menghapus .part', async () => {
  await withTempDir(async (dir) => {
    const payload = Buffer.alloc(64 * 1024, 7);
    const dest = path.join(dir, 'demo.gguf');
    const progress = [];
    const seenHeaders = [];

    const result = await downloadModelFile({
      spec: SPEC,
      source: { source: 's3', label: 'S3 (uji)', url: 'https://bucket.test/demo.gguf', headers: { 'X-Uji': '1' } },
      destPath: dest,
      emitIntervalMs: 0,
      onProgress: (p) => progress.push(p),
      fetchImpl: async (url, init) => {
        seenHeaders.push(init.headers);
        return new Response(payload, {
          status: 200,
          headers: { 'Content-Length': String(payload.length) },
        });
      },
    });

    const stat = await fsp.stat(dest);
    assert.equal(stat.size, payload.length);
    assert.equal(result.source, 's3');
    assert.equal(result.bytes, payload.length);
    assert.ok(progress.length >= 1);
    assert.equal(progress.at(-1).source, 's3');
    assert.equal(seenHeaders[0]['X-Uji'], '1');
    await assert.rejects(fsp.stat(`${dest}.part`));
  });
});

test('downloadModelFile gagal bersih saat HTTP error', async () => {
  await withTempDir(async (dir) => {
    const dest = path.join(dir, 'demo.gguf');
    await assert.rejects(
      downloadModelFile({
        spec: SPEC,
        source: { source: 's3', label: 'S3 (uji)', url: 'https://bucket.test/x.gguf', headers: {} },
        destPath: dest,
        fetchImpl: async () => new Response('tidak ada', { status: 403 }),
      }),
      /S3 \(uji\): HTTP 403/
    );
    await assert.rejects(fsp.stat(dest));
    await assert.rejects(fsp.stat(`${dest}.part`));
  });
});

test('probeModelSource membaca ukuran dari Content-Range', async () => {
  const probe = await probeModelSource({
    source: { source: 's3', label: 'S3', url: 'https://bucket.test/demo.gguf', headers: {} },
    fetchImpl: async () =>
      new Response('x', {
        status: 206,
        headers: { 'Content-Range': 'bytes 0-0/397284474' },
      }),
  });

  assert.equal(probe.ok, true);
  assert.equal(probe.status, 206);
  assert.equal(probe.size_mb, 379);
  assert.equal(probe.url_preview, 'https://bucket.test/demo.gguf');
});

test('probeModelSource melaporkan kegagalan tanpa melempar', async () => {
  const probe = await probeModelSource({
    source: { source: 'blob', label: 'Blob', url: 'https://store.test/x.gguf', headers: {} },
    fetchImpl: async () => {
      throw new Error('getaddrinfo ENOTFOUND store.test');
    },
  });

  assert.equal(probe.ok, false);
  assert.match(probe.error, /ENOTFOUND/);
  assert.equal(probe.duration_ms >= 0, true);
});

/* ---------------------------------------------------------- fallback antar sumber */

test('downloadFromPlan jatuh ke sumber berikutnya saat sumber pertama gagal', async () => {
  await withTempDir(async (dir) => {
    const dest = path.join(dir, 'demo.gguf');
    const attempts = [];
    const payload = Buffer.alloc(1024, 3);

    const result = await downloadFromPlan({
      spec: SPEC,
      sources: [
        { source: 's3', label: 'S3 (uji)', url: 'https://bucket.test/missing.gguf', headers: {} },
        { source: 'blob', label: 'Vercel Blob', url: 'https://store.test/demo.gguf', headers: {} },
      ],
      destPath: dest,
      onAttempt: (source) => attempts.push(source.source),
      fetchImpl: async (url) => {
        if (url.includes('bucket.test')) return new Response('tidak ada', { status: 404 });
        return new Response(payload, { status: 200, headers: { 'Content-Length': '1024' } });
      },
    });

    assert.deepEqual(attempts, ['s3', 'blob']);
    assert.equal(result.source, 'blob');
    assert.equal(result.attempts, 2);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0], /S3 \(uji\): HTTP 404/);
    assert.equal((await fsp.stat(dest)).size, 1024);
  });
});

test('downloadFromPlan melempar error 502 berisi ringkasan semua kegagalan', async () => {
  await withTempDir(async (dir) => {
    const err = await downloadFromPlan({
      spec: SPEC,
      sources: [
        { source: 's3', label: 'S3', url: 'https://bucket.test/a.gguf', headers: {} },
        { source: 'huggingface', label: 'Hugging Face', url: 'https://hf.test/a.gguf', headers: {} },
      ],
      destPath: path.join(dir, 'demo.gguf'),
      fetchImpl: async () => new Response('nope', { status: 500 }),
    }).catch((e) => e);

    assert.equal(err.statusCode, 502);
    assert.equal(err.failures.length, 2);
    assert.match(err.message, /semua sumber/);
    assert.match(err.message, /S3: HTTP 500/);
    assert.match(err.message, /Hugging Face: HTTP 500/);
  });
});

test('downloadFromPlan tanpa sumber aktif memberi error 501 yang jelas', async () => {
  const err = await downloadFromPlan({
    spec: SPEC,
    sources: [],
    destPath: '/tmp/tidak-dipakai.gguf',
  }).catch((e) => e);

  assert.equal(err.statusCode, 501);
  assert.match(err.message, /Tidak ada sumber model aktif/);
  assert.match(err.message, /LLM_S3_BUCKET/);
});

/* ------------------------------------------------------- integrasi end-to-end */

test('e2e: model diunduh dari server HTTP lokal seperti bucket S3 publik', async () => {
  const http = await import('node:http');
  const payload = Buffer.alloc(2 * 1024 * 1024, 9); // 2 MB

  const server = http.createServer((req, res) => {
    if (req.url !== '/models/demo-model.gguf') {
      res.writeHead(404).end('salah path');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(payload.length),
    });
    res.end(payload);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const env = {
      LLM_S3_BUCKET: 'lollm-models',
      LLM_S3_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    };
    const plan = modelSourcePlan(SPEC, env);
    assert.equal(plan[0].source, 's3');

    await withTempDir(async (dir) => {
      const dest = path.join(dir, 'demo-model.gguf');
      const result = await downloadFromPlan({ spec: SPEC, sources: plan, destPath: dest });
      const stat = await fsp.stat(dest);

      assert.equal(result.source, 's3');
      assert.equal(stat.size, payload.length);
      assert.equal((await fsp.readFile(dest)).subarray(0, 8).toString('hex'), '0909090909090909');
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
