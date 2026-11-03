import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { ModelStore } from "../src/models/store.mjs";
import { buildGgufBuffer, fixtureMetadata, tempDir } from "./helpers/gguf-fixture.mjs";
import { startRangeServer } from "./helpers/range-server.mjs";

/**
 * @param {string} dir
 * @returns {Promise<number>}
 */
async function totalBytes(dir) {
  let total = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await totalBytes(full);
    else total += (await fs.stat(full)).size;
  }
  return total;
}

/**
 * A serverless instance has ~512 MB of temporary storage, so a pull must never
 * hold the staging copy and the content-addressed blob at the same time.
 */
test("an HTTP pull adopts the staged file instead of copying it", async (t) => {
  const dir = await tempDir("lollm-pull-space-");
  const models = path.join(dir, "models");
  // 8 MB of payload: large enough that a second copy is unmistakable.
  const body = Buffer.concat([
    buildGgufBuffer({
      metadata: fixtureMetadata(),
      tensors: [{ name: "token_embd.weight", dims: [1024, 1024], type: 1 }],
    }),
    Buffer.alloc(8 * 1024 * 1024, 9),
  ]);
  const server = await startRangeServer(body);
  t.after(async () => {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const store = new ModelStore({ modelsDir: models, allowInsecure: true });
  await store.init();
  const result = await store.pull(server.url, { name: "tiny:latest" });

  assert.equal(result.size, body.length);
  assert.equal(result.model, "tiny:latest");

  const used = await totalBytes(dir);
  assert.ok(
    used < body.length * 1.5,
    `pull used ${used} bytes on disk for a ${body.length} byte model (a second copy would be ~${body.length * 2})`,
  );

  const resolved = await store.resolve("tiny:latest");
  assert.equal((await fs.stat(resolved.modelPath)).size, body.length);
  // No staging leftovers next to the blob.
  assert.deepEqual(
    (await fs.readdir(store.tmpDir)).filter((name) => name.startsWith("pull-")),
    [],
  );
});
