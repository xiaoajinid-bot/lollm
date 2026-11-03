# Model compatibility

`lollm` runs whatever the bundled `llama.cpp` build understands. This page explains how to check
a model before downloading it, what the current build supports, and which GGUF flavours are *not*
runnable even though they are valid GGUF.

## Check a model in one command

```bash
# header only: architecture, context, tensors, chat template — a few hundred KB over Range
lollm inspect hf:unsloth/Qwen3.8-27B-GGUF:BF16/Qwen3.8-27B-BF16-00001-of-00002.gguf

# a whole list, with exit code 1 if any of them is unreachable
npm run verify:remote -- <url|hf:repo:file.gguf> [...]
```

`inspect` prints `architecture`. That string decides everything: it must be an architecture the
llama.cpp build knows (`qwen35moe`, `qwen35`, `qwen3`, `llama`, `gemma3`, …). A GGUF file can be
perfectly valid and still be unrunnable here — for example diffusion models or audio models.

## Architectures in the current build

The bundled `node-llama-cpp` (3.22.x, llama.cpp `v0.7.0`) ships text and vision-language
architectures. Verified against the prebuilt Linux binary:

| Architecture | Status | Example |
|---|---|---|
| `llama`, `qwen2`, `qwen2moe`, `qwen2vl`, `qwen3`, `qwen3moe`, `qwen3next`, `qwen3vl`, `qwen3vlmoe` | supported | Qwen2.5, Qwen3, Qwen3-VL |
| `qwen35`, `qwen35moe` | supported | Qwen3.8-27B, Qwen3.6-35B-A3B |
| `gemma`, `gemma2`, `gemma3`, `phi3`, `mistral`, `deepseek2`, … | supported | see llama.cpp |
| `qwen_image21`, `flux`, `sd3`, `t5`-style diffusion stacks | **not supported** | Qwen-Image-2.1 GGUF (text-to-image) |

A text-to-image GGUF (Qwen-Image, FLUX, SDXL) contains UNet/diffusion tensors that llama.cpp's
inference graph cannot execute. `lollm inspect` still reads its header fine — that is a nice way to
look at the metadata — but `lollm pull` + `run` will fail at load time. Those models need ComfyUI or
diffusers, not llama.cpp.

## Vision and multi-modal models

GGUF vision models ship as two files: the language model (`…-IQ3_M.gguf`) plus a projector
(`mmproj-…-f16.gguf`). `lollm` loads text-only today; the projector is ignored, so image inputs are
dropped with a warning. Text chat with such a model works normally.

## Split GGUF files

Large models are split (`…-00001-of-00002.gguf`). Point `inspect`/`pull` at the **first** part; the
metadata carries `split.count` and the tensor list for that part. Keep every part in the same
directory when running locally — llama.cpp resolves the siblings by name.

## Quantization is not compatibility

`IQ3_M`, `Q4_K_M`, `Q8_0` and friends are all fine as long as the architecture is supported. What
actually matters:

| Symptom | Cause |
|---|---|
| `unknown model architecture` at load | architecture not in this llama.cpp build (e.g. `qwen_image21`) |
| loads, then nonsense or crashes | synthetic/random weights, or a broken or partial file |
| `does not look like a complete GGUF file` on pull | the URL returned HTML (a repo page, not a file) |
| header parses, tensor read fails | truncated download; `lollm pull` resumes with `Range` |

## Checking the four models from the issue

Recorded with the Hugging Face API (the sandbox used for development blocks egress to
`huggingface.co`, so the header probe itself could not run there):

| Reference | Size | Architecture | Runnable in `lollm`? |
|---|---|---|---|
| `abenzerps/Qwen-Image-2.1-Uncensored-GGUF` → `qwen-image-2.1-UC-BF16.gguf` | 14.2 GB | `qwen_image21` | **No** — text-to-image diffusion |
| `HauhauCS/Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive` → `…-IQ3_M.gguf` | 15.4 GB | `qwen35moe` (ctx 262144) | **Yes** — text + (separate mmproj) vision |
| `unsloth/Qwen3.8-27B-GGUF/tree/main/BF16` → `…-00001-of-00002.gguf` + `…-00002-of-00002.gguf` | 49.99 GB + 4.67 GB | `qwen35` (ctx 262144) | **Yes** — split model, both parts needed |
| `abenzerps/Qwen-Image-2.1-Uncensored-Quantized` → `qwen-image-2.1-UC-BF16.gguf` | 14.2 GB | `qwen_image21` | **No** — same file as above |

The `…-GGUF` repository redirects to `…-Quantized`; they are the same weights.

For the two runnable models, start with the header (cheap) and only then pull:

```bash
lollm inspect hf:HauhauCS/Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive:Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive-IQ3_M.gguf
lollm pull    hf:HauhauCS/Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive:Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive-IQ3_M.gguf --name qwen3.6:iq3m
```

Expect the header of a 15 GB file to cost a few hundred kilobytes to a few megabytes (tokenizer
arrays dominate), never the whole file.
