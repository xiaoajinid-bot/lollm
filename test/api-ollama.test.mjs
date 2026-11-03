import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { bootServer, parseNdjson } from "./helpers/server.mjs";

const CLASSIC_TEMPLATE = `{{ if .System }}<|im_start|>system
{{ .System }}<|im_end|>
{{ end }}<|im_start|>user
{{ .Prompt }}<|im_end|>
<|im_start|>assistant
`;

/** @param {Response} response */
const readJson = async (response) => {
  const body = await response.text();
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`expected JSON, got: ${body.slice(0, 200)}`);
  }
};

test("GET / answers the Ollama readiness probe", async () => {
  const server = await bootServer();
  try {
    const response = await server.fetch("/");
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "Ollama is running");
  } finally {
    await server.close();
  }
});

test("GET /api/version reports a compatible version plus the real build", async () => {
  const server = await bootServer();
  try {
    const body = await readJson(await server.fetch("/api/version"));
    assert.match(body.version, /^\d+\.\d+\.\d+$/);
    assert.equal(typeof body.lollm, "string");
  } finally {
    await server.close();
  }
});

test("GET /api/tags lists installed models with Ollama details", async () => {
  const server = await bootServer();
  try {
    const body = await readJson(await server.fetch("/api/tags"));
    assert.equal(body.models.length, 1);
    const [model] = body.models;
    assert.equal(model.name, "tiny:latest");
    assert.equal(model.model, model.name);
    assert.match(model.digest, /^sha256:/);
    assert.equal(model.details.format, "gguf");
    assert.equal(model.details.family, "qwen2");
    assert.equal(model.details.parameter_size, "494M");
    assert.equal(model.details.quantization_level, "Q4_K_M");
    assert.ok(new Date(model.modified_at).getTime() > 0);
  } finally {
    await server.close();
  }
});

test("POST /api/show returns template, modelfile and model_info", async () => {
  const server = await bootServer({ template: CLASSIC_TEMPLATE });
  try {
    const body = await readJson(
      await server.fetch("/api/show", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "templated" }),
      }),
    );
    assert.match(body.modelfile, /^FROM /);
    assert.match(body.template, /im_start/);
    assert.equal(body.system, "You are terse.");
    assert.match(body.parameters, /temperature 0.2/);
    assert.equal(body.details.quantization_level, "Q4_K_M");
    assert.equal(body.model_info["general.architecture"], "qwen2");
    assert.deepEqual(body.capabilities, ["completion", "tools"]);
  } finally {
    await server.close();
  }
});

test("POST /api/chat streams NDJSON chunks and a final stats frame", async () => {
  const server = await bootServer();
  try {
    const response = await server.fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "tiny",
        messages: [{ role: "user", content: "hello there" }],
        stream: true,
      }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /application\/x-ndjson/);
    const frames = parseNdjson(await response.text());

    assert.equal(frames[0].done, false);
    assert.equal(frames[0].message.role, "assistant");
    const text = frames
      .filter((frame) => !frame.done)
      .map((frame) => frame.message.content)
      .join("");
    assert.match(text, /hello there/);

    const final = frames.at(-1);
    assert.equal(final.done, true);
    assert.equal(final.done_reason, "stop");
    assert.ok(final.eval_count > 0);
    assert.ok(final.total_duration > 0);
    assert.equal(typeof final.created_at, "string");
  } finally {
    await server.close();
  }
});

test("POST /api/chat (non-streaming) returns a single message object", async () => {
  const server = await bootServer();
  try {
    const body = await readJson(
      await server.fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "tiny:latest",
          messages: [{ role: "system", content: "be nice" }, { role: "user", content: "hi" }],
          stream: false,
          options: { temperature: 0 },
        }),
      }),
    );
    assert.equal(body.done, true);
    assert.equal(body.message.role, "assistant");
    assert.match(body.message.content, /hi/);
    assert.ok(body.prompt_eval_count > 0);
  } finally {
    await server.close();
  }
});

test("POST /api/chat returns tool calls in Ollama's wire format", async () => {
  const server = await bootServer();
  try {
    const body = await readJson(
      await server.fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "tiny",
          messages: [{ role: "user", content: "/tool what is the weather" }],
          tools: [
            {
              type: "function",
              function: {
                name: "get_weather",
                description: "Get the weather for a city",
                parameters: {
                  type: "object",
                  properties: { city: { type: "string" } },
                  required: ["city"],
                },
              },
            },
          ],
          stream: false,
        }),
      }),
    );
    assert.equal(body.done_reason, "tool_calls");
    assert.equal(body.message.tool_calls.length, 1);
    assert.equal(body.message.tool_calls[0].function.name, "get_weather");
    assert.equal(typeof body.message.tool_calls[0].function.arguments, "object");
  } finally {
    await server.close();
  }
});

test("POST /api/chat uses a model's stored template", async () => {
  const server = await bootServer({ template: CLASSIC_TEMPLATE });
  try {
    const body = await readJson(
      await server.fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "templated",
          messages: [{ role: "user", content: "ping" }],
          stream: false,
        }),
      }),
    );
    // The mock backend echoes the rendered prompt, which must contain the markers.
    assert.match(body.message.content, /<\|im_start\|>user/);
    assert.match(body.message.content, /ping/);
    assert.match(body.message.content, /You are terse\./);
  } finally {
    await server.close();
  }
});

test("POST /api/generate streams and reports Ollama timing fields", async () => {
  const server = await bootServer();
  try {
    const response = await server.fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "tiny", prompt: "tell me a joke", stream: true }),
    });
    const frames = parseNdjson(await response.text());
    const text = frames
      .filter((frame) => !frame.done)
      .map((frame) => frame.response)
      .join("");
    assert.match(text, /tell me a joke/);
    const final = frames.at(-1);
    assert.equal(final.done, true);
    assert.ok(final.prompt_eval_count > 0);
    assert.ok(final.eval_count > 0);
  } finally {
    await server.close();
  }
});

test("POST /api/generate supports non-streaming JSON mode", async () => {
  const server = await bootServer();
  try {
    const body = await readJson(
      await server.fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "tiny", prompt: "give me json", format: "json", stream: false }),
      }),
    );
    assert.equal(body.done, true);
    assert.doesNotThrow(() => JSON.parse(body.response));
  } finally {
    await server.close();
  }
});

test("embedding endpoints return vectors", async () => {
  const server = await bootServer();
  try {
    const body = await readJson(
      await server.fetch("/api/embed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "tiny", input: ["first", "second"] }),
      }),
    );
    assert.equal(body.embeddings.length, 2);
    assert.equal(body.embeddings[0].length, 32);
    assert.ok(body.prompt_eval_count > 0);

    const legacy = await readJson(
      await server.fetch("/api/embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "tiny", prompt: "first" }),
      }),
    );
    assert.ok(Array.isArray(legacy.embedding));
    assert.equal(legacy.embedding.length, 32);
  } finally {
    await server.close();
  }
});

test("keep_alive: 0 unloads the model after the request", async () => {
  const server = await bootServer();
  try {
    await readJson(
      await server.fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "tiny",
          messages: [{ role: "user", content: "hi" }],
          stream: false,
          keep_alive: 0,
        }),
      }),
    );

    let loaded = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      loaded = await readJson(await server.fetch("/api/ps"));
      if (loaded.models.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    assert.equal(loaded.models.length, 0);
  } finally {
    await server.close();
  }
});

test("ps lists loaded models while a model is warm", async () => {
  const server = await bootServer();
  try {
    await readJson(
      await server.fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "tiny",
          messages: [{ role: "user", content: "hi" }],
          stream: false,
          keep_alive: "10m",
        }),
      }),
    );
    const body = await readJson(await server.fetch("/api/ps"));
    assert.equal(body.models.length, 1);
    assert.equal(body.models[0].name, "tiny:latest");
    assert.match(body.models[0].expires_at, /^\d{4}-/);
  } finally {
    await server.close();
  }
});

test("create, copy and delete models through the HTTP API", async () => {
  const server = await bootServer();
  try {
    const created = await readJson(
      await server.fetch("/api/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "tutor",
          from: "tiny:latest",
          system: "Explain like I am five.",
          parameters: { temperature: 0.4 },
          stream: false,
        }),
      }),
    );
    assert.equal(created.status, "success");
    assert.equal(created.model, "tutor:latest");

    const shown = await readJson(
      await server.fetch("/api/show", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "tutor" }),
      }),
    );
    assert.equal(shown.system, "Explain like I am five.");

    await readJson(
      await server.fetch("/api/copy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "tutor:latest", destination: "tutor2:latest" }),
      }),
    );
    const tags = await readJson(await server.fetch("/api/tags"));
    assert.deepEqual(tags.models.map((model) => model.name).sort(), ["tiny:latest", "tutor2:latest", "tutor:latest"]);

    await readJson(
      await server.fetch("/api/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "tutor2" }),
      }),
    );
    const after = await readJson(await server.fetch("/api/tags"));
    assert.equal(after.models.some((model) => model.name === "tutor2:latest"), false);
  } finally {
    await server.close();
  }
});

test("pull imports a local GGUF over HTTP", async () => {
  const server = await bootServer();
  try {
    const response = await server.fetch("/api/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: path.join(server.home, "fixtures", "tiny.gguf"), name: "imported:latest", stream: true }),
    });
    const frames = parseNdjson(await response.text());
    assert.ok(frames.some((frame) => frame.status === "pulling manifest"));
    assert.equal(frames.at(-1).status, "success");

    const tags = await readJson(await server.fetch("/api/tags"));
    assert.ok(tags.models.some((model) => model.name === "imported:latest"));
  } finally {
    await server.close();
  }
});

test("errors are returned in Ollama's shape", async () => {
  const server = await bootServer();
  try {
    const notFoundResponse = await server.fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "does-not-exist", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(notFoundResponse.status, 404);
    const notFoundBody = await readJson(notFoundResponse);
    assert.match(notFoundBody.error, /not found/);

    const badJson = await server.fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{nope",
    });
    assert.equal(badJson.status, 400);
    assert.match((await readJson(badJson)).error, /invalid JSON/);

    const wrongMethod = await server.fetch("/api/chat");
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "POST");

    const push = await server.fetch("/api/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "tiny" }),
    });
    assert.equal(push.status, 501);

    const unknown = await server.fetch("/nope");
    assert.equal(unknown.status, 404);
  } finally {
    await server.close();
  }
});

test("CORS preflight and playground are served", async () => {
  const server = await bootServer();
  try {
    const preflight = await server.fetch("/api/chat", { method: "OPTIONS" });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");

    const playground = await server.fetch("/playground");
    assert.equal(playground.status, 200);
    assert.match(playground.headers.get("content-type"), /text\/html/);
    assert.match(await playground.text(), /lollm/);
  } finally {
    await server.close();
  }
});

test("GET /api/health exposes engine state", async () => {
  const server = await bootServer();
  try {
    const body = await readJson(await server.fetch("/api/health"));
    assert.equal(body.status, "ok");
    assert.equal(body.backend, "mock");
    assert.equal(body.engine.parallel, 1);
  } finally {
    await server.close();
  }
});
