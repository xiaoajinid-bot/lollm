/**
 * Small formatting/parsing helpers shared by the CLI, API and store.
 */

/**
 * Parse an Ollama-style duration ("5m", "1h30m", "30s", "500ms") or a number.
 * Returns milliseconds. `-1` / "forever" / "infinity" means "never unload".
 *
 * @param {string | number | null | undefined} value
 * @param {number} fallback
 * @returns {number} milliseconds, or `Infinity` for forever
 */
export function parseDuration(value, fallback = 5 * 60_000) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return fallback;
    if (value < 0) return Infinity;
    // Ollama treats a bare number as seconds.
    return value === 0 ? 0 : value * 1000;
  }
  const text = String(value).trim().toLowerCase();
  if (text === "-1" || text === "forever" || text === "infinity") return Infinity;
  if (/^\d+(\.\d+)?$/.test(text)) {
    const n = Number(text);
    return n === 0 ? 0 : n * 1000;
  }
  const re = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/g;
  let total = 0;
  let matched = false;
  for (const match of text.matchAll(re)) {
    matched = true;
    const n = Number(match[1]);
    const unit = match[2];
    total +=
      unit === "ms"
        ? n
        : unit === "s"
          ? n * 1000
          : unit === "m"
            ? n * 60_000
            : unit === "h"
              ? n * 3_600_000
              : n * 86_400_000;
  }
  return matched ? total : fallback;
}

/** @param {number} ms */
export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "forever";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return rest ? `${minutes}m${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

/** @param {number} bytes */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 || value >= 1000 ? Math.round(value) : value.toFixed(1);
  return `${rounded} ${units[unit]}`;
}

/**
 * Render a parameter count the way Ollama does (`7.6B`, `494M`).
 * @param {number} count
 */
export function formatParameters(count) {
  if (!Number.isFinite(count) || count <= 0) return "unknown";
  if (count >= 1e12) return `${trimZero(count / 1e12)}T`;
  if (count >= 1e9) return `${trimZero(count / 1e9)}B`;
  if (count >= 1e6) return `${trimZero(count / 1e6)}M`;
  if (count >= 1e3) return `${trimZero(count / 1e3)}K`;
  return String(count);
}

/** @param {number} value */
function trimZero(value) {
  const fixed = value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
  return fixed.replace(/\.?0+$/, "");
}

/** Milliseconds → nanoseconds, as reported by the Ollama API. */
export const toNanos = (ms) => Math.round(Number(ms || 0) * 1e6);

/** RFC3339 timestamp with milliseconds, e.g. `2026-11-03T04:41:00.123Z`. */
export const nowIso = () => new Date().toISOString();

/** Monotonic-ish high resolution timer in milliseconds. */
export const now = () => Number(process.hrtime.bigint() / 1000n) / 1000;

/** Truncate long strings for logs. */
export function preview(text, max = 120) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
