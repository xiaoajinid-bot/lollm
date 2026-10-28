/**
 * Uji fungsional UI `public/index.html` dengan jsdom.
 *
 * Menjalankan file HTML asli (script module diubah menjadi script klasik agar
 * jsdom mau mengeksekusinya) dan menstub semua request `fetch`, sehingga
 * journey pengguna bisa diuji tanpa server, model GGUF, maupun browser.
 *
 * jsdom BUKAN dependency project (agar bundle serverless tetap ringan).
 * Pasang sekali secara lokal:
 *     npm install --no-save jsdom
 * lalu jalankan:
 *     node tests/ui/functional.mjs
 *
 * Jika jsdom dipasang di lokasi lain, set JSDOM_PATH ke folder paketnya:
 *     JSDOM_PATH=/path/node_modules/jsdom node tests/ui/functional.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
/* UI_INDEX bisa diarahkan ke salinan lain (mis. versi sebelum perbaikan) */
const INDEX = process.env.UI_INDEX || path.resolve(here, '..', '..', 'public', 'index.html');

function loadJsdom() {
  const candidates = [process.env.JSDOM_PATH, 'jsdom'].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      /* coba kandidat berikutnya */
    }
  }
  console.error(
    'jsdom tidak ditemukan. Jalankan `npm install --no-save jsdom` lebih dulu,\n' +
      'atau set JSDOM_PATH ke folder node_modules/jsdom.'
  );
  process.exit(2);
}

const { JSDOM } = loadJsdom();
const html = fs.readFileSync(INDEX, 'utf8').replace('<script type="module">', '<script>');

/* ---------------------------------------------------------------- helper uji */

const results = [];
function assert(name, cond, detail = '') {
  results.push({ name, ok: Boolean(cond) });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail && !cond ? ` — ${detail}` : ''}`);
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, { timeout = 2000, interval = 20 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (fn()) return true;
    } catch {
      /* belum siap */
    }
    await tick(interval);
  }
  return false;
}

const json = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

function sseResponse(chunks, { delay = 3 } = {}) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        if (delay) await new Promise((r) => setTimeout(r, delay));
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/* --------------------------------------------------------------- data contoh */

const FIXTURES = {
  tools: {
    object: 'list',
    data: [
      {
        type: 'function',
        function: {
          name: 'calculate',
          description: 'Menghitung ekspresi matematika.',
          parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] },
        },
        source: 'builtin',
        server_side: true,
        available: true,
        requires_allowlist: false,
      },
      {
        type: 'function',
        function: {
          name: 'http_fetch',
          description: 'Mengambil URL eksternal.',
          parameters: { type: 'object', properties: { url: { type: 'string' } } },
        },
        source: 'builtin',
        server_side: true,
        available: false,
        requires_allowlist: true,
      },
      {
        type: 'function',
        function: {
          name: 'cuaca_demo.get_weather',
          description: 'Cuaca terkini (mock)',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
        source: 'utcp',
        server_side: true,
        available: true,
        requires_allowlist: true,
        utcp: { manual: 'cuaca_demo', call_template_type: 'http' },
      },
    ],
    count: 3,
    config: {
      http_allowlist_configured: false,
      connectors_configured: false,
      disabled: [],
      max_rounds: 3,
      utcp_configured: true,
      utcp_manuals: { count: 1, tools: 1, errors: [], data: [] },
    },
  },
  models: {
    object: 'list',
    data: [
      { id: 'qwen2.5-0.5b-instruct', name: 'Qwen 2.5 0.5B Instruct', size_mb: 379 },
      { id: 'smollm2-360m-instruct', name: 'SmolLM2 360M Instruct', size_mb: 258 },
    ],
  },
  health: {
    status: 'warm',
    active_model: 'qwen2.5-0.5b-instruct',
    runtime: {
      vercel_region: 'iad1',
      rss_mb: 512,
      node_version: 'v22.0.0',
      cpu_arch: 'x64',
      tmp_disk: { free_mb: 800 },
    },
    stats: { lastTokensPerSecond: 24.5, requestsServed: 7 },
    cached_models: [],
  },
  utcp: {
    ok: true,
    utcp_version: '1.0.0',
    own_tools: 5,
    configured: true,
    manuals: { count: 1, tools: 1, errors: [], data: [] },
  },
};

/** Bangun halaman dengan fetch distub. `chat` bisa diubah di tengah test. */
async function createApp({ mobile = false, chat = {} } = {}) {
  const calls = [];
  const dom = new JSDOM(html, {
    url: 'https://lollm.test/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.matchMedia = (query) => ({
        media: query,
        matches: mobile && query.includes('max-width'),
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent() {
          return false;
        },
      });
      window.visualViewport = undefined;
      window.scrollTo = () => {};

      window.fetch = async (input, init = {}) => {
        const url = typeof input === 'string' ? input : input.url;
        calls.push({ url, method: (init.method || 'GET').toUpperCase(), body: init.body });

        if (url.startsWith('/api/tools')) return json(FIXTURES.tools);
        if (url === '/v1/models') return json(FIXTURES.models);
        if (url === '/api/health') return json(FIXTURES.health);
        if (url === '/api/utcp') return json(FIXTURES.utcp);
        if (url.startsWith('/api/warmup')) {
          return json({ name: 'qwen2.5-0.5b-instruct', cold_load: false, load_ms: 10, health: FIXTURES.health });
        }
        if (url === '/v1/chat/completions') {
          const mode = chat.mode || 'stream';
          if (mode === 'error') return json({ error: { message: 'Model gagal dimuat' } }, 500);
          if (mode === 'hang') {
            const stream = new ReadableStream({
              async start(controller) {
                controller.enqueue(
                  new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Halo"}}]}\n\n')
                );
                init.signal?.addEventListener?.('abort', () => {
                  try {
                    controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                  } catch {
                    /* sudah ditutup */
                  }
                });
              },
            });
            return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
          }
          const chunks = chat.chunks || [
            ': status {"phase":"starting","model":"qwen2.5-0.5b-instruct"}\n\n',
            ': status {"phase":"tool_call","id":"t1","name":"calculate","arguments":{"expression":"19*23+7"}}\n\n',
            ': status {"phase":"tool_result","id":"t1","ok":true,"duration_ms":3,"preview":"444"}\n\n',
            'data: {"choices":[{"delta":{"content":"Hasilnya "}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"**444**."}}],"timings":{"tokens_per_second":21.7}}\n\n',
            'data: {"choices":[{"delta":{}}],"usage":{"completion_tokens":5}}\n\n',
            'data: [DONE]\n\n',
          ];
          return sseResponse(chunks, { delay: chat.delay ?? 3 });
        }
        return json({ ok: true });
      };
    },
  });

  await waitFor(() => dom.window.document.getElementById('toolCount')?.textContent !== 'memuat...', {
    timeout: 4000,
  });
  await tick(60);
  return { window: dom.window, doc: dom.window.document, calls };
}

/* ------------------------------------------------------------------- test UI */

/* 1. Pemuatan awal */
{
  const { doc, calls } = await createApp();

  assert('load: /api/tools dipanggil sekali saat init', calls.filter((c) => c.url.startsWith('/api/tools')).length === 1);
  assert('load: /v1/models dipanggil', calls.some((c) => c.url === '/v1/models'));
  assert('load: /api/health dipanggil', calls.some((c) => c.url === '/api/health'));

  const rows = [...doc.querySelectorAll('#toolList .tool-row')];
  assert('load: 3 baris tool dirender', rows.length === 3, `dapat ${rows.length}`);
  assert(
    'load: badge utcp:http untuk tool UTCP',
    rows.some((r) => r.querySelector('.tool-tag')?.textContent === 'utcp:http')
  );
  assert(
    'load: tool tanpa allowlist ditandai "butuh allowlist"',
    rows.some((r) => r.querySelector('.tool-tag')?.textContent === 'butuh allowlist')
  );
  assert('load: counter tool menunjukkan 2/3 aktif', doc.getElementById('toolCount').textContent === '2/3 aktif');
  assert(
    'load: checkbox tool tak tersedia disabled',
    rows.find((r) => r.classList.contains('unavailable'))?.querySelector('input').disabled === true
  );
  assert('load: domain ditampilkan', doc.getElementById('domainText').textContent === 'lollm.test');
  assert('load: snippet UTCP terisi', doc.getElementById('utcpSnippet').textContent.includes('/.well-known/utcp'));
  assert('load: status server warm', doc.getElementById('serverStatusPill').textContent.includes('Warm'));
  assert('load: metrik RAM terisi', doc.getElementById('ramMetric').textContent === '512 MB');
  assert('load: model card dirender dari /v1/models', doc.querySelectorAll('#modelList .model-card').length === 2);
}

/* 2. Preferensi tool */
{
  const { doc, window } = await createApp();
  const toggle = doc.getElementById('toolsEnabled');

  toggle.checked = false;
  toggle.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert('prefs: toggle off menyimpan enabled=false', JSON.parse(window.localStorage.getItem('lollm.tools.v1')).enabled === false);
  assert('prefs: hint berubah saat tool dimatikan', doc.getElementById('toolsHint').textContent.includes('dimatikan'));
  assert('prefs: checkbox tool ikut disabled', [...doc.querySelectorAll('#toolList input[type=checkbox]')].every((i) => i.disabled));
  assert('prefs: input putaran ikut disabled', doc.getElementById('toolRounds').disabled === true);

  toggle.checked = true;
  toggle.dispatchEvent(new window.Event('change', { bubbles: true }));
  const boxes = [...doc.querySelectorAll('#toolList input[type=checkbox]')];
  assert('prefs: tool tersedia aktif lagi', boxes.filter((i) => !i.disabled).length === 2);
  assert('prefs: tool unavailable tetap disabled', boxes.filter((i) => i.disabled).length === 1);

  const rounds = doc.getElementById('toolRounds');
  rounds.value = '99';
  rounds.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert('prefs: putaran di-clamp ke 4', rounds.value === '4');

  rounds.value = '0';
  rounds.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert('prefs: angka 0 di-clamp ke min=1 (regresi)', rounds.value === '1', rounds.value);

  rounds.value = '';
  rounds.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert('prefs: input kosong kembali ke nilai bawaan 2', rounds.value === '2', rounds.value);

  rounds.value = '-5';
  rounds.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert('prefs: angka negatif di-clamp ke 1', rounds.value === '1', rounds.value);
}

/* 3. Chat streaming + chip tool */
{
  const { doc, window, calls } = await createApp();
  const input = doc.getElementById('promptInput');

  input.value = 'Berapa 19*23+7?';
  doc.getElementById('chatForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  assert('chat: streaming selesai & tombol kirim aktif lagi', await waitFor(() => !doc.getElementById('sendBtn').disabled, { timeout: 4000 }));

  const rows = [...doc.querySelectorAll('.msg-row')];
  assert('chat: 2 baris pesan (user + assistant)', rows.length === 2, `${rows.length} baris`);
  assert('chat: bubble user berisi teks asli', rows[0]?.querySelector('.msg-bubble')?.textContent === 'Berapa 19*23+7?');
  assert('chat: jawaban dirender sebagai markdown', rows[1]?.querySelector('.msg-bubble')?.innerHTML.includes('<strong>444</strong>'));

  const chips = [...doc.querySelectorAll('.tool-chip')];
  assert('chat: satu chip tool muncul', chips.length === 1, `${chips.length} chip`);
  assert('chat: chip tool berstatus ok', chips[0]?.classList.contains('ok'));
  assert('chat: chip menampilkan nama tool', chips[0]?.textContent.includes('calculate'));
  assert('chat: chip menampilkan durasi', chips[0]?.textContent.includes('3ms'));
  assert('chat: meta menyebut tool', rows[1]?.querySelector('.msg-meta')?.textContent.includes('1 tool'));
  assert('chat: input dikosongkan', input.value === '');
  assert('chat: tombol stop kembali tersembunyi', doc.getElementById('stopBtn').classList.contains('hidden'));
  assert('chat: empty state disembunyikan', doc.getElementById('emptyState').classList.contains('hidden'));

  const body = JSON.parse(calls.find((c) => c.url === '/v1/chat/completions').body);
  assert('chat: request menyertakan tools terpilih', Array.isArray(body.tools) && body.tools.length === 2);
  assert(
    'chat: max_tool_rounds mengikuti nilai di UI',
    body.max_tool_rounds === Number(doc.getElementById('toolRounds').value),
    `body=${body.max_tool_rounds}`
  );
  assert('chat: request menyertakan system prompt', body.messages[0].role === 'system');
}

/* 4. Chat error & Stop */
{
  const { doc, window } = await createApp({ chat: { mode: 'error' } });
  doc.getElementById('promptInput').value = 'Halo';
  doc.getElementById('chatForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

  assert('chat error: state pulih', await waitFor(() => !doc.getElementById('sendBtn').disabled, { timeout: 3000 }));
  const bubble = doc.querySelectorAll('.msg-row')[1]?.querySelector('.msg-bubble');
  assert('chat error: pesan error server ditampilkan', bubble?.textContent.includes('Model gagal dimuat'));
  assert(
    'chat error: meta menandai kegagalan',
    doc.querySelectorAll('.msg-row')[1]?.querySelector('.msg-meta')?.textContent.includes('Gagal')
  );
}

{
  const { doc, window } = await createApp({ chat: { mode: 'hang' } });
  doc.getElementById('promptInput').value = 'Halo';
  doc.getElementById('chatForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

  assert(
    'chat stop: tombol stop tampil saat streaming',
    await waitFor(() => !doc.getElementById('stopBtn').classList.contains('hidden'))
  );
  doc.getElementById('stopBtn').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert(
    'chat stop: ditandai "Dihentikan oleh pengguna"',
    await waitFor(
      () => doc.querySelectorAll('.msg-row')[1]?.querySelector('.msg-meta')?.textContent.includes('Dihentikan'),
      { timeout: 3000 }
    )
  );
  assert('chat stop: tombol kirim aktif lagi', doc.getElementById('sendBtn').disabled === false);
}

/* 5. Bersihkan chat */
{
  const { doc, window } = await createApp();
  doc.getElementById('promptInput').value = 'Halo';
  doc.getElementById('chatForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => doc.querySelectorAll('.msg-row').length === 2);

  doc.getElementById('clearChatBtn').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert('clear: semua baris pesan dihapus', doc.querySelectorAll('.msg-row').length === 0);
  assert('clear: empty state tampil lagi', !doc.getElementById('emptyState').classList.contains('hidden'));
}

/* 6. Tab, snippet, salin, tester endpoint */
{
  const { doc, window } = await createApp();

  [...doc.querySelectorAll('.tab-btn')].find((b) => b.dataset.tab === 'api').dispatchEvent(
    new window.Event('click', { bubbles: true })
  );
  assert('tab: tab API aktif', doc.getElementById('tab-api').classList.contains('active'));
  assert('tab: tab chat tidak aktif', !doc.getElementById('tab-chat').classList.contains('active'));

  assert('snippet: curl memakai origin halaman', doc.getElementById('curlSnippet').textContent.includes('https://lollm.test/v1/chat/completions'));
  assert('snippet: python memakai model terpilih', doc.getElementById('pythonSnippet').textContent.includes('qwen2.5-0.5b-instruct'));

  doc.querySelectorAll('#modelList .model-card')[1].dispatchEvent(new window.Event('click', { bubbles: true }));
  assert(
    'model: memilih model memperbarui snippet',
    doc.getElementById('curlSnippet').textContent.includes('smollm2-360m-instruct')
  );

  doc.execCommand = () => true;
  const copyBtn = doc.querySelector('[data-copy-target="utcpSnippet"]');
  copyBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(30);
  assert('copy: label tombol berubah jadi "Tersalin!"', copyBtn.textContent === 'Tersalin!');

  doc.getElementById('testToolsBtn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await waitFor(() => doc.getElementById('liveApiOutput').textContent.includes('HTTP 200'));
  assert('tester: GET /api/tools menampilkan respons', doc.getElementById('liveApiOutput').textContent.includes('HTTP 200'));

  doc.getElementById('testUtcpBtn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await waitFor(() => doc.getElementById('liveApiOutput').textContent.includes('"utcp_version"'));
  assert('tester: GET /api/utcp menampilkan manual', doc.getElementById('liveApiOutput').textContent.includes('"utcp_version"'));
}

/* 7. Drawer mobile */
{
  const { doc, window } = await createApp({ mobile: true });
  const sidebar = doc.getElementById('sidebar');
  const menuBtn = doc.getElementById('mobileMenuBtn');

  menuBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  assert('mobile: drawer terbuka', sidebar.classList.contains('open'));
  assert('mobile: aria-expanded true', menuBtn.getAttribute('aria-expanded') === 'true');
  assert('mobile: body dikunci', doc.body.classList.contains('sidebar-open'));

  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert('mobile: Escape menutup drawer', !sidebar.classList.contains('open'));
  assert('mobile: aria-expanded kembali false', menuBtn.getAttribute('aria-expanded') === 'false');

  menuBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  doc.getElementById('sidebarScrim').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert('mobile: tap backdrop menutup drawer', !sidebar.classList.contains('open'));

  menuBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  doc.getElementById('sidebarCloseBtn').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert('mobile: tombol tutup menutup drawer', !sidebar.classList.contains('open'));
}

/* 8. Keyboard composer */
{
  const { doc, window } = await createApp();
  const input = doc.getElementById('promptInput');
  input.value = 'Halo lewat Enter';
  const evt = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  input.dispatchEvent(evt);
  assert('keyboard: Enter mengirim pesan (desktop)', (await waitFor(() => doc.querySelectorAll('.msg-row').length >= 1)) && evt.defaultPrevented);
}

/* 9. Regresi: label salin & chip domain harus pulih setelah klik ganda */
{
  const { doc, window } = await createApp();
  doc.execCommand = () => true;

  const copyBtn = doc.querySelector('[data-copy-target="utcpSnippet"]');
  copyBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(120);
  copyBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(1700);
  assert('regresi: label tombol salin pulih setelah klik ganda', copyBtn.textContent === 'Salin Kode', copyBtn.textContent);

  const baseBtn = doc.getElementById('copyBaseUrlBtn');
  baseBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(120);
  baseBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(1700);
  assert('regresi: label Base URL pulih setelah klik ganda', baseBtn.textContent === 'Salin', baseBtn.textContent);

  const chip = doc.getElementById('publicDomainChip');
  const domainText = doc.getElementById('domainText');
  chip.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(120);
  chip.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(1700);
  assert('regresi: chip domain pulih setelah klik ganda', domainText.textContent === 'lollm.test', domainText.textContent);
}

/* 10. Regresi: code block tidak boleh diformat inline */
{
  const chunks = [
    'data: {"choices":[{"delta":{"content":"Contoh:\\n```js\\nconst x = **bukan bold**;\\n```\\nSelesai."}}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const { doc, window } = await createApp({ chat: { chunks, delay: 0 } });
  doc.getElementById('promptInput').value = 'tampilkan kode';
  doc.getElementById('chatForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => doc.getElementById('sendBtn').disabled === false);

  const htmlOut = doc.querySelectorAll('.msg-row')[1]?.querySelector('.msg-bubble')?.innerHTML || '';
  assert('regresi: bold di dalam code block tetap literal', htmlOut.includes('<pre><code>const x = **bukan bold**;</code></pre>'), htmlOut);
  assert('regresi: teks di luar code block tetap diformat', htmlOut.includes('<p>Selesai.</p>'));
}

/* 11. "Bersihkan" saat generasi berjalan tidak meninggalkan riwayat yatim */
{
  const chatCfg = { mode: 'hang' };
  const { doc, window, calls } = await createApp({ chat: chatCfg });

  doc.getElementById('promptInput').value = 'Pesan pertama';
  doc.getElementById('chatForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => !doc.getElementById('stopBtn').classList.contains('hidden'));

  doc.getElementById('clearChatBtn').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert('clear saat streaming: baris langsung dibersihkan', doc.querySelectorAll('.msg-row').length === 0);
  assert('clear saat streaming: empty state tampil', !doc.getElementById('emptyState').classList.contains('hidden'));

  doc.getElementById('stopBtn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await waitFor(() => doc.getElementById('sendBtn').disabled === false, { timeout: 2000 });
  await tick(80);

  chatCfg.mode = 'stream';
  doc.getElementById('promptInput').value = 'Pesan kedua';
  doc.getElementById('chatForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => doc.getElementById('sendBtn').disabled === false, { timeout: 3000 });

  const body = JSON.parse(calls.filter((c) => c.url === '/v1/chat/completions').at(-1).body);
  assert(
    'clear saat streaming: tidak ada pesan assistant yatim di request berikutnya',
    body.messages.filter((m) => m.role === 'assistant').length === 0,
    JSON.stringify(body.messages.map((m) => m.role))
  );
}

/* -------------------------------------------------------------------- ringkas */

const failed = results.filter((r) => !r.ok);
console.log(`\n# total ${results.length} · lulus ${results.length - failed.length} · gagal ${failed.length}`);
process.exit(failed.length ? 1 : 0);
