import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { tempDir } from "./helpers/gguf-fixture.mjs";

/**
 * The Vercel entrypoint is plain Node: a handler that owns request/response. The
 * test mounts it on a throwaway socket, which is exactly what the platform does
 * per invocation (minus the socket).
 */
test("the serverless entrypoint serves the API without listening on its own", async (t) => {
  const home = await tempDir("lollm-vercel-");
  process.env.LOLLM_HOME = home;
  process.env.LOLLM_BACKEND = "mock";

  const { default: handler } = await import("../api/index.mjs");
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(home, { recursive: true, force: true });
  });

  const root = await fetch(`${base}/`);
  assert.equal(root.status, 200);
  assert.equal(await root.text(), "Ollama is running");

  const version = await (await fetch(`${base}/api/version`)).json();
  assert.equal(typeof version.version, "string");
  assert.equal(version.lollm, (await import("../package.json", { with: { type: "json" } })).default.version);

  const playground = await fetch(`${base}/playground`);
  assert.equal(playground.status, 200);
  assert.match(await playground.text(), /lollm/);

  // The demo model is seeded on a cold, empty store so the playground is usable.
  const tags = await (await fetch(`${base}/api/tags`)).json();
  assert.ok(tags.models.some((model) => model.name.startsWith("lollm-demo")), JSON.stringify(tags));

  const chat = await (
    await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "lollm-demo",
        messages: [{ role: "user", content: "halo" }],
        stream: false,
      }),
    })
  ).json();
  assert.equal(chat.done, true);
  assert.match(chat.message.content, /halo/);

  const openai = await (
    await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "lollm-demo", messages: [{ role: "user", content: "hi" }] }),
    })
  ).json();
  assert.equal(openai.object, "chat.completion");
  assert.equal(openai.model, "lollm-demo:latest");
});
