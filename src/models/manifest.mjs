/**
 * Ollama-compatible manifest helpers.
 *
 * A manifest lists content-addressed layers, exactly like an OCI manifest. The
 * GGUF weights are one layer; template/system/license/parameters are small
 * sibling layers. This is why lollm can serve models pulled with
 * `ollama pull` and why `lollm pull` output looks familiar.
 */

export const MEDIA_TYPES = {
  model: "application/vnd.ollama.image.model",
  template: "application/vnd.ollama.image.template",
  system: "application/vnd.ollama.image.system",
  license: "application/vnd.ollama.image.license",
  params: "application/vnd.ollama.image.params",
  adapter: "application/vnd.ollama.image.adapter",
  projector: "application/vnd.ollama.image.projector",
  config: "application/vnd.docker.container.image.v1+json",
};

export const MANIFEST_MEDIA_TYPE = "application/vnd.docker.distribution.manifest.v2+json";

/**
 * @param {{layers: ManifestLayer[], config?: ManifestLayer, extra?: Record<string, unknown>}} input
 * @returns {Manifest}
 */
export function buildManifest({ layers, config, extra = {} }) {
  return {
    schemaVersion: 2,
    mediaType: MANIFEST_MEDIA_TYPE,
    config: config ?? { mediaType: MEDIA_TYPES.config, digest: "", size: 0 },
    layers,
    ...extra,
  };
}

/**
 * @param {Manifest} manifest
 * @param {string} mediaType
 * @returns {ManifestLayer | undefined}
 */
export const findLayer = (manifest, mediaType) =>
  (manifest.layers ?? []).find((layer) => layer.mediaType === mediaType);

/**
 * @param {Manifest} manifest
 * @returns {ManifestLayer | undefined}
 */
export const findModelLayer = (manifest) =>
  findLayer(manifest, MEDIA_TYPES.model) ??
  (manifest.layers ?? []).find((layer) => String(layer.mediaType ?? "").includes("image.model"));

/**
 * Layer sizes that count towards the model size reported by `/api/tags`.
 * Ollama reports the model layer only, so we do the same.
 * @param {Manifest} manifest
 */
export function modelSize(manifest) {
  const layer = findModelLayer(manifest);
  if (layer?.size) return layer.size;
  return (manifest.layers ?? []).reduce((sum, item) => sum + (Number(item.size) || 0), 0);
}

/**
 * @typedef {Object} ManifestLayer
 * @property {string} mediaType
 * @property {string} digest
 * @property {number} size
 * @property {Record<string, unknown>} [annotations]
 */

/**
 * @typedef {Object} Manifest
 * @property {number} schemaVersion
 * @property {string} mediaType
 * @property {ManifestLayer} config
 * @property {ManifestLayer[]} layers
 * @property {Record<string, unknown>} [lollm]
 */
