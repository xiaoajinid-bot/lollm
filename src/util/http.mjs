import { HttpError } from "../errors.mjs";

/** @typedef {import("node:http").IncomingMessage} IncomingMessage */
/** @typedef {import("node:http").ServerResponse} ServerResponse */

/** @param {OutgoingHttpHeadersLike} headers */
const setIfAbsent = (headers, name, value) => {
  if (!headers[name]) headers[name] = value;
};

/** @typedef {Record<string, string | number | string[]>} OutgoingHttpHeadersLike */

/**
 * Permissive CORS: the server is meant to be consumed by browsers, SDKs and
 * local tooling, so every endpoint is readable cross-origin.
 * @param {ServerResponse} res
 */
export function applyCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Accept, X-Requested-With, X-Api-Key",
  );
  res.setHeader("Access-Control-Expose-Headers", "Content-Type, X-Request-Id");
  res.setHeader("Access-Control-Max-Age", "86400");
}

/**
 * @param {ServerResponse} res
 * @param {number} status
 * @param {unknown} data
 * @param {OutgoingHttpHeadersLike} [headers]
 */
export function sendJson(res, status, data, headers = {}) {
  const body = Buffer.from(JSON.stringify(data ?? null));
  res.statusCode = status;
  setIfAbsent(headers, "Content-Type", "application/json; charset=utf-8");
  setIfAbsent(headers, "Content-Length", body.length);
  setIfAbsent(headers, "Cache-Control", "no-store");
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.end(body);
}

/**
 * @param {ServerResponse} res
 * @param {number} status
 * @param {string} text
 * @param {OutgoingHttpHeadersLike} [headers]
 */
export function sendText(res, status, text, headers = {}) {
  const body = Buffer.from(text);
  res.statusCode = status;
  setIfAbsent(headers, "Content-Type", "text/plain; charset=utf-8");
  setIfAbsent(headers, "Content-Length", body.length);
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.end(body);
}

/**
 * Read the raw request body. A `limit` of 0, null or undefined means unlimited,
 * which is the default: lollm only refuses a body when a cap is configured.
 * @param {IncomingMessage} req
 * @param {{limit?: number | null}} [options]
 * @returns {Promise<Buffer>}
 */
export async function readBody(req, options = {}) {
  const requested = options.limit;
  const limit = typeof requested === "number" && requested > 0 ? requested : Infinity;
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > limit) {
      throw new HttpError(413, `request body exceeds ${limit} bytes`, { code: "body_too_large" });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * Read and parse a JSON body. An entirely empty body yields `{}`.
 * @param {IncomingMessage} req
 * @param {{limit?: number}} [options]
 * @returns {Promise<Record<string, any>>}
 */
export async function readJson(req, options = {}) {
  const raw = await readBody(req, options);
  if (raw.length === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new HttpError(400, `invalid JSON body: ${/** @type {Error} */ (error).message}`, {
      code: "invalid_json",
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "JSON body must be an object", { code: "invalid_json" });
  }
  return parsed;
}

/**
 * Parse `?a=1&b=2` into an object (last value wins).
 * @param {string} search
 */
export function parseQuery(search) {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of params) out[key] = value;
  return out;
}

/** @param {string | undefined} accept */
export const wantsHtml = (accept = "") => accept.includes("text/html");

/**
 * Write a chunk respecting backpressure. Resolves when it is safe to continue.
 * @param {ServerResponse} res
 * @param {string} chunk
 */
export function writeChunk(res, chunk) {
  if (res.destroyed || res.writableEnded) return Promise.reject(new HttpError(499, "client disconnected"));
  if (res.write(chunk)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new HttpError(499, "client disconnected"));
    };
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("close", onClose);
    };
    res.once("drain", onDrain);
    res.once("close", onClose);
  });
}
