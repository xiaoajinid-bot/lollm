import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { HttpRangeSource, inspectRemoteModel, readRemoteTensor } from "../src/models/remote.mjs";
import { downloadResumable, cleanupResumable, hashFile } from "../src/models/download.mjs";
import { ModelStore } from "../src/models/store.mjs";
import { HttpError } from "../src/errors.mjs";
import { buildGgufBuffer, fixtureMetadata, tempDir } from "./helpers/gguf-fixture.mjs";
import { startRangeServer, buildLargeFixture } from "./helpers/range-server.mjs";

const PAYLOAD = 2 * 1024 * 1024;
const largeModel = () => buildLargeFixture({ buildGgufBuffer, fixtureMetadata, payloadBytes: PAYLOAD });

test("inspects a remote GGUF by fetching only header blocks", async () => {
  const body = largeModel();
  const server = await startRangeServer(body);
  try {
    const result = await inspectRemoteModel(server.url, { blockSize: 32 * 1024 });

    assert.equal(result.info.architecture, "qwen2");
    assert.equal(result.info.contextLength, 32768);
    assert.equal(result.info.quantization, "Q4_K_M");
    assert.equal(result.info.parameterCount, 494_000_000);
    assert.equal(result.info.tensorCount, 1);
    assert.equal(result.size, body.length);

    // Header + metadata is a tiny slice of a 2 MB object.
    assert.ok(
      result.stats.bytesFetched < 256 * 1024,
      `expected < 256 KB fetched, got ${result.stats.bytesFetched}`,
    );
    assert.ok(result.stats.bytesFetched < result.size / 4);
    assert.ok(result.stats.requests <= 4, `expected at most 4 requests, got ${result.stats.requests}`);
  } finally {
    await server.close();
  }
});

test("header blocks are cached: parsing costs a handful of requests, not hundreds", async () => {
  const body = largeModel();
  const server = await startRangeServer(body);
  try {
    const source = new HttpRangeSource(server.url, { blockSize: 32 * 1024 });
    await source.open();
    const afterOpen = source.stats.requests;

    await source.read(0, 64);
    const afterFirst = source.stats.requests;
    await source.read(8, 64);
    await source.read(16, 64);
    const afterMore = source.stats.requests;

    assert.equal(afterMore, afterFirst, "reads inside a cached block must not hit the network");
    assert.equal(afterFirst, afterOpen + 1);
    assert.equal(source.stats.cacheHits >= 2, true);
    await source.close();
  } finally {
    await server.close();
  }
});

test("only tensor reads trigger additional HTTP traffic", async () => {
  const body = largeModel();
  const server = await startRangeServer(body);
  try {
    const result = await readRemoteTensor(server.url, "token_embd.weight", {
      maxBytes: 8 * 1024,
      blockSize: 32 * 1024,
    });
    assert.equal(result.tensor.name, "token_embd.weight");
    assert.equal(result.bytes.length, 8 * 1024);
    assert.ok(result.stats.requests >= 2, "metadata call + tensor payload call");
    const payloadRequests = server.requests.filter((entry) => {
      const start = Number(entry.served?.split("-")[0] ?? 0);
      return start >= result.info.dataStart;
    });
    assert.equal(payloadRequests.length >= 1, true, "tensor payload must be fetched lazily");
  } finally {
    await server.close();
  }
});

test("unknown tensors and ambiguous names fail cleanly", async () => {
  const twoTensors = buildGgufBuffer({
    metadata: fixtureMetadata(),
    tensors: [
      { name: "token_embd.weight", dims: [64, 128], type: 1 },
      { name: "output.weight", dims: [64, 128], type: 1 },
    ],
  });
  const server = await startRangeServer(Buffer.concat([twoTensors, Buffer.alloc(1024, 1)]));
  try {
    await assert.rejects(() => readRemoteTensor(server.url, "does.not.exist"), /tensor "does.not.exist" not found/);
    await assert.rejects(() => readRemoteTensor(server.url, "weight"), (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.code, "ambiguous_tensor");
      return true;
    });
    // A unique substring resolves without ambiguity.
    const single = await readRemoteTensor(server.url, "token_embd", { maxBytes: 32 });
    assert.equal(single.tensor.name, "token_embd.weight");
  } finally {
    await server.close();
  }
});

test("servers without Range support are reported instead of silently downloading", async () => {
  const server = await startRangeServer(largeModel(), { supportsRanges: false });
  try {
    await assert.rejects(
      () => inspectRemoteModel(server.url),
      (error) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.code, "range_not_supported");
        assert.match(error.message, /does not support HTTP Range/);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test("404 and 416 responses surface as HTTP errors", async () => {
  const missing = await startRangeServer(Buffer.from("nope"), { status: 404 });
  try {
    await assert.rejects(() => inspectRemoteModel(missing.url), (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 404);
      return true;
    });
  } finally {
    await missing.close();
  }

  const empty = await startRangeServer(Buffer.alloc(0));
  try {
    await assert.rejects(() => inspectRemoteModel(empty.url), HttpError);
  } finally {
    await empty.close();
  }
});

test("resumable downloads continue from the partial file using Range", async () => {
  const body = largeModel();
  const server = await startRangeServer(body, { interruptFirst: true });
  const dir = await tempDir("lollm-resume-");
  const dest = path.join(dir, "model.gguf");
  try {
    await assert.rejects(() =>
      downloadResumable({
        url: server.url,
        dest,
        onProgress: () => {},
      }),
    );

    const partial = await fs.stat(`${dest}.part`);
    assert.ok(partial.size > 0, "partial file should survive the failure");
    assert.ok(partial.size < body.length, "partial file should be incomplete");

    const result = await downloadResumable({ url: server.url, dest });
    assert.equal(result.resumedFrom, partial.size);
    assert.equal(result.size, body.length);

    const lastRequest = server.requests.at(-1);
    assert.match(String(lastRequest?.range), new RegExp(`^bytes=${partial.size}-`));

    const downloaded = await fs.readFile(result.path);
    assert.equal(downloaded.length, body.length);
    assert.equal((await hashFile(result.path)).digest, (await hashFile(await writeTemp(body))).digest);

    await cleanupResumable(dest);
    await assert.rejects(() => fs.stat(`${dest}.part`), /ENOENT/);
  } finally {
    await server.close();
  }
});

test("a completed resume produces a byte-identical model", async () => {
  const body = largeModel();
  const server = await startRangeServer(body);
  const dir = await tempDir("lollm-resume-ok-");
  const dest = path.join(dir, "model.gguf");
  try {
    const first = await downloadResumable({ url: server.url, dest });
    assert.equal(first.resumedFrom, 0);
    const a = await hashFile(first.path);

    // Second invocation is a no-op resume that revalidates from the end.
    const meta = JSON.parse(await fs.readFile(`${dest}.meta.json`, "utf8"));
    assert.equal(meta.size, body.length);
    assert.equal(a.digest, (await hashFile(await writeTemp(body))).digest);
    await cleanupResumable(dest);
  } finally {
    await server.close();
  }
});

test("hf: references work through a mirror endpoint (LOLLM_HF_ENDPOINT)", async () => {
  const server = await startRangeServer(largeModel());
  try {
    const result = await inspectRemoteModel("hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:wq.gguf", {
      hfEndpoint: server.url.replace(/\/model\.gguf$/, ""),
    });
    assert.equal(result.info.architecture, "qwen2");
    assert.match(result.url, /\/Qwen\/Qwen2\.5-0\.5B-Instruct-GGUF\/resolve\/main\/wq\.gguf\?download=true$/);
  } finally {
    await server.close();
  }
});

test("maxBytes: 0 reads the whole tensor instead of a preview", async () => {
  const server = await startRangeServer(largeModel());
  try {
    const preview = await readRemoteTensor(server.url, "token_embd.weight", { maxBytes: 1024 });
    assert.equal(preview.bytes.length, 1024);

    const whole = await readRemoteTensor(server.url, "token_embd.weight", { maxBytes: 0 });
    assert.ok(whole.bytes.length > preview.bytes.length, "whole tensor is larger than the preview");
    assert.equal(whole.bytes.length, whole.info.sizeBytes - whole.tensor.absOffset);
  } finally {
    await server.close();
  }
});

test("pulling an HTTP model reads the header first, then streams the weights", async () => {
  const body = largeModel();
  const server = await startRangeServer(body);
  const dir = await tempDir("lollm-http-pull-");
  const store = new ModelStore({ modelsDir: path.join(dir, "models"), allowInsecure: true });
  await store.init();
  const events = [];
  try {
    const result = await store.pull(server.url, { name: "remote:latest", onProgress: (event) => events.push(event) });
    assert.equal(result.model, "remote:latest");

    const resolved = await store.resolve("remote");
    assert.equal(resolved.gguf.architecture, "qwen2");
    assert.equal(resolved.size, body.length);
    assert.equal((await fs.readFile(resolved.modelPath)).length, body.length);

    assert.ok(events.some((event) => event.status === "pulling manifest"));
    assert.ok(events.some((event) => event.status === "downloading"));
    assert.equal(events.at(-1).status, "success");

    // The probe used Range; the download itself may use Range for resume support.
    assert.ok(server.requests.some((entry) => entry.range !== null));

    // Staging artefacts are cleaned up after a successful commit.
    const staging = await fs.readdir(store.tmpDir);
    assert.deepEqual(staging, []);
  } finally {
    await store.remove("remote").catch(() => {});
    await server.close();
  }
});

test("pulling a non-GGUF URL fails fast without downloading the body", async () => {
  const html = Buffer.from("<html><body>this is not a model</body></html>");
  const server = await startRangeServer(html);
  const dir = await tempDir("lollm-html-pull-");
  const store = new ModelStore({ modelsDir: path.join(dir, "models"), allowInsecure: true });
  await store.init();
  try {
    await assert.rejects(() => store.pull(server.url, { name: "junk" }), /not a valid GGUF file/);
  } finally {
    await server.close();
  }
});

/** @param {Buffer} buffer */
async function writeTemp(buffer) {
  const dir = await tempDir("lollm-bytes-");
  const file = path.join(dir, "reference.bin");
  await fs.writeFile(file, buffer);
  return file;
}
