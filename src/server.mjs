import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Router } from "./router.mjs";
import { HttpError, notFound, toHttpError } from "./errors.mjs";
import { applyCors, readJson, sendJson } from "./util/http.mjs";
import { createNativeApi } from "./api/native.mjs";
import { createOpenAiApi } from "./api/openai.mjs";
import { APP_NAME, VERSION } from "./version.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLAYGROUND_FILE = path.join(here, "..", "web", "playground.html");

/**
 * Build the HTTP server (without listening) so tests can bind port 0.
 *
 * @param {{config: import("./config.mjs").Config,
 *          store: import("./models/store.mjs").ModelStore,
 *          engine: import("./engine/engine.mjs").Engine,
 *          logger: import("./logger.mjs").Logger}} deps
 */
export function createServer(deps) {
  return http.createServer(createHandler(deps));
}

/**
 * Build the request handler only (no listening socket). Serverless platforms
 * such as Vercel hand us a single request/response pair, and this is the seam
 * they reuse so the whole API — Ollama, OpenAI and the playground — runs there
 * unchanged.
 *
 * @param {{config: import("./config.mjs").Config,
 *          store: import("./models/store.mjs").ModelStore,
 *          engine: import("./engine/engine.mjs").Engine,
 *          logger: import("./logger.mjs").Logger}} deps
 */
export function createHandler(deps) {
  const { config, store, engine, logger } = deps;
  const router = new Router();
  const nativeApi = createNativeApi({ engine, store, config, logger });
  const openAiApi = createOpenAiApi({ engine, store, config, logger });
  nativeApi.register(router);
  openAiApi.register(router);

  /** @type {string | null} */
  let playgroundCache = null;
  const playground = async (/** @type {import("./router.mjs").RequestContext} */ ctx) => {
    if (playgroundCache === null) {
      playgroundCache = await fs.readFile(PLAYGROUND_FILE, "utf8").catch(() => {
        throw notFound("playground is not available in this installation", "playground_missing");
      });
    }
    ctx.res.statusCode = 200;
    ctx.res.setHeader("Content-Type", "text/html; charset=utf-8");
    ctx.res.setHeader("Cache-Control", "no-cache");
    ctx.res.end(playgroundCache);
  };
  if (config.playground !== false) {
    router.get("/playground", playground);
    router.get("/ui", playground);
  }

  const handle = async (/** @type {import("node:http").IncomingMessage} */ req, /** @type {import("node:http").ServerResponse} */ res) => {
    const startedAt = Date.now();
    const requestId = Math.random().toString(36).slice(2, 10);
    res.setHeader("X-Request-Id", requestId);
    applyCors(res);

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });

    const isOpenAi = url.pathname.startsWith("/v1/");
    try {
      const match = router.match(req.method ?? "GET", url.pathname);
      if (!match) {
        throw notFound(`unknown endpoint ${req.method} ${url.pathname}`, "unknown_endpoint");
      }
      if ("allow" in match) {
        res.setHeader("Allow", match.allow.join(", "));
        throw new HttpError(405, `method ${req.method} is not allowed on ${url.pathname}`, {
          code: "method_not_allowed",
        });
      }
      await match.handler({ req, res, params: match.params, url, signal: controller.signal });
    } catch (error) {
      const httpError = toHttpError(error);
      const level = httpError.status >= 500 ? "error" : "warn";
      const detail =
        httpError.status >= 500 && !httpError.expose
          ? `${httpError.status} ${/** @type {Error} */ (httpError.cause ?? httpError).stack ?? httpError.message}`
          : `${httpError.status} ${httpError.message}`;
      if (httpError.status !== 499) logger[level](`${req.method} ${url.pathname} → ${detail}`);

      if (res.headersSent || res.writableEnded) {
        res.destroy();
        return;
      }
      const message = httpError.expose
        ? httpError.message
        : "internal server error (see server logs)";
      if (isOpenAi) {
        sendJson(res, httpError.status === 499 ? 500 : httpError.status, {
          error: {
            message,
            type: httpError.type,
            param: null,
            code: httpError.code ?? null,
          },
        });
      } else {
        sendJson(res, httpError.status === 499 ? 500 : httpError.status, {
          error: message,
          ...(httpError.code ? { code: httpError.code } : {}),
        });
      }
    } finally {
      if (config.verbose) {
        logger.debug(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - startedAt}ms`);
      }
    }
  };

  return handle;
}

/**
 * Bind the server and return a small lifecycle handle.
 *
 * @param {{config: import("./config.mjs").Config,
 *          store: import("./models/store.mjs").ModelStore,
 *          engine: import("./engine/engine.mjs").Engine,
 *          logger: import("./logger.mjs").Logger}} deps
 */
export async function startServer(deps) {
  const { config, engine, logger } = deps;
  const server = createServer(deps);
  server.on("clientError", (error, socket) => {
    logger.warn(`client error: ${error.message}`);
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(undefined);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(config.port, config.host);
  });

  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  const host = address.address === "::" || address.address === "0.0.0.0" ? address.address : address.address;
  const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const url = `http://${displayHost.includes(":") ? `[${displayHost}]` : displayHost}:${address.port}`;

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise((resolve) => server.close(resolve));
    await engine.dispose();
  };

  logger.info(`${APP_NAME} ${VERSION} listening on ${url}`);
  return { server, url, port: address.port, host, close };
}

export { readJson };
