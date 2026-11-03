import fs from "node:fs";
import fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { once } from "node:events";
import { HttpError, upstream } from "../errors.mjs";
import { USER_AGENT } from "../version.mjs";

/** @typedef {typeof globalThis.fetch} FetchLike */

/**
 * @param {string} url
 * @param {{headers?: Record<string, string>, signal?: AbortSignal, fetchImpl?: FetchLike}} [options]
 */
export async function fetchJson(url, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json, application/vnd.docker.distribution.manifest.v2+json",
        ...options.headers,
      },
      redirect: "follow",
      signal: options.signal,
    });
  } catch (error) {
    throw upstream(`request to ${url} failed: ${/** @type {Error} */ (error).message}`, error);
  }
  if (!response.ok) {
    const body = await safeText(response);
    throw registryError(response.status, url, body);
  }
  try {
    return await response.json();
  } catch (error) {
    throw upstream(`invalid JSON from ${url}: ${/** @type {Error} */ (error).message}`, error);
  }
}

/**
 * Stream a remote file to disk while hashing it.
 *
 * @param {Object} options
 * @param {string} options.url
 * @param {string} options.dest
 * @param {Record<string, string>} [options.headers]
 * @param {AbortSignal} [options.signal]
 * @param {FetchLike} [options.fetchImpl]
 * @param {(progress: {completed: number, total: number}) => void} [options.onProgress]
 * @returns {Promise<{digest: string, size: number}>} digest is hex (no `sha256:` prefix)
 */
export async function downloadToFile(options) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  let response;
  try {
    response = await fetchImpl(options.url, {
      headers: { "User-Agent": USER_AGENT, ...options.headers },
      redirect: "follow",
      signal: options.signal,
    });
  } catch (error) {
    throw upstream(`download of ${options.url} failed: ${/** @type {Error} */ (error).message}`, error);
  }
  if (!response.ok || !response.body) {
    const body = await safeText(response);
    throw registryError(response.status, options.url, body);
  }

  const total = Number(response.headers.get("content-length") ?? 0);
  const hash = createHash("sha256");
  const file = fs.createWriteStream(options.dest);
  let completed = 0;
  let lastReport = 0;

  try {
    for await (const chunk of Readable.fromWeb(/** @type {any} */ (response.body))) {
      hash.update(chunk);
      completed += chunk.length;
      if (!file.write(chunk)) await once(file, "drain");
      const now = Date.now();
      if (options.onProgress && (now - lastReport > 120 || completed === total)) {
        lastReport = now;
        options.onProgress({ completed, total });
      }
    }
    await new Promise((resolve, reject) => {
      file.end((err) => (err ? reject(err) : resolve(undefined)));
    });
  } catch (error) {
    file.destroy();
    await fsp.rm(options.dest, { force: true }).catch(() => {});
    if (/** @type {Error} */ (error).name === "AbortError") {
      throw new HttpError(499, "download aborted", { code: "aborted" });
    }
    throw upstream(`download interrupted: ${/** @type {Error} */ (error).message}`, error);
  }

  options.onProgress?.({ completed, total: total || completed });
  return { digest: hash.digest("hex"), size: completed };
}

/** @param {Response} response */
async function safeText(response) {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "";
  }
}

/**
 * @param {number} status
 * @param {string} url
 * @param {string} body
 */
function registryError(status, url, body) {
  if (status === 404) {
    return new HttpError(404, `model not found upstream (${url})`, {
      code: "model_not_found",
      details: body || undefined,
    });
  }
  if (status === 401 || status === 403) {
    return new HttpError(401, `access denied by ${new URL(url).host}`, {
      code: "unauthorized",
      details: body || undefined,
    });
  }
  return new HttpError(502, `download failed with HTTP ${status} from ${url}`, {
    code: "download_failed",
    details: body || undefined,
  });
}

/**
 * Resume-friendly downloader.
 *
 * Writes into `<dest>.part` and keeps a small `<dest>.meta.json` sidecar with the
 * URL, ETag and expected size. A second call (after a Ctrl+C, a crash or a flaky
 * connection) continues from the current size using a `Range` request instead of
 * restarting a multi-gigabyte transfer from zero.
 *
 * @param {Object} options
 * @param {string} options.url
 * @param {string} options.dest final path (the partial file is `${dest}.part`)
 * @param {Record<string, string>} [options.headers]
 * @param {AbortSignal} [options.signal]
 * @param {FetchLike} [options.fetchImpl]
 * @param {number} [options.expectedSize]
 * @param {(progress: {completed: number, total: number, resumedFrom: number}) => void} [options.onProgress]
 * @returns {Promise<{path: string, size: number, resumedFrom: number, etag: string | null}>}
 */
export async function downloadResumable(options) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const partPath = `${options.dest}.part`;
  const metaPath = `${options.dest}.meta.json`;

  /** @type {{url?: string, etag?: string | null, size?: number} | null} */
  let meta = null;
  try {
    meta = JSON.parse(await fsp.readFile(metaPath, "utf8"));
  } catch {
    meta = null;
  }

  let offset = 0;
  if (meta?.url === options.url) {
    const stat = await fsp.stat(partPath).catch(() => null);
    if (stat?.isFile()) offset = stat.size;
    if (meta.size && offset > meta.size) offset = 0;
  }
  if (offset === 0) {
    await fsp.rm(partPath, { force: true });
  }

  /** @type {Record<string, string>} */
  const headers = {
    "User-Agent": USER_AGENT,
    "Accept-Encoding": "identity",
    ...options.headers,
  };
  if (offset > 0) headers.Range = `bytes=${offset}-`;

  let response;
  try {
    response = await fetchImpl(options.url, { headers, redirect: "follow", signal: options.signal });
  } catch (error) {
    if (/** @type {Error} */ (error).name === "AbortError") {
      throw new HttpError(499, "download aborted", { code: "aborted" });
    }
    throw upstream(`download of ${options.url} failed: ${/** @type {Error} */ (error).message}`, error);
  }

  if (offset > 0 && response.status === 200) {
    // The server ignored our Range header; start over rather than corrupting.
    offset = 0;
    await fsp.rm(partPath, { force: true });
  }
  if (response.status !== 200 && response.status !== 206) {
    const body = await safeText(response);
    throw registryError(response.status, options.url, body);
  }
  if (!response.body) throw upstream(`empty response body from ${options.url}`);

  const contentRange = /bytes\s+\d+-\d+\/(\d+)/i.exec(response.headers.get("content-range") ?? "");
  const total =
    (contentRange ? Number(contentRange[1]) : 0) ||
    (Number(response.headers.get("content-length") ?? 0) + offset) ||
    options.expectedSize ||
    0;
  const etag = response.headers.get("etag");

  // Persist the sidecar before transferring a single byte: if the connection
  // drops (or the process is killed) the next run still knows where this
  // partial file came from and can resume it with a Range request.
  await fsp.writeFile(
    metaPath,
    `${JSON.stringify({ url: options.url, etag, size: total, updatedAt: new Date().toISOString() }, null, 2)}\n`,
  );

  const file = fs.createWriteStream(partPath, { flags: offset > 0 ? "a" : "w" });
  let completed = offset;
  let lastReport = 0;
  try {
    for await (const chunk of Readable.fromWeb(/** @type {any} */ (response.body))) {
      if (!file.write(chunk)) await once(file, "drain");
      completed += chunk.length;
      const now = Date.now();
      if (options.onProgress && (now - lastReport > 120 || completed === total)) {
        lastReport = now;
        options.onProgress({ completed, total, resumedFrom: offset });
      }
    }
    await new Promise((resolve, reject) => {
      file.end((err) => (err ? reject(err) : resolve(undefined)));
    });
  } catch (error) {
    file.destroy();
    if (/** @type {Error} */ (error).name === "AbortError") {
      // Keep the partial file: the next run resumes from here.
      throw new HttpError(499, "download aborted", { code: "aborted" });
    }
    throw upstream(`download interrupted: ${/** @type {Error} */ (error).message}`, error);
  }

  options.onProgress?.({ completed, total: total || completed, resumedFrom: offset });
  if (total > 0 && completed !== total) {
    throw upstream(`incomplete download: got ${completed} of ${total} bytes from ${options.url}`);
  }
  await fsp.writeFile(
    metaPath,
    `${JSON.stringify({ url: options.url, etag, size: completed, updatedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  return { path: partPath, size: completed, resumedFrom: offset, etag: etag ?? null };
}

/**
 * SHA-256 of a file, streamed.
 * @param {string} filePath
 */
export async function hashFile(filePath) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { digest: hash.digest("hex"), size };
}

/**
 * Remove a resumable download's artefacts once it has been committed.
 * @param {string} dest
 */
export async function cleanupResumable(dest) {
  await Promise.all([
    fsp.rm(`${dest}.part`, { force: true }),
    fsp.rm(`${dest}.meta.json`, { force: true }),
  ]);
}
