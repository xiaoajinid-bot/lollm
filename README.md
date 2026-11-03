<div align="center">

# lollm

**Ollama-compatible local LLM server for Node.js, powered by llama.cpp.**

Run GGUF models on your own machine, expose the same API your Ollama tooling already speaks,
and keep everything in the Node ecosystem — one process, no Python, no daemon, no API keys.

`npx lollm serve` → `http://127.0.0.1:11434`

[![CI](https://github.com/xiaoajinid-bot/lollm/actions/workflows/ci.yml/badge.svg)](https://github.com/xiaoajinid-bot/lollm/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-63e6be.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-7c9cff.svg)](package.json)

</div>

---

## Why another local LLM server?

Ollama is great, but it is a Go daemon with its own model registry, its own Modelfile dialect and
its own API. If your stack is JavaScript/TypeScript, you usually end up gluing a Go binary to a Node
process and hoping the versions match.

`lollm` flips that around:

- **Ollama's HTTP API** (`/api/chat`, `/api/generate`, `/api/tags`, `/api/pull`, …) so existing
  clients — Open WebUI, Continue, LangChain, `ollama-js` — keep working.
- **OpenAI's API** (`/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`) so SDKs and
  AI frameworks work without a proxy.
- **Ollama's on-disk model store** (`~/.lollm/models/{blobs,manifests}`) with content-addressed
  layers, so `lollm pull` can fetch straight from `registry.ollama.ai`, Hugging Face, any URL, or
  a local `.gguf` file.
- **llama.cpp underneath** through [`node-llama-cpp`](https://github.com/withcatai/node-llama-cpp) —
  the same SIMD/GPU inference engine, just bound to Node.
- **A built-in playground** at `/playground`, and a CLI that feels like `ollama`'s.

Everything is a normal ESM package with **zero runtime dependencies** other than the llama.cpp
binding (which is optional, so `npm install` never fails on exotic platforms).

## Features

| | |
|---|---|
| **Backends** | llama.cpp via `node-llama-cpp` (CPU, Metal, CUDA, Vulkan) and a deterministic `mock` backend for CI |
| **Model formats** | GGUF (v1–v3), including split-file metadata and per-model chat templates |
| **Model sources** | `registry.ollama.ai`, Hugging Face (`hf:`), direct `https://` URLs, local `.gguf` paths, Modelfiles |
| **On-demand models** | GGUF headers read over HTTP `Range` requests (256 KB block cache), tensor slices fetched only when read, resumable downloads |
| **No hidden limits** | No token cap, no context clamp, no body-size cap unless you ask for one (`--max-tokens`, `--context-size`, `--max-body-bytes`) |
| **Native API** | `/api/version`, `/api/tags`, `/api/ps`, `/api/show`, `/api/chat`, `/api/generate`, `/api/embed`, `/api/embeddings`, `/api/pull`, `/api/create`, `/api/copy`, `/api/delete` |
| **OpenAI API** | `/v1/models`, `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings` (streaming, tools, JSON mode) |
| **Streaming** | NDJSON (Ollama) and SSE (OpenAI), with backpressure and client-disconnect aborts |
| **Sampling** | temperature, top_p, top_k, min_p, repeat/presence/frequency penalties, seed, stop sequences, `num_ctx`, `num_gpu` |
| **Structured output** | `format: "json"`, JSON Schema grammars, OpenAI `response_format` |
| **Tool calling** | Ollama/OpenAI tool schemas mapped to llama.cpp GBNF function-call grammars |
| **Model lifecycle** | keep-alive, idle eviction, LRU replacement, concurrency limits, queueing |
| **Ops** | CORS, request IDs, `/api/health`, graceful shutdown, Dockerfile, zero-dep tests |

## Quick start

```bash
# 1. install (Node 20+)
npm install -g lollm

# 2. pull a small model (≈ 400 MB)
lollm pull qwen2.5:0.5b

# 3. serve on Ollama's port
lollm serve
```

Then either open the playground at <http://127.0.0.1:11434/playground>, or talk to it:

```bash
curl http://127.0.0.1:11434/api/chat -d '{
  "model": "qwen2.5:0.5b",
  "messages": [{ "role": "user", "content": "Explain GGUF in one sentence." }],
  "stream": false
}'
```

```js
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "http://127.0.0.1:11434/v1", apiKey: "not-needed" });

const reply = await client.chat.completions.create({
  model: "qwen2.5:0.5b",
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(reply.choices[0].message.content);
```

Already have Ollama? Point its clients at this port instead — or copy models over:

```bash
lollm pull ollama:qwen2.5:0.5b     # from registry.ollama.ai
lollm pull ~/.ollama/models/blobs/sha256-<digest> --name mine:latest   # reuse a local blob
```

## Install

```bash
npm install -g lollm        # npm package + CLI
# or, from a checkout:
git clone https://github.com/xiaoajinid-bot/lollm && cd lollm
npm install && npm link
```

`node-llama-cpp` is an **optional dependency**: if its prebuilt binaries are unavailable, the CLI,
the model store, `lollm list/show/pull` and the HTTP API still work. Real inference needs it:

```bash
npm install node-llama-cpp
```

GPU support is inherited from llama.cpp: Metal on macOS, CUDA/Vulkan on Linux and Windows.
`lollm serve --gpu false` forces CPU-only; `--gpu cuda` forces a backend.

## CLI

```text
lollm serve                     Start the API server (default 127.0.0.1:11434)
lollm run <model> [prompt...]   Chat in your terminal (streaming, REPL when no prompt)
lollm pull <reference>          Fetch a model from Ollama, Hugging Face, a URL or a file
lollm inspect <url>             Read GGUF metadata remotely (opts: --tensor, --json)
lollm list                      List installed models
lollm ps                        Models currently loaded by a running server
lollm show <model>              Details, template, parameters, Modelfile
lollm create <name> [-f file]   Create a model from a Modelfile
lollm cp <src> <dst>            Duplicate a model (shares weights, costs ~0 bytes)
lollm rm <model...>             Delete manifests
lollm embed <model> <text...>   Compute an embedding
lollm version | help
```

Full reference: [docs/cli.md](docs/cli.md).

## API

Both surfaces are enabled on the same port, with permissive CORS.

### Ollama native

| Method | Path | Notes |
|---|---|---|
| `GET` | `/` | returns `Ollama is running` (readiness probe) |
| `GET` | `/api/version` | Ollama-compatible version + the real lollm build |
| `GET` | `/api/tags` | installed models, sizes, digests, details |
| `GET` | `/api/ps` | loaded models with `expires_at` |
| `POST` | `/api/show` | template, system prompt, parameters, `model_info` |
| `POST` | `/api/chat` | streaming NDJSON, tools, JSON mode |
| `POST` | `/api/generate` | raw completion, `raw`, `suffix`-free, streaming |
| `POST` | `/api/embed` | batch embeddings |
| `POST` | `/api/embeddings` | legacy single-prompt embeddings |
| `POST` | `/api/pull` | progress stream while downloading |
| `POST` | `/api/create` | create from a Modelfile |
| `POST` | `/api/copy` | copy a model |
| `POST` | `/api/delete` | remove a model |
| `POST` | `/api/push` | `501` — pushing is intentionally unsupported |

### OpenAI compatible

| Method | Path |
|---|---|
| `GET` | `/v1/models`, `/v1/models/{id}` |
| `POST` | `/v1/chat/completions` |
| `POST` | `/v1/completions` |
| `POST` | `/v1/embeddings` |

Streaming, `tools` / `tool_calls`, `response_format` (`json_object` and `json_schema`), `stop`,
`seed`, `stream_options.include_usage` and token usage are all supported.

Request/response examples for every endpoint: [docs/api.md](docs/api.md).

## Models

### Pull sources

```bash
lollm pull qwen2.5:0.5b                                         # registry.ollama.ai
lollm pull ollama:gemma3:4b                                     # explicit
lollm pull hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:qwen2.5-0.5b-instruct-q4_k_m.gguf --name qwen2.5:0.5b
lollm pull https://huggingface.co/org/repo/resolve/main/model.gguf --name mine:q4
lollm pull hf:unsloth/Qwen3.8-27B-GGUF:BF16/Qwen3.8-27B-BF16-00001-of-00002.gguf   # split part 1
lollm pull ./downloads/my-model.gguf --name mine:latest          # import, content-addressed
```

Private Hugging Face repos: set `HF_TOKEN`.

### Nothing is capped unless you say so

`lollm` does not invent limits. Out of the box:

| Knob | Default | Meaning |
|---|---|---|
| output tokens | unlimited | generation runs until the model emits an end token (or fills its context) |
| context window | the model's own | `llama.cpp` picks the window the GGUF was trained with; `lollm` never clamps it |
| request body | unlimited | no hidden 1 MB/64 MB cut-off for big prompts or base64 images |
| batch/queue | 1 generation at a time | concurrency, not a token limit — raise with `--parallel` |

Every cap is opt-in, by flag or environment variable:

```bash
lollm serve --max-tokens 512            # LOLLM_MAX_TOKENS
lollm serve --context-size 8192         # LOLLM_CONTEXT_SIZE (or "auto" for the model default)
lollm serve --max-body-bytes 104857600  # LOLLM_MAX_BODY_BYTES (0 = unlimited)
```

Per request, Ollama's `options.num_predict` and OpenAI's `max_tokens` still work; `-1`, `0` or an
omitted value all mean "no cap".

### Inspect a model before you download it

A GGUF file starts with a header that describes everything (architecture, parameter count, context
size, quantization, tensor table) and is typically a few hundred kilobytes; the weights that follow
are gigabytes. `lollm inspect` exploits that split: it asks the server for the first bytes only,
parses the header, and stops.

```console
$ lollm inspect https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b-instruct-q4_k_m.gguf
  size          4.7 GB
  architecture  qwen2
  parameters    7,615,616,512 (Q4_K_M)
  context       32768
  tensors       339
  chat template present

  on-demand I/O
  requests      3
  downloaded    256.0 KB (0.01% of the file)
  saved         4.7 GB

  only metadata was fetched; tensor payloads are read on demand with Range requests
```

`--tensor <name>` goes one step further and pulls a single tensor's slice (useful to verify
quantization or to fingerprint a file without mirroring it):

```console
$ lollm inspect <url> --tensor token_embd
token_embd.weight
  type      Q4_K
  dims      [3584 × 152064]
  elements  545,030,144
  file      offset 3,664,832

  fetched   64.0 KB slice (sha256 07dcb6d11a036248…)
  network   3 request(s), 512.0 KB total

  only this slice was fetched with Range requests; the rest of the file stayed on the server
```

How it works, and what it means for you:

- One `Range: bytes=0-0` probe learns the file size and whether the host honours ranges. A server
  that answers `200` instead of `206` is rejected with `range_not_supported` rather than silently
  streaming gigabytes into the parser.
- Every later read is a block-aligned `Range` request (256 KB by default, `--block-size` to tune)
  with an LRU cache and `If-Range: <etag>` revalidation, so re-parsing a header is free.
- `lollm pull <url>` uses the same header probe first: a URL that is not a GGUF file fails in
  milliseconds instead of downloading it, and the transfer itself resumes from `.part` files
  (Range + `ETag`) after a Ctrl+C, a crash or a dropped connection.
- `--json` prints the same data machine-readable, tensors included.
- Plain `http://` is refused unless `LOLLM_ALLOW_INSECURE=1` (or `--allow-insecure`); use HTTPS.
- `LOLLM_HF_ENDPOINT` (or `--hf-endpoint`) points `hf:` references at a mirror or a local fixture
  server, which is also how the Range tests run offline.

Which architectures actually run (and which GGUF flavours do not): [docs/compatibility.md](docs/compatibility.md).

To check a whole list of models at once (exit code 1 if any of them is unreachable):

```bash
npm run verify:remote -- <url|hf:repo:file.gguf> [...] [--tensor name] [--json]
```

### Storage layout

Identical in spirit to Ollama, so backups and `sha256`-deduplication behave the same:

```text
~/.lollm/
├── config.json
└── models/
    ├── blobs/
    │   └── sha256-<hex>                              # GGUF weights + template/system/params layers
    └── manifests/
        └── lollm.local/library/qwen2.5/0.5b         # JSON manifest (OCI-style layers)
```

`lollm cp` and Modelfile variants reference the same blobs — no duplicated gigabytes.

### Modelfile

```dockerfile
FROM qwen2.5:0.5b

PARAMETER temperature 0.7
PARAMETER num_ctx 8192
PARAMETER stop "<|im_end|>"

SYSTEM """You are a patient tutor. Answer in Indonesian."""

TEMPLATE """<|im_start|>system
{{ .System }}<|im_end|>
<|im_start|>user
{{ .Prompt }}<|im_end|>
<|im_start|>assistant
"""
```

```bash
lollm create tutor -f Modelfile
lollm run tutor "Apa itu GGUF?"
```

Details and the supported template subset: [docs/modelfile.md](docs/modelfile.md).

## Configuration

All flags also read environment variables; a `~/.lollm/config.json` can set defaults.

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--host` | `LOLLM_HOST` | `127.0.0.1` | bind address (`0.0.0.0` for Docker/LAN) |
| `--port` | `LOLLM_PORT` | `11434` | port |
| `--home` | `LOLLM_HOME` | `~/.lollm` | data directory |
| `--models-dir` | `LOLLM_MODELS_DIR` | `<home>/models` | model store |
| `--backend` | `LOLLM_BACKEND` | `llama` | `llama` or `mock` |
| `--gpu` | `LOLLM_GPU` | `auto` | `auto`, `false`, `cuda`, `metal`, `vulkan` |
| `--gpu-layers` | `LOLLM_GPU_LAYERS` | auto | layers offloaded to the GPU |
| `--context-size` | `LOLLM_CONTEXT_SIZE` | `4096` | default context window |
| `--parallel` | `LOLLM_PARALLEL` | `1` | concurrent generations |
| `--max-loaded-models` | `LOLLM_MAX_LOADED_MODELS` | `1` | models kept in memory |
| `--keep-alive` | `LOLLM_KEEP_ALIVE` | `5m` | idle time before unloading |
| `--verbose` | `LOLLM_VERBOSE` | `false` | debug logging |
| — | `HF_TOKEN` | — | Hugging Face token for gated repos |
| — | `LOLLM_OLLAMA_REGISTRY` | `https://registry.ollama.ai` | registry base URL |

Per-request `keep_alive` follows Ollama semantics: `"30m"`, `0` (unload now), `-1` (pin forever).

## Embedding it in your app

```js
import { start } from "lollm";

const app = await start({ host: "127.0.0.1", port: 11434 });
console.log(app.url);              // http://127.0.0.1:11434
console.log(app.engine.status());  // loaded models, queue depth, token counters
await app.close();                 // closes the server and unloads models
```

Lower level pieces are exported too: `createInstance()`, `Engine`, `ModelStore`, `createMockBackend`,
`parseModelfile`, `parseModelName`, `readGgufInfo`, `renderTemplate`.

## Architecture

```text
                      ┌──────────────────────────────────────────────┐
  ollama clients ───▶ │  /api/*   API layer (NDJSON)                 │
  openai SDKs ──────▶ │  /v1/*     API layer (SSE)                   │
  browser ──────────▶ │  /playground                                 │
                      └───────────────────────┬──────────────────────┘
                                              │
                                     ┌────────▼────────┐
                                     │     Engine      │  queue · keep-alive · LRU · stats
                                     └────┬───────┬────┘
                              ┌───────────▼──┐  ┌─▼──────────────┐
                              │ Model store  │  │   Backend      │
                              │ blobs +      │  │ llama.cpp via  │──▶ node-llama-cpp
                              │ manifests    │  │ node-llama-cpp │    (GGUF, GPU/CPU)
                              └──────────────┘  └────────────────┘
```

A request runs through: JSON validation → model resolution (manifest → blob) → queue slot →
model load (if cold) → generation (streamed token callbacks) → Ollama/OpenAI-encoded response
with timing fields. The engine keeps exactly one hot model by default, unloads it after
`keep_alive`, and evicts the least recently used model when a different one is requested.

## Testing

```bash
npm test          # 110 tests, no model download, no GPU, no network
npm run check     # syntax check every module
```

The suite runs against the **mock backend**, which implements the real backend contract
(streaming, tool calls, embeddings) deterministically. That keeps CI fast and hermetic while
still exercising the HTTP layer, streaming framing, the model store, GGUF parsing (including
on-demand Range reads and resumable downloads against a local HTTP fixture server), Modelfiles
and template rendering. Nothing leaves loopback.

Real-inference smoke tests are intentionally not in CI: they need multi-hundred-megabyte weights.
Run `lollm serve` locally and use `/playground` instead.

## Docker

```bash
docker build -t lollm .
docker run --rm -p 11434:11434 -v lollm-models:/root/.lollm lollm
```

## Differences from Ollama

Being explicit about the edges is more useful than pretending to be a drop-in replacement:

- **Not every Ollama feature exists.** `push`, model signatures/verification, multi-modal
  projector layers and LoRA adapters are not implemented (adapters are skipped on pull, with a
  warning; images are accepted and ignored).
- **`/api/version` reports an Ollama-compatible version** so clients that gate on it work, plus a
  `lollm` field with the real build. `/api/health` exposes the truth.
- **Prompt formatting uses the model's own template when it has one**, otherwise
  `node-llama-cpp`'s chat wrapper for that architecture (ChatML, Llama 3, Gemma, Qwen, …). The
  Go-template subset is documented in [docs/modelfile.md](docs/modelfile.md).
- **Tool calling** maps JSON Schemas to llama.cpp grammars. Function-call *execution* happens on
  the client, exactly like Ollama (the server returns `tool_calls`, it never runs your code).
- **One hot model by default** keeps RAM predictable on laptops; raise `--max-loaded-models`
  if you have headroom.

## Roadmap

- [ ] LoRA adapter layers (`application/vnd.ollama.image.adapter`)
- [ ] Multi-modal `projector` support
- [ ] `/api/push` to a registry
- [ ] `lollm prune` for unreferenced blobs
- [ ] HTTP/2 + WebSocket transport for the playground
- [ ] Prometheus metrics endpoint

## License

[MIT](LICENSE) — llama.cpp, `node-llama-cpp` and every pulled model keep their own licenses.
