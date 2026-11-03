# API reference

Every endpoint is served from the same origin/port (default `http://127.0.0.1:11434`) and sends
`Access-Control-Allow-Origin: *`.

- [Conventions](#conventions)
- [Ollama native API](#ollama-native-api)
- [OpenAI-compatible API](#openai-compatible-api)
- [Streaming formats](#streaming-formats)
- [Errors](#errors)

## Conventions

| | |
|---|---|
| Base URL | `http://127.0.0.1:11434` |
| Content type | `application/json` (NDJSON for Ollama streams, SSE for OpenAI streams) |
| Auth | none — bind to `127.0.0.1` unless you know what you are doing |
| Model names | `name`, `name:tag`, `namespace/name:tag`; `:latest` is implied |
| Durations | nanoseconds in responses (Ollama convention), `"5m"`/`0`/`-1` in requests |
| Request id | `X-Request-Id` response header |

Every generation response carries a timing block:

```json
{
  "total_duration": 1849209000,
  "load_duration": 412000000,
  "prompt_eval_count": 18,
  "prompt_eval_duration": 210000000,
  "eval_count": 42,
  "eval_duration": 1200000000
}
```

`load_duration` is `0` when the model was already resident.

## Ollama native API

### `GET /`

Readiness probe. Returns the literal text `Ollama is running` (200).

### `GET /api/version`

```json
{ "version": "0.5.7", "lollm": "0.1.0" }
```

`version` is the Ollama compatibility level used by client libraries; `lollm` is the actual build.

### `GET /api/tags`

```json
{
  "models": [
    {
      "name": "qwen2.5:0.5b",
      "model": "qwen2.5:0.5b",
      "modified_at": "2026-11-03T04:41:00.123Z",
      "size": 397821344,
      "digest": "sha256:6f4d1…",
      "details": {
        "parent_model": "",
        "format": "gguf",
        "family": "qwen2",
        "families": ["qwen2"],
        "parameter_size": "494M",
        "quantization_level": "Q4_K_M"
      }
    }
  ]
}
```

### `GET /api/ps`

```json
{
  "models": [
    {
      "name": "qwen2.5:0.5b",
      "model": "qwen2.5:0.5b",
      "size": 397821344,
      "digest": "sha256:6f4d1…",
      "details": { "…": "…" },
      "expires_at": "2026-11-03T04:46:00.123Z",
      "size_vram": 0
    }
  ]
}
```

`expires_at` is `"forever"` when the model was pinned with `keep_alive: -1`.

### `POST /api/show`

```json
{ "model": "qwen2.5:0.5b" }
```

```json
{
  "license": "Apache-2.0",
  "modelfile": "FROM /home/me/.lollm/models/blobs/sha256-…\nTEMPLATE \"\"\"…\"\"\"\nPARAMETER temperature 0.7",
  "parameters": "temperature 0.7\nstop <|im_end|>",
  "template": "<|im_start|>system\n{{ .System }}<|im_end|>…",
  "system": "",
  "details": { "family": "qwen2", "parameter_size": "494M", "quantization_level": "Q4_K_M", "…": "…" },
  "model_info": {
    "general.architecture": "qwen2",
    "general.parameter_count": 494032768,
    "qwen2.context_length": 32768,
    "tokenizer.ggml.model": "gpt2"
  },
  "capabilities": ["completion", "tools"],
  "modified_at": "2026-11-03T04:41:00.123Z"
}
```

### `POST /api/chat`

```json
{
  "model": "qwen2.5:0.5b",
  "messages": [
    { "role": "system", "content": "You are terse." },
    { "role": "user", "content": "Hi!" }
  ],
  "tools": [],
  "format": "json",
  "options": { "temperature": 0.7, "num_ctx": 4096, "stop": ["<|im_end|>"] },
  "stream": true,
  "keep_alive": "5m"
}
```

`stream: true` (default) emits NDJSON frames:

```json
{"model":"qwen2.5:0.5b","created_at":"…","message":{"role":"assistant","content":""},"done":false}
{"model":"qwen2.5:0.5b","created_at":"…","message":{"role":"assistant","content":"Halo"},"done":false}
{"model":"qwen2.5:0.5b","created_at":"…","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","total_duration":…}
```

With `stream: false` the same content comes back in one object.

Tool calls appear in the final message using Ollama's shape (arguments as an **object**):

```json
{
  "message": {
    "role": "assistant",
    "content": "",
    "tool_calls": [
      { "function": { "name": "get_weather", "arguments": { "city": "Jakarta" } } }
    ]
  },
  "done": true,
  "done_reason": "tool_calls"
}
```

Supported `options`: `temperature`, `top_p`, `top_k`, `min_p`, `seed`, `num_predict`,
`stop`, `repeat_penalty`, `presence_penalty`, `frequency_penalty`, `num_ctx`, `num_gpu`,
`num_thread`. Unknown keys are ignored.

### `POST /api/generate`

```json
{
  "model": "qwen2.5:0.5b",
  "prompt": "Write a haiku about GGUF.",
  "system": "You are a poet.",
  "template": "{{ .System }}\n{{ .Prompt }}",
  "raw": false,
  "format": "json",
  "options": { "num_predict": 128 },
  "stream": true
}
```

Frames contain `response` instead of `message`. `raw: true` sends `prompt` to the model verbatim
(no chat template, no system prompt).

### `POST /api/embed`

```json
{ "model": "nomic-embed-text", "input": ["first text", "second text"] }
```

```json
{
  "model": "nomic-embed-text:latest",
  "embeddings": [[0.013, -0.24, "…"], [0.051, 0.12, "…"]],
  "total_duration": 8100000,
  "load_duration": 0,
  "prompt_eval_count": 8
}
```

`input` may be a string or an array. Any GGUF model works, but embedding-trained models
(BERT/Nomic/Jina) produce meaningful vectors.

### `POST /api/embeddings` (legacy)

```json
{ "model": "nomic-embed-text", "prompt": "hello" }
```

```json
{ "embedding": [0.013, -0.24, "…"] }
```

### `POST /api/pull`

```json
{ "model": "qwen2.5:0.5b", "stream": true }
```

Progress frames:

```json
{"status":"pulling manifest"}
{"status":"pulling 6f4d1a2b3c4d","digest":"sha256:6f4d…","total":397821344,"completed":10485760}
{"status":"verifying sha256 digest","digest":"sha256:6f4d…","total":397821344,"completed":397821344}
{"status":"writing manifest"}
{"status":"success"}
```

`model` accepts registry names, `ollama:name:tag`, `hf:repo:file.gguf`, `https://…`, or a local path.
`stream: false` returns one object instead.

Remote URLs are **probed before they are downloaded**: a `Range: bytes=0-0` request reads the GGUF
header, so a URL that is not a model fails with `400 invalid_gguf` in milliseconds instead of pulling
gigabytes. The transfer itself is resumable — bytes accumulate in `<models>/tmp/pull-<hash>.part`
(with a `.meta.json` sidecar), and an interrupted pull continues with `Range: bytes=<offset>-` on
the next attempt. Plain `http://` sources are rejected with `insecure_url` unless the server was
started with `LOLLM_ALLOW_INSECURE=1`.

### `POST /api/create`

```json
{
  "model": "tutor",
  "from": "qwen2.5:0.5b",
  "system": "You are a patient tutor.",
  "template": "{{ .System }}\n{{ .Prompt }}",
  "parameters": { "temperature": 0.4, "stop": ["</s>"] }
}
```

`modelfile` may be supplied instead of the individual fields:

```json
{ "model": "tutor", "modelfile": "FROM qwen2.5:0.5b\nSYSTEM \"\"\"Be nice.\"\"\"" }
```

### `POST /api/copy`

```json
{ "source": "qwen2.5:0.5b", "destination": "qwen-small:latest" }
```

### `POST /api/delete`

```json
{ "model": "qwen-small:latest" }
```

Deletes the manifest. Shared blobs remain until no manifest references them (manual pruning today).

### `POST /api/push`

Always `501`: lollm does not publish models to registries.

### `GET /api/health`

Not part of Ollama's API; useful for probes and dashboards.

```json
{
  "status": "ok",
  "name": "lollm",
  "version": "0.1.0",
  "backend": "llama",
  "engine": {
    "backend": "llama",
    "parallel": 1,
    "queue": 0,
    "active": 0,
    "loaded": [{ "name": "qwen2.5:0.5b", "contextSize": 4096, "expiresAt": "…" }],
    "stats": { "requests": 12, "completions": 12, "promptTokens": 940, "completionTokens": 3180 },
    "uptimeMs": 91234
  }
}
```

## OpenAI-compatible API

Point any OpenAI SDK at `http://127.0.0.1:11434/v1`; the API key is ignored (any string works).

### `GET /v1/models`

```json
{
  "object": "list",
  "data": [{ "id": "qwen2.5:0.5b", "object": "model", "created": 1762144860, "owned_by": "lollm" }]
}
```

`GET /v1/models/{id}` adds `details` and `context_length`.

### `POST /v1/chat/completions`

```json
{
  "model": "qwen2.5:0.5b",
  "messages": [{ "role": "user", "content": "Hello" }],
  "temperature": 0.7,
  "top_p": 0.9,
  "max_tokens": 256,
  "stop": ["\n\n"],
  "stream": false,
  "response_format": { "type": "json_object" },
  "stream_options": { "include_usage": true }
}
```

Response:

```json
{
  "id": "chatcmpl-…",
  "object": "chat.completion",
  "created": 1762144860,
  "model": "qwen2.5:0.5b",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "Hi!" },
      "logprobs": null,
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 9, "completion_tokens": 3, "total_tokens": 12 },
  "system_fingerprint": "lollm"
}
```

- `tools` / `tool_choice` → `finish_reason: "tool_calls"` with `tool_calls[].function.arguments` as a
  JSON **string**.
- `response_format: {"type":"json_object"}` forces a JSON grammar;
  `{"type":"json_schema","json_schema":{"schema":{…}}}` forces that schema.
- Omitting `model` uses the first installed model.
- Extra Ollama-style field: `keep_alive` is accepted per request.

### `POST /v1/completions`

```json
{ "model": "qwen2.5:0.5b", "prompt": "Once upon a time", "max_tokens": 64, "stream": true }
```

### `POST /v1/embeddings`

```json
{ "model": "nomic-embed-text", "input": ["a", "b"] }
```

```json
{
  "object": "list",
  "data": [
    { "object": "embedding", "index": 0, "embedding": [0.01, "…"] },
    { "object": "embedding", "index": 1, "embedding": [0.02, "…"] }
  ],
  "model": "nomic-embed-text:latest",
  "usage": { "prompt_tokens": 4, "total_tokens": 4 }
}
```

## Streaming formats

### NDJSON (Ollama)

`Content-Type: application/x-ndjson`. One JSON object per line, flushing after each token. The
stream always starts with an empty `done: false` frame and ends with a `done: true` frame carrying
the timing block. Client disconnect aborts generation (the model stops emitting tokens).

```js
const response = await fetch("http://127.0.0.1:11434/api/chat", {
  method: "POST",
  body: JSON.stringify({ model: "qwen2.5:0.5b", messages: [{ role: "user", content: "Hi" }] }),
});
const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  for (const line of value.split("\n").filter(Boolean)) {
    const frame = JSON.parse(line);
    if (!frame.done) process.stdout.write(frame.message.content);
  }
}
```

### SSE (OpenAI)

`Content-Type: text/event-stream`, `data: {json}\n\n` frames, terminated by `data: [DONE]`.
JSON mode, tools and `include_usage` all work the same as the non-streaming endpoint.

## Errors

Ollama-style endpoints:

```json
{ "error": "model \"ghost\" not found — try: lollm pull ghost", "code": "model_not_found" }
```

OpenAI-style endpoints (`/v1/*`):

```json
{
  "error": {
    "message": "model \"ghost\" not found — try: lollm pull ghost",
    "type": "not_found_error",
    "param": null,
    "code": "model_not_found"
  }
}
```

### Generation limits

There are none by default. `/api/chat`, `/api/generate` and `/v1/chat/completions` generate until the
model emits an end token or fills its context window, and `done_reason` is `stop` or `length`
accordingly.

| Request field | Effect |
|---|---|
| `options.num_predict` | cap for this request; `-1` or `0` = unlimited (default) |
| `options.num_ctx` | context window requested at load time |
| `max_tokens` / `max_completion_tokens` (OpenAI) | same cap, `-1`/`0`/absent = unlimited |

Server-wide defaults are opt-in: `--max-tokens`, `--context-size`, `--max-body-bytes`.

| Status | When |
|---|---|
| `400` | malformed JSON, invalid model name, bad `format`, missing `messages`/`prompt` |
| `404` | unknown endpoint or model |
| `405` | wrong method (with `Allow` header) |
| `409` | model incomplete (missing blob) or duplicate on copy |
| `413` | body larger than `maxBodyBytes` (64 MB default) |
| `499` | client disconnected mid-stream |
| `501` | unsupported feature (push, etc.) |
| `502` | upstream registry/download failure |
| `503` | all model slots busy |
