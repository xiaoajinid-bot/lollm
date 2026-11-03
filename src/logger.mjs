const LEVELS = /** @type {const} */ ({
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
});

const COLORS = /** @type {Record<string, string>} */ ({
  error: "\u001b[31m",
  warn: "\u001b[33m",
  info: "\u001b[36m",
  debug: "\u001b[90m",
  trace: "\u001b[90m",
});

const RESET = "\u001b[0m";

/** @typedef {"error" | "warn" | "info" | "debug" | "trace" | "silent"} LogLevel */

/**
 * Tiny zero-dependency logger. Pretty for TTYs, plain JSON-less lines otherwise.
 * @param {{level?: LogLevel, name?: string, stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream}} [options]
 */
export function createLogger(options = {}) {
  const level = options.level ?? "info";
  const scope = options.name ?? "lollm";
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const colorize = Boolean(stdout.isTTY) && !process.env.NO_COLOR;
  const threshold = LEVELS[level] ?? LEVELS.info;

  /** @param {keyof typeof LEVELS} lvl */
  const shouldLog = (lvl) => LEVELS[lvl] <= threshold;

  /** @param {keyof typeof LEVELS} lvl @param {unknown[]} args */
  function emit(lvl, args) {
    if (!shouldLog(lvl)) return;
    const stream = lvl === "error" || lvl === "warn" ? stderr : stdout;
    const stamp = new Date().toISOString();
    const tag = lvl.toUpperCase().padEnd(5);
    const prefix = colorize
      ? `${COLORS[lvl] ?? ""}${tag}${RESET} ${stamp} [${scope}]`
      : `${tag} ${stamp} [${scope}]`;
    stream.write(`${prefix} ${args.map(formatArg).join(" ")}\n`);
  }

  return {
    level,
    /** @param {...unknown} args */
    error: (...args) => emit("error", args),
    /** @param {...unknown} args */
    warn: (...args) => emit("warn", args),
    /** @param {...unknown} args */
    info: (...args) => emit("info", args),
    /** @param {...unknown} args */
    debug: (...args) => emit("debug", args),
    /** @param {...unknown} args */
    trace: (...args) => emit("trace", args),
    /** @param {LogLevel} next */
    setLevel(next) {
      return createLogger({ ...options, level: next });
    },
    /** @param {string} childName */
    child(childName) {
      return createLogger({ ...options, name: `${scope}:${childName}` });
    },
  };
}

/** @param {unknown} value */
function formatArg(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** @typedef {ReturnType<typeof createLogger>} Logger */

export const silentLogger = createLogger({
  level: "silent",
  stdout: { write() {} },
  stderr: { write() {} },
});
