import { writeChunk } from "./http.mjs";

/**
 * Ollama's native streaming format: one JSON object per line, newline framed,
 * `application/x-ndjson`.
 * @param {import("node:http").ServerResponse} res
 */
export function startNdjson(res) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Transfer-Encoding", "chunked");
  res.flushHeaders?.();
  let done = false;
  return {
    /** @param {unknown} payload */
    async write(payload) {
      if (done) return;
      await writeChunk(res, `${JSON.stringify(payload)}\n`);
    },
    async end() {
      if (done) return;
      done = true;
      res.end();
    },
    get closed() {
      return done || res.destroyed || res.writableEnded;
    },
  };
}
