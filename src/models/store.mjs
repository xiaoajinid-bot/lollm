import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { createReadStream, createWriteStream } from "node:fs";

import { HttpError, badRequest, conflict, notFound, upstream } from "../errors.mjs";
import { silentLogger } from "../logger.mjs";
import { formatParameters, nowIso } from "../util/format.mjs";
import { readGgufInfo, isGgufFile, GgufError } from "./gguf.mjs";
import {
  MANIFEST_MEDIA_TYPE,
  MEDIA_TYPES,
  buildManifest,
  findLayer,
  findModelLayer,
  modelSize,
} from "./manifest.mjs";
import {
  DEFAULT_NAMESPACE,
  LOCAL_NAMESPACE,
  LOCAL_REGISTRY_HOST,
  OLLAMA_REGISTRY_HOST,
  huggingFaceUrl,
  ollamaBlobUrl,
  ollamaManifestUrl,
  parseModelName,
  parseReference,
} from "./registry.mjs";
import { buildModelfileText, parseParametersText } from "./modelfile.mjs";
import {
  cleanupResumable,
  downloadResumable,
  fetchJson,
  hashFile,
} from "./download.mjs";
import { inspectRemoteModel } from "./remote.mjs";

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

/** Stable short id used for resumable staging files. */
const shortHash = (value) => createHash("sha256").update(String(value)).digest("hex").slice(0, 16);

/**
 * Content-addressed model store, modelled on Ollama's on-disk layout:
 *
 *   ~/.lollm/models/blobs/sha256-<hex>
 *   ~/.lollm/models/manifests/<host>/<namespace>/<model>/<tag>
 *
 * Blobs are shared between models, so `lollm cp` and Modelfile variants cost
 * nothing on disk.
 */
export class ModelStore {
  /**
   * @param {Object} options
   * @param {string} options.modelsDir
   * @param {import("../logger.mjs").Logger} [options.logger]
   * @param {typeof fetch} [options.fetchImpl]
   * @param {string} [options.registry]
   * @param {string} [options.hfToken]
   * @param {boolean} [options.allowInsecure]
   * @param {string} [options.hfEndpoint]
   */
  constructor(options) {
    if (!options?.modelsDir) throw new TypeError("ModelStore requires a modelsDir");
    this.dir = path.resolve(options.modelsDir);
    this.blobsDir = path.join(this.dir, "blobs");
    this.manifestsDir = path.join(this.dir, "manifests");
    this.tmpDir = path.join(this.dir, "tmp");
    this.logger = options.logger ?? silentLogger.child("store");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.registry = options.registry ?? "https://registry.ollama.ai";
    this.hfToken = options.hfToken;
    this.hfEndpoint = options.hfEndpoint ?? "https://huggingface.co";
    this.allowInsecure = options.allowInsecure ?? false;
    /** @type {Map<string, {size: number, mtimeMs: number, info: any}>} */
    this.ggufCache = new Map();
  }

  async init() {
    await Promise.all([
      fs.mkdir(this.blobsDir, { recursive: true }),
      fs.mkdir(this.manifestsDir, { recursive: true }),
      fs.mkdir(this.tmpDir, { recursive: true }),
    ]);
    return this;
  }

  /**
   * @param {string} digest `sha256:<hex>`
   */
  blobPath(digest) {
    const value = String(digest);
    if (!DIGEST_RE.test(value)) {
      throw badRequest(`invalid layer digest "${value}"`, "invalid_digest");
    }
    return path.join(this.blobsDir, value.replace(":", "-"));
  }

  /**
   * @param {{host: string, namespace: string, name: string, tag: string}} ref
   */
  manifestPath({ host, namespace, name, tag }) {
    for (const part of [host, namespace, name, tag]) {
      if (!part || part.includes("/") || part.includes("\\") || part === "." || part === "..") {
        throw badRequest(`invalid manifest path component "${part}"`, "invalid_model_name");
      }
    }
    return path.join(this.manifestsDir, host, namespace, name, tag);
  }

  // ---------------------------------------------------------------------------
  // Blobs
  // ---------------------------------------------------------------------------

  /**
   * @param {Buffer} buffer
   */
  async addBlobFromBuffer(buffer) {
    const digest = createHash("sha256").update(buffer).digest("hex");
    const dest = this.blobPath(`sha256:${digest}`);
    if (!fsSync.existsSync(dest)) {
      const tmp = this.#tmpFile();
      await fs.writeFile(tmp, buffer);
      await this.#commitBlob(tmp, dest);
    }
    return { digest: `sha256:${digest}`, size: buffer.length };
  }

  /**
   * @param {string} text
   */
  async addBlobFromText(text) {
    return this.addBlobFromBuffer(Buffer.from(String(text), "utf8"));
  }

  /**
   * @param {string} sourcePath
   */
  async addBlobFromFile(sourcePath) {
    const tmp = this.#tmpFile();
    const hash = createHash("sha256");
    let size = 0;
    await pipeline(
      createReadStream(sourcePath),
      async function* (source) {
        for await (const chunk of source) {
          hash.update(chunk);
          size += chunk.length;
          yield chunk;
        }
      },
      createWriteStream(tmp),
    );
    const digest = hash.digest("hex");
    const dest = this.blobPath(`sha256:${digest}`);
    await this.#commitBlob(tmp, dest);
    return { digest: `sha256:${digest}`, size };
  }

  /**
   * Hash a file we own and adopt it as a blob by *moving* it, instead of copying
   * it through the staging area. Pulls need this: a 258 MB model would otherwise
   * need 516 MB of temporary space (staging copy + blob copy), which is more than
   * a serverless instance has.
   *
   * @param {string} sourcePath
   */
  async adoptBlobFromFile(sourcePath) {
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of createReadStream(sourcePath)) {
      hash.update(chunk);
      size += chunk.length;
    }
    const digest = hash.digest("hex");
    const dest = this.blobPath(`sha256:${digest}`);
    await this.#commitBlob(sourcePath, dest);
    return { digest: `sha256:${digest}`, size };
  }

  /** @param {string} tmp @param {string} dest */
  async #commitBlob(tmp, dest) {
    try {
      const existing = await fs.stat(dest);
      const incoming = await fs.stat(tmp);
      if (existing.size === incoming.size) {
        await fs.rm(tmp, { force: true });
        return;
      }
    } catch {
      // dest does not exist yet
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    try {
      await fs.rename(tmp, dest);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "EXDEV") {
        await fs.copyFile(tmp, dest);
        await fs.rm(tmp, { force: true });
      } else {
        await fs.rm(tmp, { force: true });
        throw error;
      }
    }
  }

  #tmpFile() {
    return path.join(this.tmpDir, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}.part`);
  }

  // ---------------------------------------------------------------------------
  // Manifests
  // ---------------------------------------------------------------------------

  /**
   * @param {{host?: string, namespace?: string, name: string, tag: string}} ref
   * @param {any} manifest
   */
  async writeManifest(ref, manifest) {
    const target = this.manifestPath({
      host: ref.host ?? LOCAL_REGISTRY_HOST,
      namespace: ref.namespace ?? LOCAL_NAMESPACE,
      name: ref.name,
      tag: ref.tag,
    });
    await fs.mkdir(path.dirname(target), { recursive: true });
    const json = `${JSON.stringify(manifest, null, 2)}\n`;
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, json);
    await fs.rename(tmp, target);
    return {
      manifestPath: target,
      digest: `sha256:${createHash("sha256").update(json).digest("hex")}`,
      size: Buffer.byteLength(json),
    };
  }

  /** @param {string} manifestPath */
  async readManifest(manifestPath) {
    try {
      const raw = await fs.readFile(manifestPath, "utf8");
      const manifest = JSON.parse(raw);
      if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.layers)) {
        throw new Error("manifest is missing a layers array");
      }
      return manifest;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
        throw notFound(`manifest not found: ${manifestPath}`, "model_not_found");
      }
      throw new HttpError(500, `cannot read manifest ${manifestPath}: ${/** @type {Error} */ (error).message}`, {
        code: "corrupt_manifest",
      });
    }
  }

  /** @param {string} manifestPath */
  async #manifestDigest(manifestPath) {
    const raw = await fs.readFile(manifestPath);
    return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  }

  /** @param {string} dir */
  async #walk(dir) {
    /** @type {string[]} */
    const files = [];
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return files;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) files.push(...(await this.#walk(full)));
      else if (entry.isFile()) files.push(full);
    }
    return files;
  }

  /**
   * All manifests, cheaply (no manifest reads).
   * @returns {Promise<Array<{host: string, namespace: string, name: string, tag: string, display: string, manifestPath: string, modifiedAt: string}>>}
   */
  async listEntries() {
    const files = await this.#walk(this.manifestsDir);
    /** @type {any[]} */
    const entries = [];
    for (const file of files) {
      if (file.endsWith(".tmp")) continue;
      const rel = path.relative(this.manifestsDir, file).split(path.sep);
      if (rel.length !== 4) continue;
      const [host, namespace, name, tag] = rel;
      const stat = await fs.stat(file).catch(() => null);
      if (!stat?.isFile()) continue;
      const display = namespace === DEFAULT_NAMESPACE ? `${name}:${tag}` : `${namespace}/${name}:${tag}`;
      entries.push({
        host,
        namespace,
        name,
        tag,
        display,
        full: `${namespace}/${name}:${tag}`,
        manifestPath: file,
        modifiedAt: stat.mtime.toISOString(),
      });
    }
    entries.sort((a, b) => a.display.localeCompare(b.display));
    return entries;
  }

  /**
   * @param {string} name
   */
  async find(name) {
    const target = parseModelName(name);
    const entries = await this.listEntries();
    return (
      entries.find((entry) => entry.display === target.display) ??
      entries.find((entry) => entry.name === target.name && entry.tag === target.tag) ??
      null
    );
  }

  /**
   * Cached GGUF header read for a blob.
   * @param {string} blobPath
   */
  async ggufInfo(blobPath) {
    const stat = await fs.stat(blobPath).catch(() => null);
    if (!stat) throw notFound(`model blob missing: ${blobPath}`, "blob_missing");
    const cached = this.ggufCache.get(blobPath);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.info;
    let info;
    try {
      info = await readGgufInfo(blobPath);
    } catch (error) {
      if (error instanceof GgufError) {
        info = {
          filePath: blobPath,
          sizeBytes: stat.size,
          metadata: {},
          tensorTypes: {},
          tensorCount: 0,
          metadataCount: 0,
          version: 0,
          architecture: "unknown",
          quantization: "unknown",
          parameterCount: 0,
          families: ["unknown"],
        };
      } else {
        throw error;
      }
    }
    this.ggufCache.set(blobPath, { size: stat.size, mtimeMs: stat.mtimeMs, info });
    return info;
  }

  /**
   * @param {any} manifest
   * @param {string} mediaType
   */
  async #layerText(manifest, mediaType) {
    const layer = findLayer(manifest, mediaType);
    if (!layer) return null;
    try {
      return await fs.readFile(this.blobPath(layer.digest), "utf8");
    } catch {
      return null;
    }
  }

  /**
   * @param {string} name
   * @returns {Promise<ResolvedModel>}
   */
  async resolve(name) {
    const entry = await this.find(name);
    if (!entry) {
      throw notFound(`model "${name}" not found — try: lollm pull ${name}`, "model_not_found");
    }
    const manifest = await this.readManifest(entry.manifestPath);
    const modelLayer = findModelLayer(manifest);
    if (!modelLayer) {
      throw notFound(`model "${entry.display}" has no GGUF layer`, "model_not_found");
    }
    const modelPath = this.blobPath(modelLayer.digest);
    if (!fsSync.existsSync(modelPath)) {
      throw conflict(`model "${entry.display}" is incomplete (blob ${modelLayer.digest} missing), re-pull it`, "blob_missing");
    }
    const info = await this.ggufInfo(modelPath);
    const template = await this.#layerText(manifest, MEDIA_TYPES.template);
    const system = await this.#layerText(manifest, MEDIA_TYPES.system);
    const license = await this.#layerText(manifest, MEDIA_TYPES.license);
    const parametersText = await this.#layerText(manifest, MEDIA_TYPES.params);
    const parameters = parseParametersText(parametersText ?? "");
    const family = info.architecture && info.architecture !== "unknown" ? info.architecture : "unknown";
    const capabilities = ["completion"];
    if (family.includes("bert") || info.metadata?.["general.type"] === "embedding") capabilities.push("embedding");
    capabilities.push("tools");

    return {
      name: entry.display,
      entry,
      manifest,
      manifestPath: entry.manifestPath,
      digest: await this.#manifestDigest(entry.manifestPath),
      modifiedAt: entry.modifiedAt,
      size: modelSize(manifest),
      modelLayer,
      modelPath,
      gguf: info,
      template,
      system,
      license,
      parameters,
      parametersText: parametersText ?? "",
      details: {
        parent_model: "",
        format: "gguf",
        family,
        families: info.families?.length ? info.families : [family],
        parameter_size: formatParameters(info.parameterCount ?? 0),
        quantization_level: info.quantization ?? "unknown",
      },
      capabilities,
    };
  }

  /**
   * Summary objects for `/api/tags` and `lollm list`.
   */
  async list() {
    const entries = await this.listEntries();
    /** @type {any[]} */
    const out = [];
    for (const entry of entries) {
      try {
        const resolved = await this.resolve(entry.display);
        out.push({
          name: resolved.name,
          model: resolved.name,
          modified_at: resolved.modifiedAt,
          size: resolved.size,
          digest: resolved.digest,
          details: resolved.details,
        });
      } catch (error) {
        this.logger.warn(`skipping ${entry.display}: ${/** @type {Error} */ (error).message}`);
      }
    }
    return out;
  }

  /**
   * @param {string} name
   */
  async show(name) {
    const resolved = await this.resolve(name);
    return {
      license: resolved.license ?? "",
      modelfile: buildModelfileText({
        from: resolved.modelPath,
        system: resolved.system,
        template: resolved.template,
        license: resolved.license,
        parameters: resolved.parameters,
      }),
      parameters: resolved.parametersText,
      template: resolved.template ?? "",
      system: resolved.system ?? "",
      details: resolved.details,
      model_info: modelInfoFor(resolved.gguf),
      capabilities: resolved.capabilities,
      modified_at: resolved.modifiedAt,
    };
  }

  /**
   * @param {string} name
   */
  async remove(name) {
    const entry = await this.find(name);
    if (!entry) throw notFound(`model "${name}" not found`, "model_not_found");
    await fs.rm(entry.manifestPath, { force: true });
    // Prune empty namespace/model directories, never the manifests root.
    let dir = path.dirname(entry.manifestPath);
    while (dir.startsWith(this.manifestsDir) && dir !== this.manifestsDir) {
      const remaining = await fs.readdir(dir).catch(() => []);
      if (remaining.length > 0) break;
      await fs.rmdir(dir).catch(() => {});
      dir = path.dirname(dir);
    }
    return { status: "success", model: entry.display };
  }

  /**
   * @param {string} source
   * @param {string} destination
   */
  async copy(source, destination) {
    const resolved = await this.resolve(source);
    const target = parseModelName(destination);
    const existing = await this.find(target.display);
    if (existing) throw conflict(`model "${target.display}" already exists`, "model_exists");
    await this.writeManifest(target, {
      ...resolved.manifest,
      lollm: { ...(resolved.manifest.lollm ?? {}), copiedFrom: resolved.name, updatedAt: nowIso() },
    });
    return { status: "success" };
  }

  /**
   * Create a model from a Modelfile-like description.
   *
   * @param {{model: string, from?: string | null, system?: string | null, template?: string | null,
   *          license?: string | null, parameters?: Record<string, unknown>, dryRun?: boolean}} input
   */
  async create(input) {
    const target = parseModelName(input.model);
    if (!input.from) throw badRequest("FROM is required to create a model", "missing_from");

    /** @type {any[]} */
    const layers = [];
    let inherited = null;
    let source = String(input.from);

    const existing = await this.find(input.from).catch(() => null);
    if (existing) {
      inherited = await this.resolve(existing.display);
      const modelLayer = findModelLayer(inherited.manifest);
      if (!modelLayer) throw badRequest(`"${existing.display}" has no GGUF layer`, "invalid_source");
      layers.push(modelLayer);
      source = existing.display;
    } else {
      const ref = parseReference(input.from);
      if (ref.provider !== "file") {
        throw badRequest(
          `FROM "${input.from}" is not installed — run: lollm pull ${input.from}`,
          "missing_from",
        );
      }
      const filePath = ref.filePath;
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat?.isFile()) throw badRequest(`FROM file not found: ${filePath}`, "missing_from");
      if (!(await isGgufFile(filePath))) {
        throw badRequest(`${filePath} is not a GGUF file`, "invalid_gguf");
      }
      const blob = await this.addBlobFromFile(filePath);
      layers.push({ mediaType: MEDIA_TYPES.model, digest: blob.digest, size: blob.size });
    }

    const system = input.system ?? inherited?.system ?? null;
    const template = input.template ?? inherited?.template ?? null;
    const license = input.license ?? inherited?.license ?? null;
    const parameters = { ...(inherited?.parameters ?? {}), ...(input.parameters ?? {}) };

    if (system) layers.push(await this.#textLayer(MEDIA_TYPES.system, system));
    if (template) layers.push(await this.#textLayer(MEDIA_TYPES.template, template));
    if (license) layers.push(await this.#textLayer(MEDIA_TYPES.license, license));
    const paramsText = Object.keys(parameters).length > 0 ? formatParams(parameters) : null;
    if (paramsText) layers.push(await this.#textLayer(MEDIA_TYPES.params, paramsText));

    const config = await this.#configLayer(layers[0]);
    const manifest = buildManifest({
      layers,
      config,
      extra: {
        lollm: {
          createdAt: nowIso(),
          source,
          parameters,
        },
      },
    });

    if (input.dryRun) {
      return { status: "success", model: target.display, manifest, dryRun: true };
    }

    await this.writeManifest(target, manifest);
    return { status: "success", model: target.display };
  }

  /**
   * Ollama stores a small JSON config layer next to the weights. We generate
   * an equivalent so the manifests are valid OCI-ish documents and other tools
   * can read basic model facts without opening the GGUF.
   *
   * @param {{digest: string, size: number}} modelLayer
   */
  async #configLayer(modelLayer) {
    let info = null;
    try {
      info = await this.ggufInfo(this.blobPath(modelLayer.digest));
    } catch {
      // A config layer is nice-to-have; never fail an import over it.
    }
    const family = info?.architecture ?? "unknown";
    const config = {
      model_format: "gguf",
      model_family: family,
      model_families: info?.families ?? [family],
      model_type: 1,
      file_type: info?.quantization ?? "unknown",
      architecture: process.arch,
      os: process.platform,
      rootfs: { type: "layers", diff_ids: [modelLayer.digest] },
      lollm: {
        parameter_count: info?.parameterCount ?? 0,
        tensor_count: info?.tensorCount ?? 0,
        context_length: info?.contextLength ?? null,
      },
    };
    const blob = await this.addBlobFromText(JSON.stringify(config, null, 2));
    return { mediaType: MEDIA_TYPES.config, digest: blob.digest, size: blob.size };
  }

  /**
   * @param {string} mediaType
   * @param {string} text
   */
  async #textLayer(mediaType, text) {
    const blob = await this.addBlobFromText(text);
    return { mediaType, digest: blob.digest, size: blob.size };
  }

  // ---------------------------------------------------------------------------
  // Ingestion
  // ---------------------------------------------------------------------------

  /**
   * @param {string} input
   * @param {{name?: string, onProgress?: (event: any) => void, signal?: AbortSignal}} [options]
   */
  async pull(input, options = {}) {
    const ref = parseReference(input);
    const onProgress = options.onProgress ?? (() => {});
    if (ref.provider === "file") {
      return this.importFile(/** @type {string} */ (ref.filePath), {
        name: options.name ?? ref.suggestedName,
        onProgress,
        signal: options.signal,
      });
    }
    if (ref.provider === "http" || ref.provider === "hf") {
      return this.#pullFile(ref, options);
    }
    return this.#pullFromOllamaRegistry(ref, options);
  }

  /**
   * Import a local GGUF file without copying it around more than necessary.
   * @param {string} filePath
   * @param {{name?: string, onProgress?: (event: any) => void, signal?: AbortSignal}} [options]
   */
  async importFile(filePath, options = {}) {
    const onProgress = options.onProgress ?? (() => {});
    const abs = path.resolve(filePath);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat?.isFile()) throw badRequest(`file not found: ${abs}`, "file_not_found");
    if (!(await isGgufFile(abs))) throw badRequest(`${abs} is not a GGUF file`, "invalid_gguf");

    const display = options.name ?? path.basename(abs).replace(/\.gguf$/i, "");
    const target = parseModelName(display);
    onProgress({ status: "importing model", total: stat.size, completed: 0 });
    const blob = await this.addBlobFromFile(abs);
    onProgress({ status: "verifying sha256 digest", total: blob.size, completed: blob.size });
    const modelLayer = { mediaType: MEDIA_TYPES.model, digest: blob.digest, size: blob.size };
    const manifest = buildManifest({
      layers: [modelLayer],
      config: await this.#configLayer(modelLayer),
      extra: { lollm: { createdAt: nowIso(), source: `file:${abs}` } },
    });
    onProgress({ status: "writing manifest" });
    await this.writeManifest(target, manifest);
    onProgress({ status: "success" });
    return { status: "success", model: target.display, digest: blob.digest, size: blob.size };
  }

  /**
   * @param {import("./registry.mjs").Reference} ref
   * @param {{name?: string, onProgress?: (event: any) => void, signal?: AbortSignal}} options
   */
  async #pullFile(ref, options) {
    const onProgress = options.onProgress ?? (() => {});
    const url = ref.url ?? huggingFaceUrl(String(ref.repo), String(ref.file), "main", this.hfEndpoint);
    if (!this.allowInsecure && url.startsWith("http://")) {
      throw badRequest("insecure http:// downloads are disabled (set LOLLM_ALLOW_INSECURE=1)", "insecure_url");
    }
    const display = options.name ?? ref.suggestedName;
    if (!display) throw badRequest("could not derive a model name, pass --name", "invalid_model_name");
    const target = parseModelName(display);

    /** @type {Record<string, string>} */
    const headers = {};
    if (ref.provider === "hf" && this.hfToken) headers.Authorization = `Bearer ${this.hfToken}`;

    onProgress({ status: "pulling manifest" });

    // Read only the GGUF header over HTTP Range: this validates the URL, rejects
    // HTML/safetensors payloads, and tells us the real size before a single
    // weight byte is transferred.
    const probe = await this.#probeRemote(url, headers, options.signal);
    if (probe && probe.info.architecture === "unknown" && probe.info.tensorCount === 0) {
      throw badRequest(`${url} does not look like a complete GGUF file`, "invalid_gguf");
    }

    // Deterministic staging path: an interrupted pull resumes where it stopped.
    const staging = path.join(this.tmpDir, `pull-${shortHash(url)}`);
    const result = await downloadResumable({
      url,
      dest: staging,
      headers,
      signal: options.signal,
      fetchImpl: this.fetchImpl,
      expectedSize: probe?.size,
      onProgress: ({ completed, total, resumedFrom }) =>
        onProgress({
          status: "downloading",
          total: total || probe?.size || 0,
          completed,
          ...(resumedFrom > 0 ? { resumed_from: resumedFrom } : {}),
        }),
    });

    if (!(await isGgufFile(result.path))) {
      await cleanupResumable(staging);
      throw badRequest(
        `${url} did not return a GGUF file — make sure the URL points to a .gguf (not an HTML page or a safetensors repo)`,
        "invalid_gguf",
      );
    }
    onProgress({ status: "verifying sha256 digest", total: result.size, completed: result.size });
    // The staging file is ours: adopt it in place so the pull never holds two
    // copies of the weights on disk.
    const blob = await this.adoptBlobFromFile(result.path);
    await cleanupResumable(staging);

    const modelLayer = { mediaType: MEDIA_TYPES.model, digest: blob.digest, size: blob.size };
    const manifest = buildManifest({
      layers: [modelLayer],
      config: await this.#configLayer(modelLayer),
      extra: { lollm: { createdAt: nowIso(), source: url } },
    });
    onProgress({ status: "writing manifest" });
    await this.writeManifest(target, manifest);
    onProgress({ status: "success" });
    return { status: "success", model: target.display, digest: blob.digest, size: blob.size };
  }

  /**
   * Best-effort GGUF header probe over HTTP Range. Returns `null` when the host
   * does not support Range requests (we then fall back to a plain download).
   *
   * @param {string} url
   * @param {Record<string, string>} headers
   * @param {AbortSignal} [signal]
   */
  async #probeRemote(url, headers, signal) {
    try {
      const probe = await inspectRemoteModel(url, {
        fetchImpl: this.fetchImpl,
        headers,
        signal,
      });
      this.logger.debug(
        `remote probe: ${probe.info.architecture} ${probe.info.quantization}, ` +
          `${probe.stats.bytesFetched} bytes in ${probe.stats.requests} request(s)`,
      );
      return probe;
    } catch (error) {
      if (error instanceof HttpError && error.code === "range_not_supported") {
        this.logger.debug(`${url} does not support Range requests; falling back to a full download`);
        return null;
      }
      if (error instanceof GgufError) {
        throw badRequest(`${url} is not a valid GGUF file: ${error.message}`, "invalid_gguf");
      }
      throw error;
    }
  }

  /**
   * @param {import("./registry.mjs").Reference} ref
   * @param {{name?: string, onProgress?: (event: any) => void, signal?: AbortSignal}} options
   */
  async #pullFromOllamaRegistry(ref, options) {
    const onProgress = options.onProgress ?? (() => {});
    const modelName = ref.modelName ?? parseModelName(options.name ?? "");
    const display = options.name ? parseModelName(options.name) : modelName;
    const manifestUrl = ollamaManifestUrl(this.registry, modelName);

    onProgress({ status: "pulling manifest" });
    const remote = await fetchJson(manifestUrl, {
      fetchImpl: this.fetchImpl,
      signal: options.signal,
      headers: { Accept: MANIFEST_MEDIA_TYPE },
    });
    if (!Array.isArray(remote.layers)) {
      throw upstream(`registry returned an invalid manifest for ${display.display}`);
    }

    /** @type {any[]} */
    const layers = [];
    for (const layer of remote.layers) {
      const mediaType = String(layer.mediaType ?? "");
      if (mediaType === MEDIA_TYPES.adapter) {
        this.logger.warn(`skipping LoRA adapter layer ${layer.digest} (not supported yet)`);
        continue;
      }
      const digest = String(layer.digest ?? "");
      if (!DIGEST_RE.test(digest)) {
        throw upstream(`registry returned an invalid digest "${digest}"`);
      }
      const expectedSize = Number(layer.size) || 0;
      const dest = this.blobPath(digest);
      const stat = await fs.stat(dest).catch(() => null);
      if (stat && (!expectedSize || stat.size === expectedSize)) {
        onProgress({ status: "already exists", digest, total: stat.size, completed: stat.size });
        layers.push({ ...layer, digest, size: stat.size });
        continue;
      }
      const short = digest.slice(7, 19);
      onProgress({ status: `pulling ${short}`, digest, total: expectedSize, completed: 0 });
      const staging = path.join(this.tmpDir, `blob-${digest.slice(7)}`);
      const result = await downloadResumable({
        url: ollamaBlobUrl(this.registry, modelName, digest),
        dest: staging,
        signal: options.signal,
        fetchImpl: this.fetchImpl,
        expectedSize,
        onProgress: ({ completed, total }) =>
          onProgress({ status: `pulling ${short}`, digest, total: total || expectedSize, completed }),
      });
      onProgress({ status: "verifying sha256 digest", digest, total: result.size, completed: result.size });
      const actual = await hashFile(result.path);
      if (`sha256:${actual.digest}` !== digest) {
        await cleanupResumable(staging);
        throw upstream(`digest mismatch for ${digest}: got sha256:${actual.digest}`);
      }
      await this.#commitBlob(result.path, dest);
      await cleanupResumable(staging);
      layers.push({ ...layer, digest, size: actual.size });
    }

    const manifest = {
      ...remote,
      layers,
      lollm: { createdAt: nowIso(), source: manifestUrl, registry: this.registry },
    };
    onProgress({ status: "writing manifest" });
    await this.writeManifest(display, manifest);
    onProgress({ status: "success" });
    return { status: "success", model: display.display };
  }
}

/** @param {Record<string, unknown>} parameters */
function formatParams(parameters) {
  /** @type {string[]} */
  const lines = [];
  for (const [key, value] of Object.entries(parameters)) {
    if (value === undefined || value === null) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      const text = String(item);
      lines.push(`${key} ${text.includes(" ") ? JSON.stringify(text) : text}`);
    }
  }
  return lines.join("\n");
}

/**
 * `model_info` as returned by `/api/show`: GGUF metadata with scalar values,
 * small arrays kept, giant tokenizer arrays dropped.
 * @param {any} info
 */
function modelInfoFor(info) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(info.metadata ?? {})) {
    if (Array.isArray(value) && value.length > 64) continue;
    if (typeof value === "bigint") out[key] = Number(value);
    else out[key] = value;
  }
  out["general.architecture"] = info.architecture;
  if (info.parameterCount) out["general.parameter_count"] = info.parameterCount;
  if (info.quantization) out["general.quantization"] = info.quantization;
  return out;
}

/**
 * @typedef {Object} ResolvedModel
 * @property {string} name
 * @property {any} entry
 * @property {any} manifest
 * @property {string} manifestPath
 * @property {string} digest
 * @property {string} modifiedAt
 * @property {number} size
 * @property {any} modelLayer
 * @property {string} modelPath
 * @property {any} gguf
 * @property {string | null} template
 * @property {string | null} system
 * @property {string | null} license
 * @property {Record<string, string | string[]>} parameters
 * @property {string} parametersText
 * @property {{parent_model: string, format: string, family: string, families: string[], parameter_size: string, quantization_level: string}} details
 * @property {string[]} capabilities
 */
