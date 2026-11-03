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
| `scripts/smoke.mjs` against a deployed instance | ✅ `npm run smoke -- https://<deployment>` |
| Real llama.cpp inference | ✅ small GGUFs pulled into `/tmp`, see [Real models](#real-models-llamacpp-in-the-function) |
| Persistent model storage | ❌ `/tmp` only (~512 MB, ephemeral) |

The function runs the real llama.cpp backend (`LOLLM_BACKEND=llama`) and pulls a small GGUF into
`/tmp` on first use — see [Real models](#real-models-llamacpp-in-the-function). With
`LOLLM_BACKEND=mock` it instead seeds a tiny placeholder model (`examples/demo-model.gguf`,
2.4 KB) as `lollm-demo:latest`, which is what CI uses; disable with `LOLLM_SEED_DEMO=0`.

## Configuration

`vercel.json` in the repository root:

```json
{
  "framework": null,
  "installCommand": "npm ci --ignore-scripts --no-audit --no-fund && node scripts/vercel-prune.mjs",
  "functions": {
    "api/index.mjs": {
      "maxDuration": 300,
      "memory": 1024,
      "includeFiles": "{web/**,examples/demo-model.gguf,node_modules/node-llama-cpp/**,node_modules/@node-llama-cpp/linux-x64/**}"
    }
  },
  "rewrites": [{ "source": "/(.*)", "destination": "/api/index.mjs" }]
}
```

`"framework": null` matters: without it Vercel detects a Node *server* from `main`/`start` in
`package.json`, builds `src/index.mjs` as the root lambda (it has no request handler) and drops the
rewrites, so every request fails with `FUNCTION_INVOCATION_FAILED`.

Environment variables:

| Variable | Default on Vercel | Meaning |
|---|---|---|
| `LOLLM_HOME` | private `mkdtemp` directory in the platform temp dir | data directory (only the temp dir is writable) |
| `LOLLM_BACKEND` | `llama` | `mock` or `llama` |
| `LOLLM_BOOT_MODEL` | SmolLM2-360M-Instruct Q4_K_M (`hf:`) | model pulled into `/tmp` on first use; `0` disables |
| `LOLLM_BOOT_MODEL_NAME` | `smollm2:360m` | name the boot model is stored under |
| `LOLLM_SEED_DEMO` | `1` | seed `lollm-demo:latest` when the store is empty (mock backend only) |
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

## Making the deployment public

Vercel accounts default to **Standard Protection**, so `https://<deployment>.vercel.app` redirects
to a Vercel login even for production. To expose the API publicly, open *Project → Settings →
Deployment Protection* and set **Vercel Authentication** to **Disabled** (or attach a custom domain,
which is not covered by the default `all_except_custom_domains` policy). Preview deployments stay
private unless you disable protection for them too.

## Real models (llama.cpp in the function)

The hosted instance runs genuine llama.cpp inference, not the mock backend:

- `node-llama-cpp` plus the prebuilt `@node-llama-cpp/linux-x64` binary (~74 MB) are traced into the
  function. `scripts/vercel-prune.mjs` deletes the CUDA/Vulkan/arm flavours that npm also installs,
  which would otherwise push the bundle past the 250 MB limit.
- Weights are far too large to ship, so the first invocation of each instance pulls a small GGUF
  into the temporary model store (`/tmp`, ~512 MB) and then serves it:

  | Setting | Default |
  |---|---|
  | `LOLLM_BACKEND` | `llama` on Vercel (`mock` in CI) |
  | `LOLLM_BOOT_MODEL` | `hf:bartowski/SmolLM2-360M-Instruct-GGUF:SmolLM2-360M-Instruct-Q4_K_M.gguf` (258 MB) |
  | `LOLLM_BOOT_MODEL_NAME` | `smollm2:360m` |

  Set `LOLLM_BOOT_MODEL=0` to skip the boot pull, or point it at any `hf:`, `https://` or `file:`
  reference. `Qwen2.5-0.5B-Instruct q2_k` (415 MB) is the largest that still fits comfortably.

What this means in practice: the first request after a cold start pays the download (~5–15 s on
Vercel's network) plus the model load (~1–2 s); warm instances stream normally at tens of tokens per
second on the 2-core function. `/api/ps` shows what is resident, `/api/pull` works as usual — but
everything in `/tmp` disappears when the instance is recycled, so treat the deployment as a live
demo rather than storage. For serious models and long contexts, run `lollm serve` locally or in
Docker.

