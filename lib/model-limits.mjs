/**
 * Batas panjang konteks & keluaran model.
 *
 * Dipisah dari `llm-engine.mjs` supaya bisa diuji tanpa memuat `node-llama-cpp`
 * (paket native yang tidak tersedia di lingkungan uji/CI ringan).
 */

/** Konteks default: riwayat percakapan + hasil tool + jawaban panjang. */
export const DEFAULT_CONTEXT_SIZE = 8192;
/** Batas atas konteks agar KV cache tidak menghabiskan RAM function. */
export const MAX_CONTEXT_SIZE = 16384;
/** Model >= 700 MB (mis. 1B) dibatasi konteksnya agar tidak OOM di function. */
export const HEAVY_MODEL_SIZE_MB = 700;
export const HEAVY_MODEL_CONTEXT_SIZE = 4096;

/** Output default: cukup untuk satu file kode utuh, bukan hanya beberapa paragraf. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 3072;
export const MAX_OUTPUT_TOKENS_LIMIT = 8192;

/**
 * Ukuran konteks efektif: nilai terbesar antara kebutuhan katalog, env
 * `LLM_CONTEXT_SIZE`, dan default; dibatasi MAX_CONTEXT_SIZE.
 */
export function getContextSize(spec = null, env = process.env) {
  const requested = Number(env?.LLM_CONTEXT_SIZE) || 0;
  if (requested > 0) {
    return Math.min(MAX_CONTEXT_SIZE, Math.max(1024, Math.round(requested)));
  }
  // Model besar (>=700 MB) memakan RAM function; konteksnya dibatasi lebih ketat
  // agar model + KV cache tetap muat di 1 GB.
  const heavy = Number(spec?.sizeMb) >= HEAVY_MODEL_SIZE_MB;
  const ceiling = heavy ? HEAVY_MODEL_CONTEXT_SIZE : MAX_CONTEXT_SIZE;
  const base = Math.max(Number(spec?.contextLength) || 0, DEFAULT_CONTEXT_SIZE);
  return Math.min(ceiling, Math.max(1024, Math.round(base)));
}

/**
 * Batas token keluaran. Dibatasi juga oleh ukuran konteks supaya prompt +
 * riwayat + hasil tool tetap muat saat model menulis jawaban panjang.
 */
export function getMaxOutputTokens({ env = process.env, contextSize } = {}) {
  const requested = Number(env?.LLM_MAX_OUTPUT_TOKENS) || DEFAULT_MAX_OUTPUT_TOKENS;
  const ctx = Number(contextSize) || DEFAULT_CONTEXT_SIZE;
  // Sisakan minimal 25% konteks (atau 512 token) untuk prompt + riwayat.
  const room = Math.max(256, ctx - Math.max(512, Math.floor(ctx * 0.25)));
  return Math.min(MAX_OUTPUT_TOKENS_LIMIT, room, Math.max(1, Math.round(requested)));
}

/** Perkiraan karakter per token; sengaja konservatif agar tidak overflow. */
export const CHARS_PER_TOKEN = 3;

/** Anggaran karakter untuk seluruh isi prompt (input). */
export function contextCharBudget(contextSize = DEFAULT_CONTEXT_SIZE) {
  return Math.max(2000, Math.round(Number(contextSize) * CHARS_PER_TOKEN));
}

/** Ambil teks dari satu giliran riwayat (dua bentuk: teks atau respons model). */
function turnText(turn) {
  if (!turn) return '';
  if (typeof turn.text === 'string') return turn.text;
  if (Array.isArray(turn.response)) return turn.response.join('');
  return '';
}

/**
 * Pangkas riwayat lama supaya prompt + riwayat + ruang jawaban tetap muat di
 * konteks. Giliran terbaru selalu dipertahankan; entri pertama (system) tetap.
 * @returns {{history: Array, dropped: number, chars: number}}
 */
export function fitHistoryToContext({
  systemPrompt = '',
  history = [],
  userPrompt = '',
  contextSize = DEFAULT_CONTEXT_SIZE,
  reservedTokens = 0,
} = {}) {
  const budget = Math.max(
    0,
    contextCharBudget(contextSize) - Math.max(0, Math.round(Number(reservedTokens) || 0)) * CHARS_PER_TOKEN
  );
  const base = String(systemPrompt).length + String(userPrompt).length;

  const head = history.length > 0 && history[0]?.type === 'system' ? [history[0]] : [];
  const rest = history.slice(head.length);

  let used = base + head.reduce((sum, turn) => sum + turnText(turn).length, 0);
  const kept = [];
  for (let i = rest.length - 1; i >= 0; i -= 1) {
    const size = turnText(rest[i]).length;
    if (kept.length > 0 && used + size > budget) break;
    kept.unshift(rest[i]);
    used += size;
  }

  return {
    history: [...head, ...kept],
    dropped: rest.length - kept.length,
    chars: used,
  };
}
