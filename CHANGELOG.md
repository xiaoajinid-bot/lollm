# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/).

## [0.2.0] — 2026-11-03

### Changed

- **Project renamed to `lollm`.** Package name, binary (`lollm`), environment variables
  (`LOLLM_*`), data directory (`~/.lollm`), Docker image and docs all follow the new name. The
  previous name is gone from the codebase; an existing model store from the old build can be reused
  with `mv ~/.llmnod ~/.lollm`.
- Published in the existing `xiaoajinid-bot/lollm` repository, replacing the previous
  `vercel-local-llm` serverless app (still available in git history).

## [0.1.1] — 2026-11-03

### Changed

- **No limits by default.** The context window is no longer clamped to 4096 (or 256) — `llama.cpp`
  uses the model's own window unless `--context-size`/`LOLLM_CONTEXT_SIZE` says otherwise. Request
  bodies are unbounded unless `--max-body-bytes`/`LOLLM_MAX_BODY_BYTES` is set, and
  `--max-tokens`/`LOLLM_MAX_TOKENS` adds an *optional* output cap. `num_predict: -1`, `max_tokens: 0`
  and absent fields all mean "until the model stops".
- Unlimited generation is still bounded by the context window (`maxTokens = window - promptTokens`),
  so a model that never emits EOG cannot spin forever.
- `hf:` references honour `--hf-endpoint`/`LOLLM_HF_ENDPOINT`, enabling mirrors and offline tests.
- `lollm inspect --max-bytes 0` returns the whole tensor.
- Fetch errors now include the underlying cause (`ECONNRESET`, `ENOTFOUND`, …) instead of a bare
  `fetch failed`.
- `scripts/verify-remote.mjs` (`npm run verify:remote`) reports which remote GGUFs are reachable and
  how many bytes the header costs.
- `docs/compatibility.md`: which architectures run, why diffusion GGUFs do not, split files, vision
  projectors, plus the four reference models from the bug report.
- Token usage (`eval_count`, `usage.completion_tokens`) now counts real generated tokens instead of
  re-tokenizing the detokenized text.

## [0.1.0] — 2026-11-03

First public release.

### Added

- **Ollama-compatible HTTP API**: `/api/version`, `/api/tags`, `/api/ps`, `/api/show`,
  `/api/chat`, `/api/generate`, `/api/embed`, `/api/embeddings`, `/api/pull`, `/api/create`,
  `/api/copy`, `/api/delete`, `/api/health`, plus the `GET /` readiness probe.
- **OpenAI-compatible API**: `/v1/models`, `/v1/models/{id}`, `/v1/chat/completions`,
  `/v1/completions`, `/v1/embeddings` with SSE streaming, tool calls, JSON mode and usage stats.
- **llama.cpp backend** through `node-llama-cpp`, including GPU selection, context sizing,
  sequence pooling, grammar-constrained output and chat wrappers.
- **Deterministic mock backend** (`--backend mock`) so the whole stack runs without weights in CI.
- **Ollama-style model store**: content-addressed blobs, OCI-like manifests, template/system/
  license/parameter layers, deduplication across `create`/`copy`.
- **Model ingestion** from `registry.ollama.ai`, Hugging Face, HTTP(S) URLs and local `.gguf`
  files, with streaming progress and sha256 verification.
- **GGUF reader** (v1–v3) for metadata, quantization, context length and parameter counts without
  loading tensor data. Parses any byte source (file buffer or remote).
- **On-demand remote models**: `HttpRangeSource` reads GGUF headers over HTTP `Range` requests with
  a block-aligned LRU cache, `If-Range` revalidation, retry/backoff and I/O stats. A host that
  ignores `Range` is reported as `range_not_supported` instead of being fully downloaded.
- **`lollm inspect`** (`info`): print a remote model's metadata, tensor table, per-tensor slice
  (`--tensor`, `--max-bytes`), block size (`--block-size`) and traffic saved, as text or `--json`.
- **Resumable downloads**: `pull` writes `<dest>.part` plus a `.meta.json` sidecar and resumes with
  `Range: bytes=<offset>-` after an interruption; Ollama registry blobs are verified against their
  digest once complete.
- **Modelfile support**: `FROM`, `PARAMETER`, `SYSTEM`, `TEMPLATE`, `LICENSE`, `MESSAGE`.
- **Go-template renderer** for Ollama chat templates (`if`/`range`/trim markers).
- **CLI**: `serve`, `run`, `pull`, `inspect`, `list`, `ps`, `show`, `create`, `cp`, `rm`, `embed`,
  `version`.
- **Playground** at `/playground` with streaming chat, model picker and sampling controls.
- Engine lifecycle management: keep-alive, LRU eviction, concurrency limits, request queueing,
  client-disconnect aborts and graceful shutdown.
- 110 tests covering GGUF parsing, HTTP Range access and resumable downloads, Modelfiles,
  templates, the model store, the engine, both APIs and the CLI.
- Dockerfile, GitHub Actions CI, English and Indonesian documentation.
