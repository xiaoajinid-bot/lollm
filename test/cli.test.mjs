import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";

import { buildGgufBuffer, fixtureMetadata, tempDir, writeGgufFixture } from "./helpers/gguf-fixture.mjs";
import { startRangeServer, buildLargeFixture } from "./helpers/range-server.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const BIN = path.join(ROOT, "bin", "lollm.mjs");

/**
 * Run the CLI and collect stdout/stderr.
 * @param {string[]} args
 * @param {{env?: Record<string, string>}} [options]
 */
async function run(args, options = {}) {
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    env: { ...process.env, NO_COLOR: "1", LOLLM_ALLOW_INSECURE: "1", ...options.env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolve) => child.on("close", resolve));
  return { code, stdout, stderr };
}

test("help lists the inspect command", async () => {
  const { code, stdout } = await run(["help"]);
  assert.equal(code, 0);
  assert.match(stdout, /inspect/);
  assert.match(stdout, /Range/);
});

test("inspect --json reports metadata without downloading the weights", async () => {
  const server = await startRangeServer(buildLargeFixture({ buildGgufBuffer, fixtureMetadata, payloadBytes: 2 * 1024 * 1024 }));
  try {
    const { code, stdout, stderr } = await run(["inspect", server.url, "--json"]);
    assert.equal(code, 0, stderr);
    const payload = JSON.parse(stdout);
    assert.equal(payload.model.architecture, "qwen2");
    assert.equal(payload.model.quantization, "Q4_K_M");
    assert.equal(payload.tensors.length, 1);
    assert.equal(payload.tensors[0].name, "token_embd.weight");
    assert.deepEqual(payload.tensors[0].dims, [512, 4096]);
    assert.ok(payload.size > 2 * 1024 * 1024);
    assert.ok(payload.stats.bytesFetched < payload.size / 2);
  } finally {
    await server.close();
  }
});

test("inspect --tensor reads only that tensor's bytes", async () => {
  const server = await startRangeServer(buildLargeFixture({ buildGgufBuffer, fixtureMetadata, payloadBytes: 1024 * 1024 }));
  try {
    const { code, stdout, stderr } = await run(["inspect", server.url, "--tensor", "token_embd", "--max-bytes", "4096"]);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /token_embd\.weight/);
    assert.match(stdout, /Range requests/);
    assert.ok(server.bytesServed() < 700 * 1024, `served ${server.bytesServed()} bytes`);
  } finally {
    await server.close();
  }
});

test("inspect refuses plain HTTP when insecure downloads are disabled", async () => {
  const server = await startRangeServer(buildLargeFixture({ buildGgufBuffer, fixtureMetadata, payloadBytes: 4096 }));
  try {
    const { code, stderr } = await run(["inspect", server.url], { env: { LOLLM_ALLOW_INSECURE: "0" } });
    assert.notEqual(code, 0);
    assert.match(stderr, /insecure/i);
  } finally {
    await server.close();
  }
});

test("--allow-insecure enables plain HTTP without the env var", async () => {
  const server = await startRangeServer(buildLargeFixture({ buildGgufBuffer, fixtureMetadata, payloadBytes: 4096 }));
  try {
    const { code, stderr } = await run(["inspect", server.url, "--allow-insecure"], {
      env: { LOLLM_ALLOW_INSECURE: "0" },
    });
    assert.equal(code, 0, stderr);
  } finally {
    await server.close();
  }
});

test("inspect surfaces a helpful error for non-GGUF files", async () => {
  const server = await startRangeServer(Buffer.from("definitely not a model"));
  try {
    const { code, stderr } = await run(["inspect", server.url]);
    assert.notEqual(code, 0);
    assert.match(stderr, /GGUF/i);
  } finally {
    await server.close();
  }
});

test("list works on an empty home and create/show round-trip a local GGUF", async () => {
  const home = await tempDir("lollm-cli-");
  const gguf = path.join(home, "tiny.gguf");
  await writeGgufFixture(gguf);

  const empty = await run(["list", "--home", home]);
  assert.equal(empty.code, 0, empty.stderr);
  assert.match(empty.stdout, /No models installed/i);

  const created = await run([
    "create",
    "tiny",
    "--from",
    gguf,
    "--system",
    "be brief",
    "--home",
    home,
  ]);
  assert.equal(created.code, 0, created.stderr);

  const list = await run(["list", "--home", home]);
  assert.match(list.stdout, /tiny/);

  const show = await run(["show", "tiny", "--home", home]);
  assert.equal(show.code, 0, show.stderr);
  assert.match(show.stdout, /qwen2/i);
  assert.match(show.stdout, /be brief/);

  const removed = await run(["rm", "tiny", "--home", home]);
  assert.equal(removed.code, 0, removed.stderr);

  const after = await run(["list", "--home", home]);
  assert.doesNotMatch(after.stdout, /^tiny/m);

  await fs.rm(home, { recursive: true, force: true });
});

test("unknown commands exit non-zero with a suggestion", async () => {
  const { code, stderr } = await run(["definitely-not-a-command"]);
  assert.notEqual(code, 0);
  assert.match(stderr, /unknown command/i);
});
