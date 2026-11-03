#!/usr/bin/env node
/**
 * Timing probe for a running instance: reports the cold-start state, then one
 * short completion with per-phase timings (boot, load, prompt eval, generation).
 *
 * Usage:
 *   node scripts/probe.mjs https://<deployment> [--model NAME] [--num-predict N] [--json]
 */
const argv = process.argv.slice(2);
const base = (argv.find((arg) => !arg.startsWith("--") && /^https?:\/\//.test(arg)) ?? "").replace(/\/$/, "");
const valueOf = (/** @type {string} */ flag, /** @type {string} */ fallback) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : fallback;
};
const model = valueOf("--model", "");
const numPredict = Number(valueOf("--num-predict", "16"));
const json = argv.includes("--json");

if (!base) {
  console.error("usage: node scripts/probe.mjs <base-url> [--model NAME] [--num-predict N] [--json]");
  process.exit(2);
}

const startedAt = Date.now();
const boot = await (await fetch(`${base}/api/boot?t=${Date.now()}`, { signal: AbortSignal.timeout(60_000) })).json();
const bootMs = Date.now() - startedAt;

const tags = await (await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(60_000) })).json();
const models = (tags.models ?? []).map((entry) => entry.name);
const target = model || models[0];

/**
 * @param {number} startedAt
 * @param {any} body
 */
function describe(startedAt, body) {
  const at = (/** @type {number | undefined} */ value) => (value ? Math.round(value / 1e6) : undefined);
  return {
    status: 200,
    content: String(body.message?.content ?? "").slice(0, 120),
    prompt_eval_count: body.prompt_eval_count,
    eval_count: body.eval_count,
    total_ms: Date.now() - startedAt,
    reported_total_ms: at(body.total_duration),
    load_ms: at(body.load_duration),
    prompt_eval_ms: at(body.prompt_eval_duration),
    eval_ms: at(body.eval_duration),
  };
}

const chatStartedAt = Date.now();
let chat;
try {
  const response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: target,
      messages: [{ role: "user", content: "Hi" }],
      stream: false,
      options: { num_predict: numPredict },
    }),
    signal: AbortSignal.timeout(280_000),
  });
  const body = await response.json();
  chat = body.error ? { status: response.status, error: body.error } : describe(chatStartedAt, body);
} catch (error) {
  chat = { error: String(/** @type {Error} */ (error)?.message ?? error) };
}

// A second request on the same instance shows the warm path: no boot, no download,
// no model load.
const warmStartedAt = Date.now();
let warm;
try {
  const response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: target,
      messages: [{ role: "user", content: "Hi again" }],
      stream: false,
      options: { num_predict: numPredict },
    }),
    signal: AbortSignal.timeout(280_000),
  });
  const body = await response.json();
  warm = body.error ? { status: response.status, error: body.error } : describe(warmStartedAt, body);
} catch (error) {
  warm = { error: String(/** @type {Error} */ (error)?.message ?? error) };
}

const report = { base, model: target, models, bootMs, boot, chat, warm };
if (json) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`base      ${report.base}`);
  console.log(`models    ${models.join(", ") || "(none)"}`);
  console.log(`boot      ${bootMs} ms  ${JSON.stringify(boot)}`);
  console.log(`chat      ${JSON.stringify(chat)}`);
  console.log(`warm      ${JSON.stringify(warm)}`);
}
process.exit(chat.error || warm.error ? 1 : 0);
