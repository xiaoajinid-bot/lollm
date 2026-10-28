import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* Muat .env lebih dulu supaya kredensial/opsi lokal terbaca, tanpa dependency. */
const envFile = path.join(root, '.env');
const hasEnvFile = await fs.access(envFile).then(
  () => true,
  () => false
);
if (hasEnvFile) {
  if (typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(envFile);
      console.log('Memuat variabel environment dari .env');
    } catch (err) {
      console.warn(`.env gagal dimuat: ${err.message}`);
    }
  } else {
    console.warn('Node < 20.12: jalankan dengan `node --env-file=.env scripts/dev-server.mjs`.');
  }
}

const publicDir = path.join(root, 'public');
const port = Number(process.env.PORT || 3000);
const apiModule = await import(pathToFileURL(path.join(root, 'api', 'llm.mjs')));

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function serveIndex(res) {
  fs.readFile(path.join(publicDir, 'index.html'))
    .then((content) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(content);
    })
    .catch(() => {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Unable to load public/index.html');
    });
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(requestUrl.pathname);

  if (
    pathname.startsWith('/api/') ||
    pathname.startsWith('/v1/') ||
    pathname === '/responses' ||
    pathname.startsWith('/responses/') ||
    pathname.startsWith('/.well-known/')
  ) {
    await apiModule.default(req, res);
    return;
  }

  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(publicDir, relativePath);
  if (!filePath.startsWith(`${publicDir}${path.sep}`)) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream',
    });
    res.end(content);
  } catch {
    serveIndex(res);
  }
});

server.listen(port, () => {
  console.log(`Local LLM dev server listening on http://localhost:${port}`);
});
