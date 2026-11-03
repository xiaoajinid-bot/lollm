import { writeChunk } from "./http.mjs";

/**
 * OpenAI-compatible Server-Sent Events stream.
 * @param {import("node:http").ServerResponse} res
 * @param {{event?: string}} [options]
 */
export function startSse(res, options = {}) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  let done = false;
  const frame = (payload) => {
    const prefix = options.event ? `event: ${options.event}\n` : "";
    return `${prefix}data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`;
  };
  return {
    /** @param {unknown} payload */
    async write(payload) {
      if (done) return;
      await writeChunk(res, frame(payload));
    },
    /** Keep proxies from closing an idle stream. */
    async comment(text = "keep-alive") {
      if (done) return;
      await writeChunk(res, `: ${text}\n\n`);
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
