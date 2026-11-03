# CLI reference

```text
lollm <command> [options]
```

Run `lollm help` for the built-in summary. Every command accepts the global options below.

## Global options

| Flag | Env | Default | Description |
|---|---|---|---|
| `--home <dir>` | `LOLLM_HOME` | `~/.lollm` | data directory (models, config) |
| `--models-dir <dir>` | `LOLLM_MODELS_DIR` | `<home>/models` | model store location |
| `--host <host>` | `LOLLM_HOST` | `127.0.0.1` | bind address for `serve` |
| `--port <port>` | `LOLLM_PORT` | `11434` | port for `serve` |
| `--backend llama\|mock` | `LOLLM_BACKEND` | `llama` | inference backend |
| `--gpu auto\|false\|cuda\|metal\|vulkan` | `LOLLM_GPU` | `auto` | GPU selection |
| `--gpu-layers <n>` | `LOLLM_GPU_LAYERS` | auto | layers offloaded to the GPU |
| `--threads <n>` | `LOLLM_THREADS` | auto | llama.cpp worker threads |
| `--context-size <tokens\|auto>` | `LOLLM_CONTEXT_SIZE` | model's own | context window; unset or `auto` = no clamp |
| `--max-tokens <n>` | `LOLLM_MAX_TOKENS` | unlimited | optional cap on generated tokens |
| `--max-body-bytes <n>` | `LOLLM_MAX_BODY_BYTES` | unlimited | optional request body cap (`0` = unlimited) |
| `--hf-endpoint <url>` | `LOLLM_HF_ENDPOINT` | `https://huggingface.co` | base URL for `hf:` references |
| `--parallel <n>` | `LOLLM_PARALLEL` | `1` | concurrent generations |
| `--max-loaded-models <n>` | `LOLLM_MAX_LOADED_MODELS` | `1` | models kept resident |
| `--keep-alive <duration>` | `LOLLM_KEEP_ALIVE` | `5m` | idle time before unloading |
| `--verbose` | `LOLLM_VERBOSE` | `false` | debug logs |
| `--json` | — | `false` | machine-readable output where supported |
| `--allow-insecure` | `LOLLM_ALLOW_INSECURE` | `false` | permit plain `http://` model downloads |
| `--block-size <bytes>` | — | `262144` | Range request block size for `inspect` |

---

## `lollm serve`

Starts the HTTP server on `127.0.0.1:11434` (Ollama's port) and prints the API locations.

```bash
lollm serve
lollm serve --host 0.0.0.0 --port 8080 --verbose
lollm serve --backend mock          # UI/CI work without weights
```

```text
lollm 0.1.0
models   /home/me/.lollm/models
backend  llama

  Ollama API  http://127.0.0.1:11434/api
  OpenAI API  http://127.0.0.1:11434/v1
  Playground  http://127.0.0.1:11434/playground
```

`SIGINT`/`SIGTERM` shut down gracefully: the listener closes, pending generations are aborted and
models are unloaded.

## `lollm run`

Streams a reply in the terminal. Without a prompt it starts a REPL (`/bye`, `/reset`, Ctrl+D).

```bash
lollm run qwen2.5:0.5b "Explain GGUF like I'm five"
lollm run qwen2.5:0.5b --temperature 0.2
lollm run tutor --parameter top_p=0.9
```

Options: `--temperature`, `--parameter key=value` (repeatable), `--keep-alive`, `--system`.

## `lollm pull`

```bash
lollm pull qwen2.5:0.5b
lollm pull ollama:gemma3:4b
lollm pull hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:qwen2.5-0.5b-instruct-q4_k_m.gguf --name qwen2.5:0.5b
lollm pull https://example.com/model.gguf --name mine:q4
lollm pull ./downloads/model.gguf --name mine:latest
lollm pull hf:org/private-repo:model.gguf --name private:latest   # uses HF_TOKEN
```

Progress is printed as downloads stream; with `--json` the final result is JSON. `--quiet` silences
the progress display. Digests are verified (`sha256`) before a manifest is written, and non-GGUF
payloads are rejected.

For `http(s)` sources the header is probed with a `Range` request first, so a URL that is not a GGUF
file fails before a single megabyte is transferred. The transfer itself is resumable: bytes land in
`<models>/tmp/pull-<hash>.part` next to a `.meta.json` sidecar (`url`, `etag`, `size`), and a second
run continues with `Range: bytes=<partial>-` instead of restarting. Interrupting with Ctrl+C or
losing the connection leaves the partial file in place; a completed pull removes both files.

## `lollm inspect`

Reads a remote GGUF **without downloading it**. Only the header — metadata and the tensor table — is
fetched, using HTTP Range requests; tensor payloads stay on the server until something asks for them.

```bash
lollm inspect https://example.com/model.gguf
lollm inspect hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:qwen2.5-0.5b-instruct-q4_k_m.gguf
lollm inspect https://example.com/model.gguf --json
lollm inspect https://example.com/model.gguf --tensor token_embd.weight
```

```text
https://example.com/model.gguf
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
```

| Flag | Description |
|---|---|
| `--tensor <name>` | fetch one tensor's bytes (exact name, or a unique substring) and print type, dims, offset, size and `sha256` |
| `--max-bytes <n>` | cap the tensor slice returned by `--tensor` (default `65536`, `0` = the whole tensor) |
| `--block-size <bytes>` | Range block size and read window (default `262144`) |
| `--json` | print the model info, tensor table and I/O stats as JSON |

How the on-demand reader behaves:

- `Range: bytes=0-0` learns the size and range support; a `200` answer means the host ignored the
  header, and `inspect` fails with `range_not_supported` rather than streaming the file.
- Reads are block-aligned and cached (LRU, 256 blocks × 256 KB by default), so parsing a header costs
  a handful of requests and re-reading it costs none.
- Requests carry `If-Range: <etag>`: if the file changed, the cache is dropped and the header is
  re-read instead of mixing old and new bytes.
- `416` becomes `range_not_satisfiable`; `404`, `401`/`403` and `5xx` are reported with their HTTP
  status, and transient failures are retried with backoff.
- Plain `http://` needs `--allow-insecure` (or `LOLLM_ALLOW_INSECURE=1`).

## `lollm list`

```text
NAME                 SIZE     PARAMS  QUANT   MODIFIED
qwen2.5:0.5b         379.4 MB 494M    Q4_K_M  11/3/2026, 4:41:00 AM
nomic-embed:latest   261.5 MB 137M    F16     11/2/2026, 9:12:11 PM
```

`--json` prints the `/api/tags` payload.

## `lollm ps`

Queries a running server (`http://<host>:<port>/api/ps`) and prints loaded models with expiry.
If no server is reachable it prints a hint instead of failing.

## `lollm show`

Prints architecture, parameter count, quantization, size, context length, digest, capabilities,
blob path, system prompt, template and parameters. `--json` prints the `/api/show` payload.

## `lollm create`

```bash
lollm create tutor -f Modelfile
lollm create tutor --from qwen2.5:0.5b --system "You are a patient tutor."
lollm create tutor --from qwen2.5:0.5b --parameter temperature=0.3 --parameter stop="</s>"
lollm create mine:q4 --from ./models/model.gguf
```

`FROM` may reference an installed model (weights are shared, no extra disk) or a local `.gguf`.
Flags override values from the Modelfile.

## `lollm cp`

```bash
lollm cp qwen2.5:0.5b qwen-small:latest
```

Copies the manifest; blobs are shared, so this is effectively free.

## `lollm rm`

```bash
lollm rm qwen-small:latest
lollm rm old:q4 old:q8
```

Removes manifests. Shared blobs stay until nothing references them.

## `lollm embed`

```bash
lollm embed nomic-embed-text "the quick brown fox"
lollm embed nomic-embed-text "…" --json
```

Prints the dimension count and the first values (or the full vector as JSON).

## Limits

`lollm` ships with **no caps**: no output-token limit, no context clamp, no request-body limit.
Generation stops when the model emits an end token, or when its context window is full — whatever
that window is for the GGUF you loaded.

Everything is opt-in:

```bash
lollm serve --max-tokens 512            # default for requests that do not set num_predict/max_tokens
lollm serve --context-size 8192         # smaller window than the model's own
lollm serve --max-body-bytes 104857600  # 0 (default) = unlimited
```

Per request: Ollama's `options.num_predict` and OpenAI's `max_tokens` win over the server default;
`-1`, `0` and "absent" all mean unlimited.

## `lollm version` / `lollm help`

```bash
lollm version
lollm help
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | usage error, missing model, failed download, server error |

Set `--verbose` to include stack traces.
