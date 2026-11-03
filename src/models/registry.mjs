import path from "node:path";
import os from "node:os";
import { badRequest } from "../errors.mjs";

/**
 * Model naming follows Ollama: `[namespace/]name[:tag]`, lowercase, `:latest`
 * implied. Keeping the same grammar means existing Ollama UIs can list and run
 * lollm models without translating anything.
 */

export const DEFAULT_TAG = "latest";
export const DEFAULT_NAMESPACE = "library";
export const OLLAMA_REGISTRY_HOST = "registry.ollama.ai";
export const LOCAL_REGISTRY_HOST = "lollm.local";
export const LOCAL_NAMESPACE = "library";

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const TAG_RE = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/;

/**
 * @typedef {Object} ModelName
 * @property {string} namespace
 * @property {string} name
 * @property {string} tag
 * @property {string} display e.g. `qwen2.5:0.5b`
 * @property {string} full e.g. `library/qwen2.5:0.5b`
 */

/**
 * @param {string} input
 * @returns {ModelName}
 */
export function parseModelName(input) {
  if (typeof input !== "string" || input.trim() === "") {
    throw badRequest("model name is required", "invalid_model_name");
  }
  let value = input.trim();
  if (value.length > 300) throw badRequest("model name is too long", "invalid_model_name");

  let namespace = DEFAULT_NAMESPACE;
  const slash = value.indexOf("/");
  if (slash !== -1) {
    namespace = value.slice(0, slash).toLowerCase();
    value = value.slice(slash + 1);
    if (!NAME_RE.test(namespace)) {
      throw badRequest(`invalid model namespace "${namespace}"`, "invalid_model_name");
    }
  }

  let tag = DEFAULT_TAG;
  const colon = value.lastIndexOf(":");
  if (colon !== -1) {
    tag = value.slice(colon + 1);
    value = value.slice(0, colon);
    if (!TAG_RE.test(tag)) {
      throw badRequest(`invalid model tag "${tag}"`, "invalid_model_name");
    }
  }

  const name = value.toLowerCase();
  if (!NAME_RE.test(name)) {
    throw badRequest(
      `invalid model name "${input}" (use lowercase letters, digits, dot, dash or underscore)`,
      "invalid_model_name",
    );
  }

  const display = namespace === DEFAULT_NAMESPACE ? `${name}:${tag}` : `${namespace}/${name}:${tag}`;
  return { namespace, name, tag, display, full: `${namespace}/${name}:${tag}` };
}

/**
 * Try to parse a name without throwing. Useful when deciding whether an
 * argument is a model reference or a file path.
 * @param {string} input
 * @returns {ModelName | null}
 */
export function tryParseModelName(input) {
  try {
    return parseModelName(input);
  } catch {
    return null;
  }
}

/**
 * @typedef {Object} Reference
 * @property {"ollama" | "hf" | "http" | "file"} provider
 * @property {string} input
 * @property {ModelName} [modelName]  explicit Ollama-style name
 * @property {string} [url]
 * @property {string} [repo]  Hugging Face repo, e.g. `Qwen/Qwen2.5-0.5B-Instruct-GGUF`
 * @property {string} [file]  file inside the Hugging Face repo
 * @property {string} [filePath] local path
 * @property {string} [suggestedName] derived name for non-ollama refs
 */

/**
 * Parse a pull reference.
 *
 * Supported forms:
 *  - `llama3.2` / `qwen2.5:0.5b`            → Ollama registry
 *  - `ollama:gemma3:4b`                     → Ollama registry (explicit)
 *  - `hf:org/repo:model-q4_k_m.gguf`        → Hugging Face
 *  - `https://host/model.gguf`              → direct download
 *  - `./models/model.gguf` / `/abs/x.gguf`  → local import
 *
 * @param {string} input
 * @returns {Reference}
 */
export function parseReference(input) {
  if (typeof input !== "string" || input.trim() === "") {
    throw badRequest("model reference is required", "invalid_reference");
  }
  const raw = input.trim();

  if (/^hf:/i.test(raw)) {
    const rest = raw.slice(3);
    const colon = rest.lastIndexOf(":");
    let repo = rest;
    let file = "";
    if (colon !== -1) {
      repo = rest.slice(0, colon);
      file = rest.slice(colon + 1);
    }
    if (!repo || !file) {
      throw badRequest(
        'Hugging Face references need a repo and a file, e.g. "hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:qwen2.5-0.5b-instruct-q4_k_m.gguf"',
        "invalid_reference",
      );
    }
    if (!/\.gguf$/i.test(file)) {
      throw badRequest(`Hugging Face file must be a .gguf file, got "${file}"`, "invalid_reference");
    }
    return {
      provider: "hf",
      input: raw,
      repo,
      file,
      suggestedName: nameFromFile(file),
    };
  }

  if (/^https?:\/\//i.test(raw)) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw badRequest(`invalid URL "${raw}"`, "invalid_reference");
    }
    return {
      provider: "http",
      input: raw,
      url: url.toString(),
      suggestedName: nameFromFile(decodeURIComponent(path.posix.basename(url.pathname))),
    };
  }

  if (/^file:\/\//i.test(raw)) {
    let filePath;
    try {
      filePath = new URL(raw).pathname;
    } catch {
      throw badRequest(`invalid file URL "${raw}"`, "invalid_reference");
    }
    return {
      provider: "file",
      input: raw,
      filePath: decodeURIComponent(filePath),
      suggestedName: nameFromFile(path.basename(filePath)),
    };
  }

  if (/^ollama:/i.test(raw)) {
    return { provider: "ollama", input: raw, modelName: parseModelName(raw.slice(7)) };
  }

  const looksLikePath =
    /\.gguf$/i.test(raw) ||
    raw.startsWith("./") ||
    raw.startsWith("../") ||
    raw.startsWith("~/") ||
    path.isAbsolute(raw);

  if (looksLikePath) {
    const filePath = raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw;
    return {
      provider: "file",
      input: raw,
      filePath: path.resolve(filePath),
      suggestedName: nameFromFile(path.basename(filePath)),
    };
  }

  return { provider: "ollama", input: raw, modelName: parseModelName(raw) };
}

/**
 * Derive a valid Ollama-ish model name from a GGUF file name.
 * e.g. `Qwen2.5-0.5B-Instruct-Q4_K_M.gguf` → `qwen2.5-0.5b-instruct-q4_k_m`
 * @param {string} fileName
 */
export function nameFromFile(fileName) {
  const base = fileName.replace(/\.gguf$/i, "").trim();
  const cleaned = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 120);
  return cleaned === "" ? "model" : cleaned;
}

/** @param {{namespace: string, name: string, tag: string}} modelName */
export const manifestKey = (modelName) => `${modelName.namespace}/${modelName.name}/${modelName.tag}`;

/**
 * @param {string} base
 * @param {ModelName} modelName
 */
export const ollamaManifestUrl = (base, modelName) =>
  `${base.replace(/\/+$/, "")}/v2/${modelName.namespace}/${modelName.name}/manifests/${modelName.tag}`;

/**
 * @param {string} base
 * @param {ModelName} modelName
 * @param {string} digest e.g. `sha256:abcd…`
 */
export const ollamaBlobUrl = (base, modelName, digest) =>
  `${base.replace(/\/+$/, "")}/v2/${modelName.namespace}/${modelName.name}/blobs/${digest}`;

/**
 * @param {string} repo
 * @param {string} file
 * @param {string} [revision]
 */
export const huggingFaceUrl = (repo, file, revision = "main", endpoint = "https://huggingface.co") =>
  `${String(endpoint).replace(/\/+$/, "")}/${repo}/resolve/${revision}/${file}?download=true`;
