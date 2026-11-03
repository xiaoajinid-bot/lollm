#!/usr/bin/env node
/**
 * End-to-end smoke test for a *running* lollm instance (local or deployed).
 *
 * Usage:
 *   node scripts/smoke.mjs https://lollm-ai-pied.vercel.app
 *   node scripts/smoke.mjs http://127.0.0.1:11434 --model qwen2.5:0.5b
 *   npm run smoke -- <url>
 *
 * Options:
 *   --model NAME   model to chat with (default: first model in /api/tags)
 *   --timeout MS   per-request timeout (default: 240000, serverless-friendly)
 *   --json         print a JSON report instead of lines
 */
const argv = process.argv.slice(2);
const base = (argv.find((arg) => !arg.startsWith("--") && /^https?:\/\//.test(arg)) ?? "").replace(/\/$/, "");
const modelIndex = argv.indexOf("--model");
const modelArg = modelIndex >= 0 ? argv[modelIndex + 1] : undefined;
const timeoutIndex = argv.indexOf("--timeout");
const timeout = timeoutIndex >= 0 ? Number(argv[timeoutIndex + 1]) : 240_000;
const json = argv.includes("--json");

if (!base) {
  process.stderr.write("usage: node scripts/smoke.mjs <base-url> [--model NAME] [--timeout MS] [--json]\n");
  process.exit(2);
}

/** @type {Array<{name: string, ok: boolean, ms: number, detail: string}>} */
const results = [];

/**
 * @param {string} name
 * @param {() => Promise<string>} run
 */
async function check(name, run) {
  const startedAt = Date.now();
  try {
    const detail = await run();
    results.push({ name, ok: true, ms: Date.now() - startedAt, detail });
  } catch (error) {
    results.push({
      name,
      ok: false,
      ms: Date.now() - startedAt,
      detail: String(/** @type {Error} */ (error)?.message ?? error),
    });
  }
}

/**
 * @param {string} path
 * @param {RequestInit} [init]
 */
async function request(path, init) {
  const response = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeout) });
  return response;
}

/**
 * @param {string} path
 * @param {unknown} body
 */
function postJson(path, body) {
  return request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

await check("GET /", async () => {
  const response = await request("/");
  if (response.status !== 200) throw new Error(`status ${response.status}`);
  return (await response.text()).trim().slice(0, 40);
});

await check("GET /api/version", async () => {
  const response = await request("/api/version");
  const body = await response.json();
  if (!body.lollm) throw new Error(`unexpected body ${JSON.stringify(body)}`);
  return `lollm ${body.lollm} / ollama ${body.version}`;
});

let model = modelArg;
await check("GET /api/tags", async () => {
  const response = await request("/api/tags");
  const body = await response.json();
  const models = body.models ?? [];
  if (models.length === 0) throw new Error("no models installed");
  model ??= models[0].model ?? models[0].name;
  return models.map((entry) => entry.name).join(", ");
});

await check("GET /playground", async () => {
  const response = await request("/playground");
  if (response.status !== 200) throw new Error(`status ${response.status}`);
  const html = await response.text();
  if (!html.includes("<")) throw new Error("empty document");
  return `${html.length} bytes`;
});

await check("POST /api/chat (stream=false)", async () => {
  const response = await postJson("/api/chat", {
    model,
    messages: [{ role: "user", content: "Say hello in one short sentence." }],
    stream: false,
  });
  const body = await response.json();
  if (!body.done) throw new Error(`done=${body.done}`);
  const content = String(body.message?.content ?? "");
  if (content.length === 0) throw new Error("empty completion");
  return `${body.eval_count ?? "?"} tokens: ${content.replace(/\s+/g, " ").slice(0, 80)}`;
});

await check("POST /api/chat (stream=true)", async () => {
  const response = await postJson("/api/chat", {
    model,
    messages: [{ role: "user", content: "Count from one to three." }],
    stream: true,
  });
  if (!response.body) throw new Error("no body");
  let chunks = 0;
  let text = "";
  for await (const chunk of /** @type {any} */ (response.body)) {
    chunks += 1;
    for (const line of Buffer.from(chunk).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      text += event.message?.content ?? "";
    }
  }
  if (chunks === 0) throw new Error("no chunks");
  return `${chunks} chunks: ${text.replace(/\s+/g, " ").slice(0, 60)}`;
});

await check("POST /v1/chat/completions", async () => {
  const response = await postJson("/v1/chat/completions", {
    model,
    messages: [{ role: "user", content: "Reply with the word: pong" }],
  });
  const body = await response.json();
  const content = String(body.choices?.[0]?.message?.content ?? "");
  if (content.length === 0) throw new Error("empty completion");
  return `${body.usage?.completion_tokens ?? "?"} tokens`;
});

const failed = results.filter((result) => !result.ok);
// Details come from a remote server, so they go to stdout as data rather than
// through a log sink that could interpret them.
const text = json
  ? JSON.stringify({ base, model, results }, null, 2)
  : [
      ...results.map(
        (result) => `${result.ok ? "PASS" : "FAIL"}  ${result.name}  ${result.ms}ms  ${result.detail}`,
      ),
      failed.length === 0 ? "\nall checks passed" : `\n${failed.length} check(s) failed`,
    ].join("\n");
process.stdout.write(`${text}\n`);
process.exit(failed.length === 0 ? 0 : 1);
