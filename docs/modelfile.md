# Modelfile

`lollm create` accepts the Ollama Modelfile dialect. A Modelfile is a small text file that pins a
base model, a system prompt, sampling parameters, a chat template and a license.

## Example

```dockerfile
# tutor.Modelfile
FROM qwen2.5:0.5b

PARAMETER temperature 0.6
PARAMETER top_p 0.95
PARAMETER num_ctx 8192
PARAMETER stop "<|im_end|>"

SYSTEM """You are a patient tutor.
Explain in short paragraphs and always give one example."""

TEMPLATE """<|im_start|>system
{{ .System }}<|im_end|>
<|im_start|>user
{{ .Prompt }}<|im_end|>
<|im_start|>assistant
"""

LICENSE """Apache-2.0"""

MESSAGE user hello
MESSAGE assistant hi! ready to learn?
```

```bash
lollm create tutor -f tutor.Modelfile
lollm run tutor "What is a KV cache?"
```

## Directives

| Directive | Required | Meaning |
|---|---|---|
| `FROM` | yes | installed model (`qwen2.5:0.5b`) or path to a `.gguf` file |
| `PARAMETER` | no | generation or load parameter, one per line, repeatable |
| `SYSTEM` | no | system prompt layer |
| `TEMPLATE` | no | Go-template prompt format (see below) |
| `LICENSE` | no | license text/name, surfaced by `/api/show` |
| `MESSAGE` | no | few-shot example (`MESSAGE <role> <content>`) |
| `ADAPTER` | no | parsed but rejected on load (LoRA is not supported yet) |

Values may be plain, single-quoted, double-quoted or triple-quoted (`"""…"""` for multi-line).
`#` starts a comment line. Unknown directives are rejected with the line number instead of being
silently ignored.

## Parameters

Anything the engine understands:

| Parameter | Type | Notes |
|---|---|---|
| `temperature` | float | 0 = deterministic |
| `top_p`, `top_k`, `min_p` | float/int | nucleus / top-k / min-p sampling |
| `repeat_penalty` | float | > 1 discourages repetition |
| `presence_penalty`, `frequency_penalty` | float | OpenAI-style penalties |
| `seed` | int | reproducible sampling |
| `num_predict` | int | max tokens to generate |
| `stop` | string | repeat for multiple stop sequences |
| `num_ctx` | int | context window |
| `num_gpu` | int | layers offloaded to GPU |
| `num_thread` | int | CPU threads |

Request-level `options` (or OpenAI fields) override Modelfile defaults.

## Templates

Templates use Go's `text/template` syntax, the same as Ollama. lollm implements the subset that
every model in the Ollama library uses:

| Construct | Meaning |
|---|---|
| `{{ .System }}` | system prompt (empty string if unset) |
| `{{ .Prompt }}` | user prompt for `/api/generate` |
| `{{ .Response }}` | assistant prefix (empty during generation) |
| `{{ .Messages }}` | list of messages, for chat templates |
| `{{ .Role }}`, `{{ .Content }}` | fields available inside `range .Messages` |
| `{{ if … }} … {{ else }} … {{ end }}` | conditionals |
| `{{ range … }} … {{ end }}` | iteration |
| `{{- … -}}` | whitespace trimming |

Unsupported constructs (`define`, `block`, named partials, variables, pipelines) render as empty
strings rather than failing — a slightly degraded prompt beats a broken server.

If a model has **no** stored template, lollm lets `node-llama-cpp` apply the model's own chat
wrapper (ChatML, Llama 3, Gemma, Qwen, Mistral, …), detected from GGUF metadata. When a template
exists it wins for `/api/chat` and `/api/generate` (except `raw: true`), which is exactly how Ollama
behaves.

## What gets stored

`lollm create` writes a manifest under
`~/.lollm/models/manifests/lollm.local/library/<name>/<tag>` referencing:

- `application/vnd.ollama.image.model` — the GGUF blob (shared with the `FROM` model)
- `application/vnd.ollama.image.template`
- `application/vnd.ollama.image.system`
- `application/vnd.ollama.image.license`
- `application/vnd.ollama.image.params`

Because the weights are content-addressed and shared, creating ten variants of a 7B model costs
kilobytes, not gigabytes.

## Creating a model from the API

```bash
curl http://127.0.0.1:11434/api/create -d '{
  "model": "tutor",
  "modelfile": "FROM qwen2.5:0.5b\nSYSTEM \"\"\"Be brief.\"\"\"\nPARAMETER temperature 0.4"
}'
```

The same validation runs for the CLI, the HTTP API and the library API.
