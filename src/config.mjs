import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export const DEFAULT_HOST = "127.0.0.1";
/** Ollama's default port, so existing clients work without reconfiguration. */
export const DEFAULT_PORT = 11434;
export const DEFAULT_KEEP_ALIVE = "5m";
export const DEFAULT_CONTEXT_SIZE = 4096;
export const DEFAULT_PARALLEL = 1;

/**
 * Root data directory. Mirrors Ollama's `~/.ollama` layout (models/manifests +
 * models/blobs), which makes migration and inspection familiar.
 */
export function defaultHome() {
  if (process.env.LOLLM_HOME) return path.resolve(process.env.LOLLM_HOME);
  return path.join(os.homedir(), ".lollm");
}

/** @param {NodeJS.ProcessEnv} [env] */
function envValue(env, key) {
  const value = env[key];
  return value === undefined || value === "" ? undefined : value;
}

/** @param {string | undefined} value */
function toBool(value) {
  if (value === undefined) return undefined;
  return !["0", "false", "no", "off", ""].includes(String(value).toLowerCase());
}

/** @param {string | undefined} value */
function toInt(value) {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Read `$LOLLM_HOME/config.json` if it exists. Errors are swallowed so a
 * corrupt config can never prevent the CLI from starting.
 * @param {string} home
 * @param {{warn?: (msg: string) => void}} [options]
 */
export function readConfigFile(home, options = {}) {
  const file = path.join(home, "config.json");
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (error && /** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") {
      options.warn?.(`ignoring ${file}: ${/** @type {Error} */ (error).message}`);
    }
    return {};
  }
}

/**
 * Resolve the effective server configuration.
 *
 * Precedence: explicit options > environment variables > config.json > defaults.
 *
 * @param {Record<string, unknown>} [overrides]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveConfig(overrides = {}, env = process.env) {
  const home = path.resolve(
    /** @type {string} */ (overrides.home) ?? defaultHome(),
  );
  const file = readConfigFile(home);
  const pick = (optionKey, envKey, fileKey = optionKey) =>
    overrides[optionKey] ?? envValue(env, envKey) ?? file[fileKey];

  const modelsDir = path.resolve(
    String(pick("modelsDir", "LOLLM_MODELS_DIR") ?? path.join(home, "models")),
  );

  const backend =
    String(pick("backend", "LOLLM_BACKEND") ?? "llama").toLowerCase() === "mock"
      ? "mock"
      : "llama";

  const gpuRaw = pick("gpu", "LOLLM_GPU");
  const gpu =
    gpuRaw === undefined
      ? "auto"
      : gpuRaw === false || ["false", "0", "off", "no", "cpu"].includes(String(gpuRaw).toLowerCase())
        ? false
        : String(gpuRaw);

  return {
    home,
    modelsDir,
    host: String(pick("host", "LOLLM_HOST") ?? DEFAULT_HOST),
    port: toInt(String(pick("port", "LOLLM_PORT") ?? DEFAULT_PORT)) ?? DEFAULT_PORT,
    backend,
    /** @type {number} how many generations may run at once */
    parallel: Math.max(1, toInt(String(pick("parallel", "LOLLM_PARALLEL") ?? DEFAULT_PARALLEL)) ?? 1),
    /**
     * Context window in tokens. `null` (the default) means "whatever the model
     * was trained with" — lollm never silently truncates to a smaller window.
     * Set LOLLM_CONTEXT_SIZE / --context-size to cap it.
     * @type {number | null}
     */
    contextSize: (() => {
      const raw = pick("contextSize", "LOLLM_CONTEXT_SIZE");
      if (raw === undefined || raw === null || raw === "" || String(raw).toLowerCase() === "auto") return null;
      const n = toInt(String(raw));
      return n !== undefined && n > 0 ? n : null;
    })(),
    /**
     * Optional default cap on generated tokens. `null` = unlimited: generation
     * runs until the model emits an end token or fills the context window.
     * @type {number | null}
     */
    maxTokens: (() => {
      const n = toInt(String(pick("maxTokens", "LOLLM_MAX_TOKENS") ?? ""));
      return n !== undefined && n > 0 ? n : null;
    })(),
    /** @type {number} how many models may stay resident (1 keeps RAM predictable) */
    maxLoadedModels: Math.max(1, toInt(String(pick("maxLoadedModels", "LOLLM_MAX_LOADED_MODELS") ?? 1)) ?? 1),
    /** @type {string | number | false} "auto" | false | "cuda" | "metal" | "vulkan" */
    gpu,
    /** @type {number | null} null = let llama.cpp decide */
    gpuLayers:
      toInt(String(pick("gpuLayers", "LOLLM_GPU_LAYERS") ?? "")) ?? null,
    /** @type {number} llama.cpp worker threads (0 = auto) */
    threads: toInt(String(pick("threads", "LOLLM_THREADS") ?? "0")) ?? 0,
    /** @type {string} default keep_alive window for loaded models */
    keepAlive: String(pick("keepAlive", "LOLLM_KEEP_ALIVE") ?? DEFAULT_KEEP_ALIVE),
    /** @type {boolean} verbose request logging */
    verbose: toBool(String(pick("verbose", "LOLLM_VERBOSE") ?? "")) ?? false,
    /** @type {string} */
    logLevel: String(
      pick("logLevel", "LOLLM_LOG_LEVEL") ?? (toBool(String(pick("verbose", "LOLLM_VERBOSE") ?? "")) ? "debug" : "info"),
    ),
    /** @type {string | undefined} token used for gated Hugging Face repos */
    hfToken: /** @type {string | undefined} */ (pick("hfToken", "HF_TOKEN", "hfToken")) ?? undefined,
    /** @type {string} */
    ollamaRegistry: String(pick("ollamaRegistry", "LOLLM_OLLAMA_REGISTRY") ?? "https://registry.ollama.ai"),
    /** @type {string} base URL for `hf:` references (mirrors/proxies welcome) */
    hfEndpoint: String(pick("hfEndpoint", "LOLLM_HF_ENDPOINT") ?? "https://huggingface.co").replace(/\/+$/, ""),
    /**
     * Maximum JSON body size in bytes. `0` (the default) means unlimited;
     * set LOLLM_MAX_BODY_BYTES / --max-body-bytes to enforce a cap.
     * @type {number}
     */
    maxBodyBytes: (() => {
      const n = toInt(String(pick("maxBodyBytes", "LOLLM_MAX_BODY_BYTES") ?? ""));
      return n !== undefined && n > 0 ? n : 0;
    })(),
    /** @type {number} unload a model after this many ms of inactivity (0 = immediately after request) */
    idleTimeoutMs: toInt(String(pick("idleTimeoutMs", "LOLLM_IDLE_TIMEOUT_MS") ?? "")) ?? null,
    /** @type {boolean} allow model downloads from non-https URLs */
    allowInsecure: toBool(String(pick("allowInsecure", "LOLLM_ALLOW_INSECURE") ?? "")) ?? false,
    /** @type {boolean} serve the bundled playground at /playground */
    playground: (() => {
      const raw = pick("playground", "LOLLM_PLAYGROUND");
      if (raw === undefined) return true;
      return toBool(String(raw)) ?? true;
    })(),
    /** @type {string} */
    versionFile: path.join(home, "config.json"),
  };
}

/** @typedef {ReturnType<typeof resolveConfig>} Config */
