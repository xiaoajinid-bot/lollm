import { HttpError, badRequest, notFound, upstream } from "../errors.mjs";
import { USER_AGENT } from "../version.mjs";
import { readGgufInfoFromSource } from "./gguf.mjs";
import { huggingFaceUrl, parseReference } from "./registry.mjs";

/**
 * Random-access reads over HTTP using `Range` requests.
 *
 * GGUF is a header-first format: magic, metadata and tensor descriptors live in
 * the first few hundred kilobytes, and the tensor payload follows. That means a
 * parser can inspect a 4 GB model by fetching a couple of megabytes — as long
 * as it can read arbitrary offsets, which is exactly what this class provides.
 *
 * Header blocks are cached, so parsing (hundreds of tiny reads) costs a handful
 * of requests; only a read that lands in an uncached block triggers new HTTP
 * traffic. Tensor reads therefore stay lazy: nothing is downloaded until
 * somebody asks for tensor bytes.
 */

/** @typedef {typeof globalThis.fetch} FetchLike */

export class HttpRangeSource {
  /**
   * @param {string} url
   * @param {Object} [options]
   * @param {Record<string, string>} [options.headers]
   * @param {FetchLike} [options.fetchImpl]
   * @param {AbortSignal} [options.signal]
   * @param {number} [options.blockSize] bytes fetched per Range request
   * @param {number} [options.maxBlocks] in-memory cache budget (blocks)
   * @param {number} [options.retries]
   */
  constructor(url, options = {}) {
    this.url = url;
    this.headers = options.headers ?? {};
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.signal = options.signal;
    this.blockSize = Math.max(16 * 1024, options.blockSize ?? 256 * 1024);
    this.maxBlocks = Math.max(4, options.maxBlocks ?? 256);
    this.retries = Math.max(0, options.retries ?? 3);
    this.size = 0;
    this.etag = null;
    this.lastModified = null;
    this.supportsRanges = false;
    this.label = url;
    /** @type {Map<number, Buffer>} */
    this.blocks = new Map();
    this.stats = {
      requests: 0,
      bytesFetched: 0,
      cacheHits: 0,
      cacheMisses: 0,
      headerRequests: 0,
    };
    this.closed = false;
  }

  get blockCount() {
    return Math.ceil(this.size / this.blockSize);
  }

  /**
   * Discover the object size and whether the server honours Range requests.
   * A single 1-byte ranged GET is enough for both.
   */
  async open() {
    const requestHeaders = {
      "User-Agent": USER_AGENT,
      "Accept-Encoding": "identity",
      Range: "bytes=0-0",
      ...this.headers,
    };
    const response = await this.#fetchWithRetry(this.url, { headers: requestHeaders, method: "GET" });
    this.stats.requests += 1;
    this.stats.headerRequests += 1;

    if (response.status === 206) {
      const range = parseContentRange(response.headers.get("content-range"));
      if (!range || !Number.isFinite(range.total)) {
        await discard(response);
        throw upstream(`${this.url} returned a partial response without a usable Content-Range`);
      }
      this.size = range.total;
      this.supportsRanges = true;
      this.etag = response.headers.get("etag");
      this.lastModified = response.headers.get("last-modified");
      this.stats.bytesFetched += range.end - range.start + 1;
      await discard(response);
      return this;
    }

    if (response.status === 200) {
      // Server ignored the Range header and started streaming the whole body.
      const length = Number(response.headers.get("content-length") ?? 0);
      await discard(response);
      if (Number.isFinite(length) && length > 0) {
        this.size = length;
      }
      this.etag = response.headers.get("etag");
      this.lastModified = response.headers.get("last-modified");
      throw new HttpError(
        400,
        `${new URL(this.url).host} does not support HTTP Range requests (needed for on-demand GGUF reads)`,
        { code: "range_not_supported" },
      );
    }

    await discard(response);
    throw statusError(response.status, this.url);
  }

  /**
   * @param {number} offset
   * @param {number} length
   * @returns {Promise<Buffer>}
   */
  async read(offset, length) {
    if (this.closed) throw new Error("range source is closed");
    if (!Number.isInteger(offset) || offset < 0) {
      throw new RangeError(`invalid read offset ${offset}`);
    }
    if (length <= 0 || offset >= this.size) return Buffer.alloc(0);
    const end = Math.min(offset + length, this.size);
    const firstBlock = Math.floor(offset / this.blockSize);
    const lastBlock = Math.floor((end - 1) / this.blockSize);
    await this.#ensureBlocks(firstBlock, lastBlock);

    const parts = [];
    for (let index = firstBlock; index <= lastBlock; index += 1) {
      const block = this.blocks.get(index);
      if (!block) continue;
      const blockStart = index * this.blockSize;
      const from = Math.max(offset, blockStart) - blockStart;
      const to = Math.min(end, blockStart + block.length) - blockStart;
      if (to > from) parts.push(block.subarray(from, to));
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  }

  /**
   * @param {number} firstBlock
   * @param {number} lastBlock
   */
  async #ensureBlocks(firstBlock, lastBlock) {
    /** @type {number[]} */
    const missing = [];
    for (let index = firstBlock; index <= lastBlock; index += 1) {
      if (this.blocks.has(index)) {
        this.stats.cacheHits += 1;
        // Refresh insertion order for a cheap LRU.
        const value = this.blocks.get(index);
        this.blocks.delete(index);
        this.blocks.set(index, /** @type {Buffer} */ (value));
      } else {
        this.stats.cacheMisses += 1;
        missing.push(index);
      }
    }
    if (missing.length === 0) return;

    // Coalesce contiguous misses into one request (most header parsing is).
    let runStart = missing[0];
    let previous = missing[0];
    for (const index of missing.slice(1)) {
      if (index === previous + 1) {
        previous = index;
        continue;
      }
      await this.#fetchBlocks(runStart, previous);
      runStart = index;
      previous = index;
    }
    await this.#fetchBlocks(runStart, previous);
  }

  /**
   * @param {number} firstBlock
   * @param {number} lastBlock
   */
  async #fetchBlocks(firstBlock, lastBlock) {
    const start = firstBlock * this.blockSize;
    const end = Math.min((lastBlock + 1) * this.blockSize, this.size) - 1;
    /** @type {Record<string, string>} */
    const headers = {
      "User-Agent": USER_AGENT,
      "Accept-Encoding": "identity",
      Range: `bytes=${start}-${end}`,
      ...this.headers,
    };
    if (this.etag) headers["If-Range"] = this.etag;

    const response = await this.#fetchWithRetry(this.url, { headers, method: "GET" });
    this.stats.requests += 1;

    if (response.status !== 206) {
      await discard(response);
      if (response.status === 416) {
        throw new HttpError(416, `requested range ${start}-${end} is not satisfiable on ${this.url}`, {
          code: "range_not_satisfiable",
        });
      }
      throw statusError(response.status, this.url);
    }

    const range = parseContentRange(response.headers.get("content-range"));
    if (range && range.start !== start) {
      await discard(response);
      throw upstream(`server returned range ${range.start}-${range.end} instead of ${start}-${end}`);
    }

    const body = Buffer.from(await response.arrayBuffer());
    this.stats.bytesFetched += body.length;
    if (body.length === 0) return;

    for (let index = firstBlock; index <= lastBlock; index += 1) {
      const blockStart = index * this.blockSize;
      const from = Math.max(0, blockStart - start);
      const to = Math.min(body.length, blockStart + this.blockSize - start);
      if (to <= from) continue;
      this.blocks.set(index, body.subarray(from, to));
    }
    this.#evict();
  }

  #evict() {
    while (this.blocks.size > this.maxBlocks) {
      const oldest = this.blocks.keys().next().value;
      if (oldest === undefined) break;
      this.blocks.delete(oldest);
    }
  }

  /**
   * @param {string} url
   * @param {RequestInit} init
   */
  async #fetchWithRetry(url, init) {
    let lastError = null;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      if (this.signal?.aborted) throw abortError();
      try {
        const response = await this.fetchImpl(url, {
          ...init,
          redirect: "follow",
          signal: this.signal,
        });
        if (response.status === 429 || response.status >= 500) {
          lastError = upstream(`HTTP ${response.status} from ${url}`);
          await discard(response);
          if (attempt < this.retries) {
            await delay(150 * 2 ** attempt, this.signal);
            continue;
          }
          throw lastError;
        }
        return response;
      } catch (error) {
        if (/** @type {Error} */ (error)?.name === "AbortError") throw abortError();
        lastError = error;
        if (attempt < this.retries) {
          await delay(150 * 2 ** attempt, this.signal);
          continue;
        }
        throw upstream(`request to ${url} failed: ${describeFetchError(error)}`, error);
      }
    }
    throw lastError ?? upstream(`request to ${url} failed`);
  }

  async close() {
    this.closed = true;
    this.blocks.clear();
  }
}

/**
 * Inspect a remote GGUF without downloading it: metadata, tensor descriptors and
 * the number of bytes/requests actually spent.
 *
 * @param {string} input URL or `hf:repo:file.gguf`
 * @param {{fetchImpl?: FetchLike, hfToken?: string, allowInsecure?: boolean,
 *          blockSize?: number, signal?: AbortSignal, headers?: Record<string, string>}} [options]
 */
export async function inspectRemoteModel(input, options = {}) {
  const target = resolveRemoteTarget(input, options);
  const source = new HttpRangeSource(target.url, {
    headers: { ...target.headers, ...(options.headers ?? {}) },
    fetchImpl: options.fetchImpl,
    signal: options.signal,
    blockSize: options.blockSize,
  });
  await source.open();
  try {
    const info = await readGgufInfoFromSource(source, {
      readTensors: true,
      chunkSize: source.blockSize,
      maxBuffer: source.blockSize,
    });
    return {
      url: target.url,
      name: target.suggestedName,
      size: source.size,
      etag: source.etag,
      info,
      stats: { ...source.stats },
    };
  } finally {
    await source.close();
  }
}

/**
 * Read a slice of one tensor. This is the "only tensor reads trigger HTTP
 * traffic" path: metadata comes from cache, the payload from a fresh request.
 *
 * @param {string} input URL or `hf:` reference
 * @param {string} tensorName exact name or unique substring
 * @param {{maxBytes?: number, fetchImpl?: FetchLike, hfToken?: string, signal?: AbortSignal,
 *          blockSize?: number, headers?: Record<string, string>}} [options]
 */
export async function readRemoteTensor(input, tensorName, options = {}) {
  const target = resolveRemoteTarget(input, options);
  const source = new HttpRangeSource(target.url, {
    headers: { ...target.headers, ...(options.headers ?? {}) },
    fetchImpl: options.fetchImpl,
    signal: options.signal,
    blockSize: options.blockSize,
  });
  await source.open();
  try {
    const info = await readGgufInfoFromSource(source, {
      readTensors: true,
      chunkSize: source.blockSize,
      maxBuffer: source.blockSize,
    });
    const matches = info.tensors.filter((tensor) => tensor.name === tensorName);
    const candidates =
      matches.length > 0 ? matches : info.tensors.filter((tensor) => tensor.name.includes(tensorName));
    if (candidates.length === 0) {
      throw notFound(`tensor "${tensorName}" not found in ${target.url}`, "tensor_not_found");
    }
    if (candidates.length > 1) {
      throw badRequest(
        `tensor "${tensorName}" is ambiguous, matches: ${candidates.slice(0, 8).map((t) => t.name).join(", ")}`,
        "ambiguous_tensor",
      );
    }
    const tensor = candidates[0];
    const available = Math.max(0, info.sizeBytes - tensor.absOffset);
    // `maxBytes: 0` means "the whole tensor"; omitted means a 64 KB preview.
    const requested = options.maxBytes;
    const length = requested === 0 ? available : Math.min(requested ?? 64 * 1024, available);
    const bytes = await source.read(tensor.absOffset, length);
    return {
      url: target.url,
      info,
      tensor,
      bytes,
      stats: { ...source.stats },
    };
  } finally {
    await source.close();
  }
}

/**
 * Resolve a URL (or `hf:` reference) plus the headers needed to fetch it.
 * @param {string} input
 * @param {{hfToken?: string, allowInsecure?: boolean, hfEndpoint?: string}} [options]
 */
export function resolveRemoteTarget(input, options = {}) {
  const ref = parseReference(input);
  /** @type {Record<string, string>} */
  const headers = {};
  /** @type {string} */
  let url;
  if (ref.provider === "http") {
    url = /** @type {string} */ (ref.url);
  } else if (ref.provider === "hf") {
    url = huggingFaceUrl(String(ref.repo), String(ref.file), "main", options.hfEndpoint);
    if (options.hfToken) headers.Authorization = `Bearer ${options.hfToken}`;
  } else {
    throw badRequest(
      'remote inspection needs an http(s) URL or an "hf:repo:file.gguf" reference',
      "invalid_reference",
    );
  }
  if (url.startsWith("http://") && options.allowInsecure === false) {
    throw badRequest("insecure http:// downloads are disabled (set LOLLM_ALLOW_INSECURE=1)", "insecure_url");
  }
  return { url, headers, suggestedName: ref.suggestedName };
}

/**
 * `fetch failed` alone hides the useful part (DNS, TLS, blocked egress). Surface
 * the underlying cause so `lollm inspect` is diagnosable from the terminal.
 * @param {unknown} error
 */
function describeFetchError(error) {
  const message = /** @type {Error} */ (error)?.message ?? String(error);
  const cause = /** @type {any} */ (error)?.cause;
  const detail = cause?.code ?? cause?.message;
  return detail && !message.includes(String(detail)) ? `${message} (${detail})` : message;
}

/** @param {string | null} value */
function parseContentRange(value) {
  if (!value) return null;
  const match = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(value.trim());
  if (!match) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === "*" ? Number.NaN : Number(match[3]),
  };
}

/** @param {Response} response */
async function discard(response) {
  try {
    await response.body?.cancel();
  } catch {
    /* nothing to do */
  }
}

/**
 * @param {number} status
 * @param {string} url
 */
function statusError(status, url) {
  if (status === 404) return notFound(`remote model not found: ${url}`, "model_not_found");
  if (status === 401 || status === 403) {
    return new HttpError(401, `access denied by ${new URL(url).host}`, { code: "unauthorized" });
  }
  return upstream(`unexpected HTTP ${status} from ${url}`);
}

/** @param {number} ms @param {AbortSignal} [signal] */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(undefined);
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError() {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}
