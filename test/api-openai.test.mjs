import test from "node:test";
import assert from "node:assert/strict";

import { bootServer, parseSse } from "./helpers/server.mjs";

/** @param {Response} response */
const readJson = async (response) => JSON.parse(await response.text());

const post = (server, path, body) =>
  server.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("GET /v1/models lists models in OpenAI's shape", async () => {
  const server = await bootServer();
  try {
    const body = await readJson(await server.fetch("/v1/models"));
    assert.equal(body.object, "list");
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].id, "tiny:latest");
    assert.equal(body.data[0].object, "model");
    assert.equal(body.data[0].owned_by, "lollm");

    const one = await readJson(await server.fetch("/v1/models/tiny%3Alatest"));
    assert.equal(one.id, "tiny:latest");
    assert.equal(one.details.quantization_level, "Q4_K_M");
  } finally {
    await server.close();
  }
});

test("POST /v1/chat/completions returns a chat.completion object", async () => {
  const server = await bootServer();
  try {
    const response = await post(server, "/v1/chat/completions", {
      model: "tiny",
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "hello openai" },
      ],
      temperature: 0.2,
      max_tokens: 64,
    });
    assert.equal(response.status, 200);
    const body = await readJson(response);
    assert.match(body.id, /^chatcmpl-/);
    assert.equal(body.object, "chat.completion");
    assert.equal(body.model, "tiny:latest");
    assert.equal(body.choices.length, 1);
    assert.equal(body.choices[0].message.role, "assistant");
    assert.match(body.choices[0].message.content, /hello openai/);
    assert.equal(body.choices[0].finish_reason, "stop");
    assert.ok(body.usage.prompt_tokens > 0);
    assert.ok(body.usage.completion_tokens > 0);
    assert.equal(body.usage.total_tokens, body.usage.prompt_tokens + body.usage.completion_tokens);
  } finally {
    await server.close();
  }
});

test("POST /v1/chat/completions streams SSE deltas and terminates with [DONE]", async () => {
  const server = await bootServer();
  try {
    const response = await post(server, "/v1/chat/completions", {
      model: "tiny",
      messages: [{ role: "user", content: "stream please" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const events = parseSse(await response.text());

    assert.equal(events.at(-1), "[DONE]");
    const chunks = events.filter((event) => event !== "[DONE]");
    assert.equal(chunks[0].choices[0].delta.role, "assistant");
    const text = chunks
      .flatMap((chunk) => chunk.choices.map((choice) => choice.delta?.content || ""))
      .join("");
    assert.match(text, /stream please/);
    const final = chunks.find((chunk) => chunk.choices[0]?.finish_reason === "stop");
    assert.ok(final, "stream should end with finish_reason stop");
    const usageChunk = chunks.find((chunk) => chunk.usage);
    assert.ok(usageChunk, "include_usage should emit a usage chunk");
    assert.ok(usageChunk.usage.total_tokens > 0);
  } finally {
    await server.close();
  }
});

test("tool calls are exposed with JSON string arguments", async () => {
  const server = await bootServer();
  try {
    const body = await readJson(
      await post(server, "/v1/chat/completions", {
        model: "tiny",
        messages: [{ role: "user", content: "/tool find the weather" }],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Weather lookup",
              parameters: { type: "object", properties: { city: { type: "string" } } },
            },
          },
        ],
      }),
    );
    assert.equal(body.choices[0].finish_reason, "tool_calls");
    const call = body.choices[0].message.tool_calls[0];
    assert.equal(call.type, "function");
    assert.equal(call.function.name, "get_weather");
    assert.equal(typeof call.function.arguments, "string");
    assert.doesNotThrow(() => JSON.parse(call.function.arguments));
  } finally {
    await server.close();
  }
});

test("response_format json_object asks the backend for JSON", async () => {
  const server = await bootServer();
  try {
    const body = await readJson(
      await post(server, "/v1/chat/completions", {
        model: "tiny",
        messages: [{ role: "user", content: "give me json" }],
        response_format: { type: "json_object" },
      }),
    );
    assert.doesNotThrow(() => JSON.parse(body.choices[0].message.content));
  } finally {
    await server.close();
  }
});

test("POST /v1/completions supports streaming and non-streaming", async () => {
  const server = await bootServer();
  try {
    const body = await readJson(
      await post(server, "/v1/completions", {
        model: "tiny",
        prompt: "once upon a time",
        max_tokens: 32,
      }),
    );
    assert.equal(body.object, "text_completion");
    assert.match(body.choices[0].text, /once upon a time/);

    const streamed = await post(server, "/v1/completions", {
      model: "tiny",
      prompt: "streamed prompt",
      stream: true,
    });
    const events = parseSse(await streamed.text());
    assert.equal(events.at(-1), "[DONE]");
    const text = events
      .filter((event) => event !== "[DONE]")
      .map((event) => event.choices[0].text)
      .join("");
    assert.match(text, /streamed prompt/);
  } finally {
    await server.close();
  }
});

test("POST /v1/embeddings returns OpenAI embedding objects", async () => {
  const server = await bootServer();
  try {
    const body = await readJson(
      await post(server, "/v1/embeddings", { model: "tiny", input: ["one", "two", "three"] }),
    );
    assert.equal(body.object, "list");
    assert.equal(body.data.length, 3);
    assert.equal(body.data[0].object, "embedding");
    assert.equal(body.data[0].index, 0);
    assert.equal(body.data[0].embedding.length, 32);
    assert.equal(body.usage.total_tokens > 0, true);
  } finally {
    await server.close();
  }
});

test("an omitted model falls back to the first installed model", async () => {
  const server = await bootServer();
  try {
    const body = await readJson(
      await post(server, "/v1/chat/completions", {
        messages: [{ role: "user", content: "no model field" }],
      }),
    );
    assert.equal(body.model, "tiny:latest");
  } finally {
    await server.close();
  }
});

test("OpenAI errors use the error envelope", async () => {
  const server = await bootServer();
  try {
    const missing = await post(server, "/v1/chat/completions", {
      model: "ghost",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    assert.equal(missing.status, 404);
    const body = await readJson(missing);
    assert.equal(typeof body.error.message, "string");
    assert.equal(body.error.type, "not_found_error");
    assert.equal(body.error.code, "model_not_found");

    const badBody = await post(server, "/v1/chat/completions", {
      model: "tiny",
      messages: "not-an-array",
    });
    assert.equal(badBody.status, 400);
    assert.equal((await readJson(badBody)).error.type, "invalid_request_error");
  } finally {
    await server.close();
  }
});
