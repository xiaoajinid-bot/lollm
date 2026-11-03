<div align="center">

# lollm

**Server LLM lokal yang kompatibel dengan Ollama, dibangun di atas llama.cpp + Node.js.**

Jalankan model GGUF di komputer sendiri, pakai API yang sudah dikenal tooling Ollama,
tanpa Python, tanpa daemon terpisah, tanpa API key.

`npx lollm serve` → `http://127.0.0.1:11434`

</div>

---

## Kenapa proyek ini ada

Ollama adalah daemon Go dengan registry, format Modelfile, dan API-nya sendiri. Kalau stack kamu
JavaScript/TypeScript, biasanya kamu menempelkan biner Go ke proses Node lalu berdoa versinya cocok.

`lollm` membalik pendekatan itu:

- **API native Ollama** (`/api/chat`, `/api/generate`, `/api/tags`, `/api/pull`, …) sehingga
  Open WebUI, Continue, LangChain, dan `ollama-js` tetap jalan.
- **API OpenAI** (`/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`) sehingga SDK resmi
  dan framework AI langsung bisa dipakai tanpa proxy.
- **Model store ala Ollama** (`~/.lollm/models/{blobs,manifests}`) dengan layer content-addressed,
  jadi `lollm pull` bisa mengambil model dari `registry.ollama.ai`, Hugging Face, URL apa pun,
  atau file `.gguf` lokal.
- **llama.cpp di belakangnya** lewat [`node-llama-cpp`](https://github.com/withcatai/node-llama-cpp) —
  mesin inferensi yang sama, hanya di-binding ke Node.
- **Playground bawaan** di `/playground` dan CLI yang terasa seperti `ollama`.

## Fitur

| | |
|---|---|
| Backend | llama.cpp lewat `node-llama-cpp` (CPU, Metal, CUDA, Vulkan) + backend `mock` deterministik untuk CI |
| Format model | GGUF v1–v3, termasuk metadata dan chat template per model |
| Sumber model | registry Ollama, Hugging Face (`hf:`), URL `https://`, file `.gguf` lokal, Modelfile |
| Model on-demand | header GGUF dibaca lewat HTTP `Range` (cache blok 256 KB), potongan tensor hanya diambil saat dibaca, unduhan bisa dilanjutkan |
| Tanpa limit tersembunyi | tidak ada batas token, context, atau ukuran body kecuali kamu memintanya |
| API Ollama | version, tags, ps, show, chat, generate, embed, embeddings, pull, create, copy, delete |
| API OpenAI | models, chat/completions, completions, embeddings (streaming, tools, JSON mode) |
| Streaming | NDJSON (Ollama) dan SSE (OpenAI), sadar backpressure & abort klien |
| Sampling | temperature, top_p, top_k, min_p, repeat/presence/frequency penalty, seed, stop, num_ctx, num_gpu |
| Output terstruktur | `format: "json"`, JSON Schema grammar, `response_format` OpenAI |
| Tool calling | skema tool Ollama/OpenAI dipetakan ke grammar function-call llama.cpp |
| Manajemen model | keep-alive, eviksi saat idle, LRU, batas konkurensi, antrean |
| Operasional | CORS, request ID, `/api/health`, graceful shutdown, Dockerfile, tes tanpa dependensi |

## Mulai cepat

```bash
npm install -g lollm          # butuh Node 20+
lollm pull qwen2.5:0.5b           # ± 400 MB
lollm serve                       # http://127.0.0.1:11434
```

Buka <http://127.0.0.1:11434/playground>, atau langsung:

```bash
curl http://127.0.0.1:11434/api/chat -d '{
  "model": "qwen2.5:0.5b",
  "messages": [{ "role": "user", "content": "Jelaskan GGUF dalam satu kalimat." }],
  "stream": false
}'
```

```js
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "http://127.0.0.1:11434/v1", apiKey: "tidak-diperlukan" });

const res = await client.chat.completions.create({
  model: "qwen2.5:0.5b",
  messages: [{ role: "user", content: "Halo!" }],
});
console.log(res.choices[0].message.content);
```

## Perintah CLI

```text
lollm serve                     Jalankan server API (default 127.0.0.1:11434)
lollm run <model> [prompt...]   Chat di terminal (streaming, REPL kalau tanpa prompt)
lollm pull <referensi>          Ambil model dari Ollama, Hugging Face, URL, atau file
lollm inspect <url>             Baca metadata GGUF dari jarak jauh (opsi: --tensor, --json)
lollm list                      Daftar model terpasang
lollm ps                        Model yang sedang dimuat server
lollm show <model>              Detail, template, parameter, Modelfile
lollm create <nama> [-f file]   Buat model dari Modelfile
lollm cp <asal> <tujuan>        Duplikasi model (berbagi bobot, ~0 byte)
lollm rm <model...>             Hapus model
lollm embed <model> <teks>      Hitung embedding
```

## Mengambil model

```bash
lollm pull qwen2.5:0.5b                                       # registry.ollama.ai
lollm pull hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:qwen2.5-0.5b-instruct-q4_k_m.gguf --name qwen2.5:0.5b
lollm pull https://contoh.com/model.gguf --name punya-saya:q4
lollm pull ./model-lokal.gguf --name lokal:latest
```

### Tidak ada limit kecuali kamu set

`lollm` tidak mengarang batas. Default-nya:

| Knob | Default | Arti |
|---|---|---|
| token output | tanpa batas | generasi berjalan sampai model mengeluarkan token akhir (atau context penuh) |
| context window | milik model | `llama.cpp` memakai window asli GGUF; `lollm` tidak mengecilkannya |
| body request | tanpa batas | tidak ada potongan diam-diam 1 MB/64 MB untuk prompt besar atau gambar base64 |
| konkurensi | 1 generasi | ini soal antrean, bukan token — naikkan dengan `--parallel` |

Semua batas bersifat opsional:

```bash
lollm serve --max-tokens 512            # LOLLM_MAX_TOKENS
lollm serve --context-size 8192         # LOLLM_CONTEXT_SIZE (atau "auto")
lollm serve --max-body-bytes 104857600  # LOLLM_MAX_BODY_BYTES (0 = tanpa batas)
```

Per request, `options.num_predict` (Ollama) dan `max_tokens` (OpenAI) tetap berlaku; nilai `-1`,
`0`, atau tidak diisi berarti tanpa batas.

### Intip model tanpa mengunduhnya

GGUF diawali header berisi arsitektur, jumlah parameter, context, dan tabel tensor — biasanya hanya
ratusan kilobyte, sementara bobotnya gigabyte. `lollm inspect` memanfaatkan itu: ia meminta beberapa
byte pertama lewat `Range`, membaca header, lalu berhenti.

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

`--tensor token_embd` mengambil satu potongan tensor saja (berguna untuk memastikan kuantisasi atau
membuat fingerprint tanpa menyalin file), dan `--json` mencetak data yang sama untuk skrip.

Cara kerjanya:

- Satu probe `Range: bytes=0-0` untuk mengetahui ukuran dan dukungan Range. Server yang menjawab
  `200` (mengabaikan Range) ditolak dengan `range_not_supported`, bukan di-stream diam-diam.
- Setiap pembacaan berikutnya adalah request `Range` sejajar blok (default 256 KB, atur dengan
  `--block-size`) dengan cache LRU dan `If-Range: <etag>`, jadi membaca header berulang kali gratis.
- `lollm pull <url>` juga memeriksa header lebih dulu: URL yang bukan GGUF gagal dalam milidetik.
  Transfernya bisa dilanjutkan dari file `.part` + `ETag` setelah Ctrl+C, crash, atau koneksi putus.
- `http://` biasa ditolak kecuali `--allow-insecure` atau `LOLLM_ALLOW_INSECURE=1`.
- `LOLLM_HF_ENDPOINT` / `--hf-endpoint` mengarahkan referensi `hf:` ke mirror atau server lokal
  (dipakai juga oleh tes Range yang berjalan offline).

Untuk memeriksa banyak model sekaligus (exit code 1 kalau ada yang gagal):

```bash
npm run verify:remote -- <url|hf:repo:file.gguf> [...] [--tensor nama] [--json]
```

Struktur penyimpanan:

```text
~/.lollm/models/
├── blobs/sha256-<hex>                         # bobot GGUF + layer template/system/parameter
└── manifests/lollm.local/library/<model>/<tag>
```

## Deploy ke Vercel

API dan playground yang sama bisa jalan sebagai serverless function:

```bash
npx vercel link --project lollm-ai
npx vercel deploy --prod
```

`api/index.mjs` meneruskan request ke router lokal, jadi `/api/*`, `/v1/*`, streaming, dan
`/playground` tetap sama. Backend `mock` dipakai default di Vercel (tanpa binding native) dan satu
model demo kecil otomatis dibuat saat boot. Inference llama.cpp asli butuh binding native + model di
`/tmp` — lihat [docs/vercel.md](docs/vercel.md).

## Modelfile

```dockerfile
FROM qwen2.5:0.5b
PARAMETER temperature 0.7
PARAMETER stop "<|im_end|>"
SYSTEM """Kamu tutor yang sabar. Jawab dalam bahasa Indonesia."""

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

## Konfigurasi penting

| Flag | Env | Default | Arti |
|---|---|---|---|
| `--host` | `LOLLM_HOST` | `127.0.0.1` | alamat bind (`0.0.0.0` untuk Docker/LAN) |
| `--port` | `LOLLM_PORT` | `11434` | port (default Ollama agar klien lama tetap jalan) |
| `--home` | `LOLLM_HOME` | `~/.lollm` | direktori data |
| `--backend` | `LOLLM_BACKEND` | `llama` | `llama` atau `mock` |
| `--gpu` | `LOLLM_GPU` | `auto` | `auto`, `false`, `cuda`, `metal`, `vulkan` |
| `--context-size` | `LOLLM_CONTEXT_SIZE` | model | context window (default: milik model, `auto`) |
| `--max-tokens` | `LOLLM_MAX_TOKENS` | tanpa batas | batas token output (opsional) |
| `--max-body-bytes` | `LOLLM_MAX_BODY_BYTES` | tanpa batas | batas ukuran body request (opsional) |
| `--hf-endpoint` | `LOLLM_HF_ENDPOINT` | `https://huggingface.co` | base URL untuk referensi `hf:` |
| `--parallel` | `LOLLM_PARALLEL` | `1` | generasi bersamaan |
| `--keep-alive` | `LOLLM_KEEP_ALIVE` | `5m` | lama model tetap dimuat |
| `--verbose` | `LOLLM_VERBOSE` | `false` | log debug |
| `--allow-insecure` | `LOLLM_ALLOW_INSECURE` | `false` | izinkan unduhan model lewat `http://` |
| `--block-size` | — | `262144` | ukuran blok Range untuk `inspect` |
| — | `HF_TOKEN` | — | token Hugging Face untuk repo privat |

## Menguji

```bash
npm test        # 111 tes, tanpa unduh model, tanpa GPU, tanpa jaringan
npm run check   # cek sintaks semua modul
```

Tes berjalan memakai **backend mock** yang mengimplementasikan kontrak backend asli secara
deterministik (streaming, tool call, embedding), sehingga CI cepat dan hermetis — sementara lapisan
HTTP, framing streaming, model store, parser GGUF (termasuk pembacaan Range dan unduhan
yang bisa dilanjutkan, memakai server HTTP lokal di dalam tes), Modelfile, dan template tetap diuji.

## Batasan (jujur saja)

- `push`, verifikasi signature model, layer projector multi-modal, dan adapter LoRA belum ada
  (adapter dilewati saat pull dengan peringatan; gambar diterima lalu diabaikan).
- `/api/version` melaporkan versi yang kompatibel dengan Ollama agar klien yang memeriksa versi
  tetap jalan, ditambah field `lollm` berisi versi asli. Cek `/api/health` untuk kebenaran.
- Pemformatan prompt memakai template model bila ada; kalau tidak, chat wrapper `node-llama-cpp`
  untuk arsitektur tersebut (ChatML, Llama 3, Gemma, Qwen, …).
- Tool call dieksekusi di klien, bukan di server — sama seperti Ollama.
- Default hanya satu model panas di memori; naikkan `--max-loaded-models` kalau RAM cukup.

## Lisensi

[MIT](LICENSE). llama.cpp, `node-llama-cpp`, dan setiap model yang kamu ambil punya lisensinya sendiri.
