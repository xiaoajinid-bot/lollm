# Deploying lollm to Vercel

Yes — the whole HTTP surface runs on Vercel Functions. `api/index.mjs` hands each request to the
same router that `lollm serve` uses, so `/api/*`, `/v1/*`, streaming NDJSON/SSE and `/playground`
behave identically to a local install.

```text
Browser / SDK ─► Vercel Function (api/index.mjs) ─► lollm router ─► engine
                                   │
                                   └─ model store in /tmp/lollm (ephemeral)
```

## What works

| Capability | On Vercel |
|---|---|
| `GET /` readiness probe | ✅ |
| `/api/version`, `/api/tags`, `/api/show`, `/api/ps` | ✅ |
| `/api/chat`, `/api/generate`, `/api/embed` (streaming) | ✅ |
| `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings` | ✅ |
| `/playground` | ✅ |
| `lollm inspect`-style remote GGUF header reads (`/api/show` on a remote model) | ✅ (a few hundred KB per header, perfect for serverless) |
| `POST /api/pull` | ✅ but the file lands in `/tmp` and is lost when the instance is recycled |
| Real llama.cpp inference | ⚠️ needs the native binding, see below |
| Persistent model storage | ❌ `/tmp` only (~512 MB, ephemeral) |

The function uses the deterministic **mock backend** by default, because the native llama.cpp
binding is not part of the Vercel build. To make the hosted playground useful out of the box, the
first invocation seeds a tiny demo model (`examples/demo-model.gguf`, 2.4 KB) as
`lollm-demo:latest`. Disable with `LOLLM_SEED_DEMO=0`.

## Configuration

`vercel.json` in the repository root:

```json
{
  "installCommand": "npm ci --omit=optional --ignore-scripts --no-audit --no-fund",
  "functions": {
    "api/index.mjs": {
      "maxDuration": 300,
      "memory": 1024,
      "includeFiles": "{web/**,examples/demo-model.gguf}"
    }
  },
  "rewrites": [{ "source": "/(.*)", "destination": "/api/index.mjs" }]
}
```

Environment variables:

| Variable | Default on Vercel | Meaning |
|---|---|---|
| `LOLLM_HOME` | `/tmp/lollm` | data directory (only `/tmp` is writable) |
| `LOLLM_BACKEND` | `mock` | `mock` or `llama` |
| `LOLLM_SEED_DEMO` | `1` | seed `lollm-demo:latest` when the store is empty |
| `LOLLM_PLAYGROUND` | `1` | serve `/playground` |
| `LOLLM_MAX_TOKENS` | unset (unlimited) | optional output-token cap |
| `LOLLM_CONTEXT_SIZE` | unset (model default) | optional context clamp |
| `LOLLM_HF_ENDPOINT` | `https://huggingface.co` | mirror for `hf:` references |

## Deploy

From the repository root:

```bash
npx vercel link     # create/link the project, e.g. lollm-ai
npx vercel deploy   # preview
npx vercel deploy --prod
```

Or import the Git repository in the Vercel dashboard: framework preset **Other**, root directory
`.`, no build command, and Vercel picks up `api/index.mjs` automatically.

After the first deploy, check:

```bash
curl -s https://<deployment>/api/version
curl -s https://<deployment>/api/tags
open  https://<deployment>/playground
```

## Real inference on Vercel (opt-in)

llama.cpp is a native addon. Vercel's function bundle is capped (~250 MB uncompressed) and `/tmp`
is ~512 MB, so only small quantized models fit. If you want it:

1. Add the prebuilt binding to the deployment:

   ```bash
   npm install @node-llama-cpp/linux-x64@3.22.2 node-llama-cpp@3.22.2
   ```

   and drop `--omit=optional` from `installCommand` (keep `--ignore-scripts`; the binaries ship in
   the platform package).

2. Set `LOLLM_BACKEND=llama`.

3. Fetch a model into `/tmp` at runtime. `POST /api/pull` with a small GGUF works, e.g.

   ```bash
   curl -s https://<deployment>/api/pull -d '{"model":"hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:qwen2.5-0.5b-instruct-q4_k_m.gguf","name":"qwen2.5:0.5b","stream":false}'
   ```

   and then chat with it. Downloads count against the 300 s function budget and the ~512 MB `/tmp`
   allowance: a Q4_K_M 0.5B model (~400 MB) is about the practical ceiling.

Cold starts with a 100 MB+ addon and a 400 MB model are slow; the local CLI remains the better home
for real inference. Use Vercel for the API surface, the playground, and header-only inspection of
huge remote models.
