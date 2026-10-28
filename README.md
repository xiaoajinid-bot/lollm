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

---

## Function / Tool Calling & Connector

Model dapat memanggil **tool** (fungsi lokal) maupun **connector** (API HTTP eksternal)
sebelum menjawab. Server mengeksekusi tool secara otomatis, lalu mengirim hasilnya
kembali ke model untuk menghasilkan jawaban final — semuanya dalam satu request.

### Endpoint

| Method | Endpoint | Deskripsi |
|---|---|---|
| `GET` | `/api/tools` (alias `/v1/tools`) | Katalog tool & connector dalam format schema OpenAI (`tools[]`) |
| `POST` | `/api/tools` | Memanggil tool secara langsung (tanpa LLM), berguna untuk debugging |
| `POST` | `/v1/chat/completions` | Mendukung `tools`, `functions` (legacy), `tool_choice`, `max_tool_rounds` |

### Contoh `curl`

```bash
# Lihat tool yang tersedia
curl -s https://lollm-psi.vercel.app/api/tools

# Chat dengan tool calling
curl -s https://lollm-psi.vercel.app/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen2.5-0.5b-instruct",
    "messages": [{"role": "user", "content": "Berapa (19*23)+7 dan jam berapa sekarang?"}],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "calculate",
          "description": "Menghitung ekspresi matematika",
          "parameters": {
            "type": "object",
            "properties": {"expression": {"type": "string"}},
            "required": ["expression"]
          }
        }
      }
    ],
    "tool_choice": "auto",
    "max_tool_rounds": 2
  }'
```

Respons JSON menyertakan `choices[0].message.content` (jawaban final) dan
`tool_trace` berisi tool yang dijalankan server:

```json
{
  "choices": [{ "index": 0, "message": { "role": "assistant", "content": "..." }, "finish_reason": "stop" }],
  "tool_trace": [
    { "name": "calculate", "arguments": { "expression": "(19*23)+7" }, "ok": true, "duration_ms": 1, "result_preview": "{\"result\":444}" }
  ],
  "tool_rounds": 2,
  "usage": { "prompt_tokens": 120, "completion_tokens": 48, "total_tokens": 168 }
}
```

Saat `stream: true`, jejak tool dikirim sebagai komentar SSE
(`: status {"phase":"tool_call"|"tool_result", ...}`) sehingga tidak mengganggu
klien OpenAI standar, dan blok JSON panggilan tool tidak pernah muncul sebagai isi jawaban.

### Cara kerja

1. Kontrak tool (nama, deskripsi, skema argumen) disuntikkan ke system prompt.
2. Keluaran model diparse dari beberapa format: `<tool_call>{...}</tool_call>`,
   blok ```` ```json ````, atau JSON telanjang `{"name":..., "arguments":...}`.
3. Tool yang dikenal server dieksekusi, hasilnya dikirim balik sebagai pesan `role: "tool"`,
   lalu model melanjutkan generasi (maksimum `max_tool_rounds`, default 3, batas 6).
4. Tool yang **tidak** dikenal server dianggap milik client → respons berhenti dengan
   `finish_reason: "tool_calls"` + `message.tool_calls`, dan client yang mengeksekusi.

### Tool bawaan

| Tool | Fungsi |
|---|---|
| `get_current_time` | Tanggal & jam (zona waktu IANA) |
| `calculate` | Aritmetika aman via parser sendiri (tanpa `eval`), mendukung `sqrt`, `min`, `max`, `^` |
| `convert_units` | Konversi panjang, massa, volume, data, kecepatan, waktu, dan suhu |
| `wikipedia_summary` | Ringkasan artikel Wikipedia (id/en/jv/su) |
| `llm_runtime_info` | Status runtime LLM (model aktif, RAM, region Vercel) |
| `http_fetch` | GET/POST ke API publik — **wajib allowlist** |

### Connector kustom (`LLM_CONNECTORS`)

Tambahkan environment variable berikut di Vercel (Project → Settings → Environment Variables):

```bash
LLM_CONNECTORS='[
  {
    "name": "cuaca_kota",
    "description": "Info cuaca terkini untuk sebuah kota",
    "parameters": {
      "type": "object",
      "properties": { "kota": { "type": "string" } },
      "required": ["kota"]
    },
    "request": {
      "url": "https://api.contoh.com/cuaca?q={{kota}}&unit=c",
      "method": "GET",
      "headers": { "Authorization": "Bearer {{env:CUACA_API_KEY}}" }
    },
    "response_path": "current",
    "max_chars": 1200
  },
  {
    "name": "buat_tiket",
    "description": "Membuat tiket dukungan baru",
    "parameters": {
      "type": "object",
      "properties": {
        "judul": { "type": "string" },
        "prioritas": { "type": "string", "enum": ["low", "high"] }
      },
      "required": ["judul"]
    },
    "request": {
      "url": "https://api.contoh.com/tiket",
      "method": "POST",
      "body": { "title": "{{judul}}", "priority": "{{prioritas}}" }
    },
    "response_path": "data.id"
  }
]'

# Host tujuan wajib ada di allowlist (proteksi SSRF)
LLM_TOOL_HTTP_ALLOW_HOSTS="api.contoh.com"
```

Placeholder yang didukung: `{{nama_argumen}}` untuk argumen model dan
`{{env:NAMA_ENV}}` untuk secret. `response_path` memakai dot-path
(`data.items.0.name`) untuk memangkas respons, `max_chars` membatasi ukuran hasil.

### Environment variable terkait

| Variabel | Default | Fungsi |
|---|---|---|
| `LLM_CONNECTORS` | – | JSON array definisi connector HTTP |
| `LLM_TOOL_HTTP_ALLOW_HOSTS` | – | Allowlist host untuk `http_fetch` & connector (wajib) |
| `LLM_TOOLS_DISABLED` | – | Daftar nama tool dipisah koma untuk dimatikan |
| `LLM_TOOL_MAX_ROUNDS` | `3` | Batas putaran tool per request (maks 6) |
| `LLM_TOOLS_DIRECT_INVOKE` | aktif | Set `disabled` untuk menonaktifkan `POST /api/tools` |

### Keamanan

- `calculate` memakai parser sendiri — tidak ada `eval`/`Function` yang bisa dieksploitasi.
- `http_fetch` dan connector selalu menolak `localhost`, IP privat/link-local
  (`127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `::1`, `fc00::/7`),
  host `.local`/`.internal`, serta metadata cloud; host lain harus ada di allowlist.
- Hasil tool dibatasi ukurannya (`max_chars`, maksimum 64 KB per respons HTTP) agar konteks 2048 token tidak jebol.
- `POST /api/tools` bisa dimatikan lewat `LLM_TOOLS_DIRECT_INVOKE=disabled`.

### Uji otomatis

```bash
npm test   # 40 test: parser tool, executor, agent loop, dan endpoint API (SSE)
```
