import http from "node:http";
import fs from "node:fs/promises";

/**
 * A tiny static file server that implements HTTP Range requests, used to test
 * on-demand GGUF reads and resumable downloads without touching the network.
 *
 * @param {Buffer} body
 * @param {{supportsRanges?: boolean, status?: number, interruptFirst?: boolean, etag?: string}} [options]
 */
export async function startRangeServer(body, options = {}) {
  const supportsRanges = options.supportsRanges ?? true;
  const etag = options.etag ?? '"fixture-etag"';
  /** @type {Array<{method: string | undefined, range: string | null, status: number, bytes: number, served?: string}>} */
  const requests = [];
  let interrupted = false;

  const server = http.createServer((req, res) => {
    /** @type {{method: string | undefined, range: string | null, status: number, bytes: number, served?: string}} */
    const entry = { method: req.method, range: req.headers.range ?? null, status: 200, bytes: 0 };
    requests.push(entry);

    if (options.status && options.status >= 400) {
      entry.status = options.status;
      res.statusCode = options.status;
      res.setHeader("Content-Type", "text/plain");
      res.end(`error ${options.status}`);
      return;
    }

    res.setHeader("ETag", etag);

    if (req.method === "HEAD") {
      entry.status = 200;
      res.setHeader("Accept-Ranges", supportsRanges ? "bytes" : "none");
      res.setHeader("Content-Length", body.length);
      res.end();
      return;
    }

    if (!supportsRanges || !req.headers.range) {
      entry.status = 200;
      entry.bytes = body.length;
      res.statusCode = 200;
      res.setHeader("Accept-Ranges", supportsRanges ? "bytes" : "none");
      res.setHeader("Content-Length", body.length);
      if (maybeInterrupt(res, body)) return;
      res.end(body);
      return;
    }

    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
    if (!match) {
      entry.status = 200;
      res.statusCode = 200;
      res.end(body);
      return;
    }

    const start = Number(match[1]);
    let end = match[2] === "" ? body.length - 1 : Number(match[2]);
    end = Math.min(end, body.length - 1);
    if (start >= body.length || start > end) {
      entry.status = 416;
      res.statusCode = 416;
      res.setHeader("Content-Range", `bytes */${body.length}`);
      res.end();
      return;
    }

    const slice = body.subarray(start, end + 1);
    entry.status = 206;
    entry.bytes = slice.length;
    entry.served = `${start}-${end}`;
    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${start}-${end}/${body.length}`);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", slice.length);

    if (maybeInterrupt(res, slice)) return;
    res.end(slice);
  });

  /**
   * Drop the connection halfway through the first large body, simulating a
   * flaky network so resumable downloads have something to resume from.
   * @param {import("node:http").ServerResponse} res
   * @param {Buffer} slice
   * @returns {boolean} true when the response was interrupted
   */
  function maybeInterrupt(res, slice) {
    if (!options.interruptFirst || interrupted || slice.length <= 64 * 1024) return false;
    interrupted = true;
    res.write(slice.subarray(0, Math.max(1, Math.floor(slice.length / 2))));
    setTimeout(() => res.destroy(), 5);
    return true;
  }

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());

  return {
    url: `http://127.0.0.1:${address.port}/model.gguf`,
    port: address.port,
    requests,
    bytesServed: () => requests.reduce((sum, entry) => sum + entry.bytes, 0),
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * Build a GGUF fixture with a large tensor payload appended, so metadata is a
 * tiny fraction of the file — exactly the case where Range requests pay off.
 *
 * @param {{buildGgufBuffer: Function, fixtureMetadata: Function, payloadBytes?: number}} input
 */
export function buildLargeFixture(input) {
  const buffer = input.buildGgufBuffer({
    metadata: input.fixtureMetadata(),
    tensors: [
      // The weights live deep inside the file: a header read must not touch them.
      {
        name: "token_embd.weight",
        dims: [512, 4096],
        type: 1,
        offset: Math.floor((input.payloadBytes ?? 2 * 1024 * 1024) / 2),
      },
    ],
  });
  const payload = Buffer.alloc(input.payloadBytes ?? 2 * 1024 * 1024, 7);
  return Buffer.concat([buffer, payload]);
}

/** @param {string} filePath */
export async function readFileBuffer(filePath) {
  return fs.readFile(filePath);
}
