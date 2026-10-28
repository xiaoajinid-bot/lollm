# Vercel Local LLM (`lokal-llm.vercel.app`)

Aplikasi **Server-side Local LLM** yang menjalankan model open-source `GGUF` (`Qwen2.5-0.5B-Instruct`, `SmolLM2-360M-Instruct`, `SmolLM2-135M-Instruct`) secara langsung di **CPU Vercel Serverless Function (Fluid Compute)** menggunakan `node-llama-cpp` (`llama.cpp` SIMD x86_64) — **100% tanpa API key eksternal** — lengkap dengan **Web Chat UI** serta **OpenAI & Ollama Compatible Public API**.

---

## Status Project Vercel Anda

Project Vercel telah dibuat dan dikonfigurasi pada akun/tim Anda (`lnksys1`):

- **Nama Project**: `lokal-llm`
- **Project ID**: `prj_ngpyhJbAGvoBxpPo1eJah3obpsUr`
- **Public Production Domain**: `https://lokal-llm.vercel.app` *(Verified & bebas proteksi SSO saat di-deploy ke Production)*
- **Environment Variables Terpasang**:
  - `NODE_LLAMA_CPP_SKIP_DOWNLOAD=true`
  - `NODE_LLAMA_CPP_POSTINSTALL=skip`
  - `NODE_LLAMA_CPP_GPU=false`
- **Fluid Compute Timeout**: `300` detik (`maxDuration: "max"`)

---

## Cara Deploy ke Domain Publik `https://lokal-llm.vercel.app`

> **Catatan**: Upload kode mentah langsung lewat API konektor diblokir oleh filter keamanan (*security filter/WAF*) penyedia konektor karena payload berisi berkas kode/HTML aplikasi. Project & domain publik Anda sudah siap di Vercel — cukup jalankan salah satu dari dua cara berikut untuk mempublikasikan kodenya ke **Production**:

### Opsi A — Deploy Langsung via Vercel CLI (Paling Cepat)

1. Unduh arsip `lokal-llm-vercel.zip` dari workspace ini lalu ekstrak di komputer Anda:
   ```bash
   unzip lokal-llm-vercel.zip -d vercel-local-llm
   cd vercel-local-llm
   ```
2. Hubungkan ke project `lokal-llm` yang sudah dibuat & deploy ke **Production** (`--prod` wajib agar masuk ke domain publik `lokal-llm.vercel.app` tanpa terhalang Vercel Authentication/SSO):
   ```bash
   npx vercel link --project lokal-llm --yes
   npx vercel --prod
   ```

### Opsi B — Via GitHub Repository (Auto-Deploy)

1. Push folder `vercel-local-llm` ke repository GitHub Anda.
2. Buka dashboard Vercel → pilih project **`lokal-llm`** → **Settings → Git** → hubungkan repository GitHub tersebut. Setiap push ke branch `main` akan otomatis ter-deploy ke **`https://lokal-llm.vercel.app`**.

---

## Endpoint Public Domain (`https://lokal-llm.vercel.app`)

Seluruh endpoint sudah dilengkapi header `Access-Control-Allow-Origin: *` sehingga dapat diakses publik dari browser, `curl`, SDK OpenAI, maupun aplikasi eksternal:

| Method | Endpoint | Deskripsi |
|---|---|---|
| `GET` | `/` | Web Chat UI Playground & API Tester |
| `GET` | `/api/health` | Status container (`warm`/`cold`), penggunaan RAM (`RSS`), & sisa ruang `/tmp` |
| `POST` | `/api/warmup` | Preload model GGUF ke RAM container |
| `GET` | `/v1/models` | Daftar model kompatibel OpenAI SDK |
| `POST` | `/v1/chat/completions` | Chat Completions OpenAI (`stream: true` SSE & `stream: false` JSON) |
| `GET` | `/api/tags` | Daftar model kompatibel Ollama |
| `POST` | `/api/generate` | Endpoint generasi kompatibel Ollama |

### Contoh Pemanggilan Public API (`curl`)

```bash
curl -s https://lokal-llm.vercel.app/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen2.5-0.5b-instruct",
    "messages": [
      {"role": "user", "content": "Halo! Jelaskan singkat keuntungan Local LLM."}
    ],
    "temperature": 0.65,
    "max_tokens": 256
  }'
```

### Contoh Pemanggilan via Python (`openai` SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://lokal-llm.vercel.app/v1",
    api_key="local-no-key-required",
)

resp = client.chat.completions.create(
    model="qwen2.5-0.5b-instruct",
    messages=[{"role": "user", "content": "Buatkan fungsi faktorial dalam Python."}],
    stream=True,
)

for chunk in resp:
    print(chunk.choices[0].delta.content or "", end="", flush=True)
```
