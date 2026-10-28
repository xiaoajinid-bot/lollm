import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  deleteS3Object,
  listS3Objects,
  parseS3ListXml,
  putObjectFromSource,
} from '../lib/model-storage.mjs';
import {
  deleteStoredModel,
  describeCapabilities,
  saveModelToStorage,
  storeOverview,
  validateObjectKey,
} from '../lib/model-store.mjs';

const SPEC = {
  id: 'demo-model',
  name: 'Demo Model',
  filename: 'demo-model.gguf',
  sizeMb: 2,
  quantization: 'Q4_K_M',
  parameters: '135M',
  contextLength: 2048,
  badge: 'demo',
  description: 'Model demo.',
  downloadUrl: 'https://huggingface.co/contoh/demo-model.gguf',
};

/* ------------------------------------------------------------ server S3 palsu */

async function startFakeS3({ objects = [] } = {}) {
  const seen = { put: [], delete: [], list: [], get: [] };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') || '';
      seen.list.push({ prefix });
      const contents = objects
        .filter((item) => item.key.startsWith(prefix))
        .map(
          (item) =>
            `<Contents><Key>${item.key}</Key><LastModified>${item.lastModified || '2026-10-01T00:00:00.000Z'}</LastModified><ETag>"abc"</ETag><Size>${item.size}</Size><StorageClass>STANDARD</StorageClass></Contents>`
        )
        .join('');
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>${contents}<IsTruncated>false</IsTruncated></ListBucketResult>`);
      return;
    }

    if (req.method === 'PUT') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      seen.put.push({ path: url.pathname, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(200, { ETag: '"abc"' });
      res.end();
      return;
    }

    if (req.method === 'DELETE') {
      seen.delete.push({ path: url.pathname });
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET') {
      seen.get.push({ path: url.pathname, range: req.headers.range });
      res.writeHead(206, { 'Content-Range': 'bytes 0-0/2097152', 'Content-Length': '1' });
      res.end('x');
      return;
    }

    res.writeHead(405).end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    seen,
    env: {
      LLM_S3_BUCKET: 'lollm-models',
      LLM_S3_ENDPOINT: `http://127.0.0.1:${port}`,
      LLM_S3_REGION: 'us-east-1',
      LLM_S3_FORCE_PATH_STYLE: 'true',
      LLM_S3_ACCESS_KEY_ID: 'AKIA-UJI',
      LLM_S3_SECRET_ACCESS_KEY: 'SECRET-UJI',
      LLM_S3_PREFIX: 'models/',
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function withFakeS3(options, fn) {
  const s3 = await startFakeS3(options);
  try {
    return await fn(s3);
  } finally {
    await s3.close();
  }
}

/* ------------------------------------------------------------- kemampuan UI */

test('describeCapabilities: S3 dengan kredensial bisa simpan/hapus/daftar', () => {
  const caps = describeCapabilities({
    LLM_S3_BUCKET: 'b',
    LLM_S3_ACCESS_KEY_ID: 'a',
    LLM_S3_SECRET_ACCESS_KEY: 's',
  });
  assert.equal(caps.provider, 's3');
  assert.equal(caps.can_save, true);
  assert.equal(caps.can_delete, true);
  assert.equal(caps.can_list, true);
  assert.equal(caps.reason, null);
});

test('describeCapabilities: Blob hanya baca dengan alasan yang jelas', () => {
  const caps = describeCapabilities({ LLM_BLOB_BASE_URL: 'https://store.public.blob.vercel-storage.com' });
  assert.equal(caps.provider, 'blob');
  assert.equal(caps.can_save, false);
  assert.match(caps.reason, /baca saja/);
});

test('describeCapabilities: tanpa storage menyarankan env S3', () => {
  const caps = describeCapabilities({});
  assert.equal(caps.provider, null);
  assert.equal(caps.can_save, false);
  assert.match(caps.reason, /LLM_S3_BUCKET/);
});

/* ------------------------------------------------------------ validasi kunci */

test('validateObjectKey menolak kunci berbahaya atau di luar prefix', () => {
  const env = { LLM_S3_BUCKET: 'b', LLM_S3_PREFIX: 'models/' };

  assert.equal(validateObjectKey('', env).ok, false);
  assert.equal(validateObjectKey('models/a.gguf', env).ok, true);
  assert.equal(validateObjectKey('models/../etc/passwd.gguf', env).ok, false);
  assert.equal(validateObjectKey('models/a.txt', env).ok, false);
  assert.equal(validateObjectKey('lain/a.gguf', env).ok, false);
  assert.equal(validateObjectKey('models/b.gguf', env).key, 'models/b.gguf');
});

/* ------------------------------------------------------------------ listing */

test('parseS3ListXml membaca Key, Size, dan status truncated', () => {
  const xml = `<ListBucketResult>
    <Contents><Key>models/a.gguf</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><Size>1024</Size></Contents>
    <Contents><Key>models/b &amp; c.gguf</Key><LastModified>2026-02-02T00:00:00.000Z</LastModified><Size>2048</Size></Contents>
    <IsTruncated>true</IsTruncated>
  </ListBucketResult>`;

  const parsed = parseS3ListXml(xml);
  assert.equal(parsed.objects.length, 2);
  assert.equal(parsed.objects[0].key, 'models/a.gguf');
  assert.equal(parsed.objects[1].key, 'models/b & c.gguf');
  assert.equal(parsed.objects[1].size_bytes, 2048);
  assert.equal(parsed.truncated, true);
});

test('listS3Objects hanya mengembalikan .gguf dan menghitung ukuran MB', async () => {
  await withFakeS3(
    {
      objects: [
        { key: 'models/demo-model.gguf', size: 5 * 1024 * 1024 },
        { key: 'models/catatan.txt', size: 10 },
        { key: 'models/lain.gguf', size: 1024 * 1024 },
      ],
    },
    async (s3) => {
      const result = await listS3Objects({ env: s3.env });

      assert.equal(result.supported, true);
      assert.deepEqual(result.objects.map((item) => item.name), ['demo-model.gguf', 'lain.gguf']);
      assert.equal(result.objects[0].size_mb, 5);
      assert.equal(s3.seen.list[0].prefix, 'models/');
    }
  );
});

test('listS3Objects menolak bila kredensial tidak ada', async () => {
  const result = await listS3Objects({ env: { LLM_S3_BUCKET: 'b' } });
  assert.equal(result.supported, false);
  assert.match(result.reason, /kredensial/);
});

/* -------------------------------------------------------------- hapus objek */

test('deleteS3Object mengirim DELETE ke objek yang benar', async () => {
  await withFakeS3({}, async (s3) => {
    const result = await deleteS3Object({ key: 'models/demo-model.gguf', env: s3.env });
    assert.equal(result.ok, true);
    assert.ok(s3.seen.delete[0].path.endsWith('/models/demo-model.gguf'), s3.seen.delete[0].path);
  });
});

test('deleteStoredModel menolak kunci tidak valid dengan status 400', async () => {
  const err = await deleteStoredModel({
    key: '..%2Fsecret.gguf',
    env: { LLM_S3_BUCKET: 'b', LLM_S3_ACCESS_KEY_ID: 'a', LLM_S3_SECRET_ACCESS_KEY: 's' },
  }).catch((e) => e);

  assert.equal(err.statusCode, 400);
  assert.match(err.message, /prefix|valid/i);
});

/* ------------------------------------------------------------ simpan ke S3 */

test('putObjectFromSource mengalirkan isi sumber ke bucket (tanpa chunked)', async () => {
  const payload = Buffer.alloc(256 * 1024, 5);
  const sourceServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Length': String(payload.length) });
    res.end(payload);
  });
  await new Promise((resolve) => sourceServer.listen(0, '127.0.0.1', resolve));
  const sourcePort = sourceServer.address().port;

  try {
    await withFakeS3({}, async (s3) => {
      const result = await putObjectFromSource({
        sourceUrl: `http://127.0.0.1:${sourcePort}/demo.gguf`,
        key: 'models/demo-model.gguf',
        env: s3.env,
      });

      const put = s3.seen.put[0];
      assert.equal(result.bytes, payload.length);
      assert.equal(put.body.length, payload.length);
      assert.equal(put.headers['content-length'], String(payload.length));
      assert.equal(put.headers['transfer-encoding'], undefined);
      assert.ok(put.path.endsWith('/lollm-models/models/demo-model.gguf'), put.path);
    });
  } finally {
    await new Promise((resolve) => sourceServer.close(resolve));
  }
});

test('saveModelToStorage melewati unggahan bila objek sudah ada', async () => {
  await withFakeS3({}, async (s3) => {
    // Fake S3 menjawab 206 untuk GET -> probe menganggap objek sudah ada
    const result = await saveModelToStorage({ spec: SPEC, env: s3.env });
    assert.equal(result.skipped, true);
    assert.equal(s3.seen.put.length, 0);
  });
});

test('saveModelToStorage mengunggah saat force=true', async () => {
  const payload = Buffer.alloc(64 * 1024, 7);
  const sourceServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Length': String(payload.length) });
    res.end(payload);
  });
  await new Promise((resolve) => sourceServer.listen(0, '127.0.0.1', resolve));
  const sourcePort = sourceServer.address().port;

  try {
    await withFakeS3({}, async (s3) => {
      const spec = { ...SPEC, downloadUrl: `http://127.0.0.1:${sourcePort}/demo.gguf` };
      const result = await saveModelToStorage({ spec, env: s3.env, force: true });

      assert.equal(result.skipped, false);
      assert.equal(result.bytes, payload.length);
      assert.equal(s3.seen.put.length, 1);
      assert.match(result.message, /models\/demo-model\.gguf/);
    });
  } finally {
    await new Promise((resolve) => sourceServer.close(resolve));
  }
});

test('saveModelToStorage memberi 501 bila storage tidak bisa ditulis', async () => {
  const err = await saveModelToStorage({ spec: SPEC, env: {} }).catch((e) => e);
  assert.equal(err.statusCode, 501);
  assert.match(err.message, /LLM_S3_BUCKET/);
});

/* ---------------------------------------------------------------- overview */

test('storeOverview menggabungkan katalog dan isi bucket', async () => {
  await withFakeS3(
    { objects: [{ key: 'models/demo-model.gguf', size: 2 * 1024 * 1024 }, { key: 'models/asing.gguf', size: 1024 * 1024 }] },
    async (s3) => {
      const overview = await storeOverview({ env: s3.env, catalog: [SPEC] });

      assert.equal(overview.ok, true);
      assert.equal(overview.capabilities.can_save, true);
      assert.equal(overview.catalog[0].in_storage, true);
      assert.equal(overview.catalog[0].stored_size_mb, 2);
      assert.equal(overview.objects.length, 2);

      const stored = overview.objects.find((item) => item.key === 'models/demo-model.gguf');
      assert.equal(stored.matched_model, 'demo-model');
      assert.ok(stored.download_url.includes('X-Amz-Signature='));

      const orphan = overview.objects.find((item) => item.key === 'models/asing.gguf');
      assert.equal(orphan.matched_model, null);
      assert.equal(orphan.download_url, null);
    }
  );
});

test('storeOverview melaporkan error list tanpa menggagalkan respons', async () => {
  const env = {
    LLM_S3_BUCKET: 'b',
    LLM_S3_ACCESS_KEY_ID: 'a',
    LLM_S3_SECRET_ACCESS_KEY: 's',
    LLM_S3_ENDPOINT: 'http://127.0.0.1:1',
    LLM_S3_FORCE_PATH_STYLE: 'true',
  };

  const overview = await storeOverview({ env, catalog: [SPEC] });
  assert.equal(overview.ok, false);
  assert.equal(overview.errors[0].scope, 'list');
  assert.equal(overview.catalog[0].in_storage, null);
});
