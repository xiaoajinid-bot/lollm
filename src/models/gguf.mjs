import fs from "node:fs/promises";
import { BufferedReader, FileByteSource } from "./byte-source.mjs";

/**
 * A small, dependency-free GGUF reader.
 *
 * It only walks the header (metadata + tensor descriptors) and never touches
 * tensor data, so it is instant even for 30 GB files — and, more importantly,
 * it can run over any random-access byte source: a local file, or an HTTP
 * object read with Range requests (see `remote.mjs`).
 */

const GGUF_MAGIC = 0x46554747; // "GGUF" little-endian

const VALUE_TYPES = {
  UINT8: 0,
  INT8: 1,
  UINT16: 2,
  INT16: 3,
  UINT32: 4,
  INT32: 5,
  FLOAT32: 6,
  BOOL: 7,
  STRING: 8,
  ARRAY: 9,
  UINT64: 10,
  INT64: 11,
  FLOAT64: 12,
};

/** Tensor element types (ggml_type). */
export const TENSOR_TYPES = {
  0: "F32",
  1: "F16",
  2: "Q4_0",
  3: "Q4_1",
  6: "Q5_0",
  7: "Q5_1",
  8: "Q8_0",
  9: "Q8_1",
  10: "Q2_K",
  11: "Q3_K",
  12: "Q4_K",
  13: "Q5_K",
  14: "Q6_K",
  15: "Q8_K",
  16: "IQ2_XXS",
  17: "IQ2_XS",
  18: "IQ3_XXS",
  19: "IQ1_S",
  20: "IQ4_NL",
  21: "IQ3_S",
  22: "IQ2_S",
  23: "IQ4_XS",
  24: "I8",
  25: "I16",
  26: "I32",
  27: "I64",
  28: "F64",
  29: "IQ1_M",
  30: "BF16",
  31: "Q4_0_4_4",
  32: "Q4_0_4_8",
  33: "Q4_0_8_8",
  34: "TQ1_0",
  35: "TQ2_0",
  36: "IQ4_NL_4_4",
};

/**
 * `general.file_type` → human readable quantization, matching the names Ollama
 * and `llama.cpp` print in `details.quantization_level`.
 */
export const FILE_TYPES = {
  0: "F32",
  1: "F16",
  2: "Q4_0",
  3: "Q4_1",
  7: "Q8_0",
  8: "Q5_0",
  9: "Q5_1",
  10: "Q2_K",
  11: "Q3_K_S",
  12: "Q3_K_M",
  13: "Q3_K_L",
  14: "Q4_K_S",
  15: "Q4_K_M",
  16: "Q5_K_S",
  17: "Q5_K_M",
  18: "Q6_K",
  19: "IQ2_XXS",
  20: "IQ2_XS",
  21: "Q2_K_S",
  22: "IQ3_XS",
  23: "IQ3_XXS",
  24: "IQ1_S",
  25: "IQ4_NL",
  26: "IQ3_S",
  27: "IQ3_M",
  28: "IQ2_S",
  29: "IQ2_M",
  30: "IQ4_XS",
  31: "IQ1_M",
  32: "BF16",
  33: "Q4_0_4_4",
  34: "Q4_0_4_8",
  35: "Q4_0_8_8",
  36: "TQ1_0",
  37: "TQ2_0",
  38: "MXFP4",
};

export class GgufError extends Error {
  constructor(message) {
    super(message);
    this.name = "GgufError";
  }
}

/**
 * Read metadata and tensor shapes from a local GGUF file.
 *
 * @param {string} filePath
 * @param {{readTensors?: boolean, maxMetadataKeys?: number, includeTensorList?: boolean}} [options]
 * @returns {Promise<GgufInfo>}
 */
export async function readGgufInfo(filePath, options = {}) {
  let source;
  try {
    source = await FileByteSource.open(filePath);
  } catch (error) {
    const err = /** @type {NodeJS.ErrnoException} */ (error);
    if (err.code === "ENOENT") throw new GgufError(`model file not found: ${filePath}`);
    throw new GgufError(`cannot open model file ${filePath}: ${err.message}`);
  }
  try {
    return await readGgufInfoFromSource(source, { ...options, label: filePath });
  } finally {
    await source.close();
  }
}

/**
 * Read a GGUF header from any random-access byte source. Only the bytes needed
 * for the header are requested — a local `pread` or a couple of HTTP Range
 * requests, never the whole model.
 *
 * @param {import("./byte-source.mjs").ByteSource} source
 * @param {{readTensors?: boolean, maxMetadataKeys?: number, includeTensorList?: boolean, label?: string, chunkSize?: number, maxBuffer?: number}} [options]
 * @returns {Promise<GgufInfo>}
 */
export async function readGgufInfoFromSource(source, options = {}) {
  const readTensors = options.readTensors ?? true;
  const includeTensorList = options.includeTensorList ?? true;
  const maxMetadataKeys = options.maxMetadataKeys ?? 100_000;
  const label = options.label ?? source.label ?? "<source>";
  // Match the read window to the source's block size so remote parsing pulls
  // the smallest useful range instead of a fixed 256 KB.
  const reader = new BufferedReader(source, {
    chunkSize: options.chunkSize,
    maxBuffer: options.maxBuffer,
  });

  /** @type {number} */
  let magic;
  let version = 0;
  let tensorCount = 0;
  let metadataCount = 0;
  /** @type {Record<string, any>} */
  const metadata = {};
  /** @type {GgufTensorInfo[]} */
  const tensors = [];
  /** @type {Record<string, number>} */
  const tensorTypes = {};
  let parameterCount = 0;
  let dataStart = 0;

  try {
    magic = await reader.u32();
    if (magic !== GGUF_MAGIC) {
      throw new GgufError(
        `${label} is not a GGUF file (magic 0x${magic.toString(16)}), only *.gguf models are supported`,
      );
    }
    version = await reader.u32();
    if (version < 1 || version > 3) {
      throw new GgufError(`unsupported GGUF version ${version} (supported: 1-3)`);
    }
    const lenSize = version === 1 ? 4 : 8;

    /** @param {BufferedReader} r */
    const readLength = async (r) => {
      const big = lenSize === 8 ? await r.u64() : BigInt(await r.u32());
      const n = Number(big);
      if (!Number.isSafeInteger(n) || n < 0) throw new GgufError("invalid length in GGUF header");
      return n;
    };

    /** @param {BufferedReader} r */
    const readKey = async (r) => {
      const len = await readLength(r);
      return r.string(len, 1024 * 1024);
    };

    /**
     * @param {BufferedReader} r
     * @param {number} type
     * @param {boolean} wantValue
     * @returns {Promise<any>}
     */
    const readValue = async (r, type, wantValue) => {
      switch (type) {
        case VALUE_TYPES.UINT8: {
          const v = await r.u8();
          return wantValue ? v : undefined;
        }
        case VALUE_TYPES.INT8: {
          const v = await r.i8();
          return wantValue ? v : undefined;
        }
        case VALUE_TYPES.UINT16: {
          const v = await r.u16();
          return wantValue ? v : undefined;
        }
        case VALUE_TYPES.INT16: {
          const v = await r.i16();
          return wantValue ? v : undefined;
        }
        case VALUE_TYPES.UINT32: {
          const v = await r.u32();
          return wantValue ? v : undefined;
        }
        case VALUE_TYPES.INT32: {
          const v = await r.i32();
          return wantValue ? v : undefined;
        }
        case VALUE_TYPES.FLOAT32: {
          const v = await r.f32();
          return wantValue ? v : undefined;
        }
        case VALUE_TYPES.BOOL: {
          const v = await r.u8();
          return wantValue ? v !== 0 : undefined;
        }
        case VALUE_TYPES.STRING: {
          const len = await readLength(r);
          const v = await r.string(len, wantValue ? 8 * 1024 * 1024 : 0);
          return wantValue ? v : undefined;
        }
        case VALUE_TYPES.ARRAY: {
          const itemType = await r.u32();
          const countBig = version === 1 ? BigInt(await r.u32()) : await r.u64();
          const count = Number(countBig);
          if (!Number.isSafeInteger(count) || count < 0) {
            throw new GgufError("invalid array length in GGUF metadata");
          }
          const keep = wantValue && count <= 1024;
          /** @type {unknown[]} */
          const items = [];
          for (let i = 0; i < count; i += 1) {
            const item = await readValue(r, itemType, keep);
            if (keep) items.push(item);
          }
          return keep ? items : undefined;
        }
        case VALUE_TYPES.UINT64: {
          const v = await r.u64();
          return wantValue ? Number(v) : undefined;
        }
        case VALUE_TYPES.INT64: {
          const v = await r.i64();
          return wantValue ? Number(v) : undefined;
        }
        case VALUE_TYPES.FLOAT64: {
          const v = await r.f64();
          return wantValue ? v : undefined;
        }
        default:
          throw new GgufError(`unknown GGUF metadata value type ${type}`);
      }
    };

    tensorCount = Number(await reader.u64());
    metadataCount = Number(await reader.u64());
    if (metadataCount > maxMetadataKeys) {
      throw new GgufError(`refusing to parse ${metadataCount} metadata keys`);
    }

    for (let i = 0; i < metadataCount; i += 1) {
      const key = await readKey(reader);
      const type = await reader.u32();
      // Tokenizer arrays (tokens, scores, merges, token_types) are tens of
      // megabytes; scalars such as `tokenizer.ggml.model` and the chat template
      // are small and useful, so only arrays are skipped.
      const skipValue = type === VALUE_TYPES.ARRAY && key.startsWith("tokenizer.ggml.");
      const value = await readValue(reader, type, !skipValue);
      if (value !== undefined) metadata[key] = value;
    }

    /** @type {Array<{name: string, dims: number[], type: number, offset: number}>} */
    const rawTensors = [];
    if (readTensors) {
      for (let i = 0; i < tensorCount; i += 1) {
        const nameLength = await readLength(reader);
        const name = await reader.string(nameLength, 65536);
        const nDims = await reader.u32();
        /** @type {number[]} */
        const dims = [];
        let elements = 1;
        for (let d = 0; d < nDims; d += 1) {
          const dim = Number(await reader.u64());
          dims.push(dim);
          elements *= dim;
        }
        const type = await reader.u32();
        const offset = Number(await reader.u64());
        if (Number.isFinite(elements)) parameterCount += elements;
        const typeName = TENSOR_TYPES[type] ?? `TYPE_${type}`;
        tensorTypes[typeName] = (tensorTypes[typeName] ?? 0) + 1;
        rawTensors.push({ name, dims, type, offset });
        if (includeTensorList) tensors.push({ name, dims, type, typeName, offset, absOffset: 0, elements });
      }
      const alignment = typeof metadata["general.alignment"] === "number"
        ? /** @type {number} */ (metadata["general.alignment"])
        : 32;
      dataStart = align(reader.pos, alignment);
      for (const tensor of tensors) tensor.absOffset = dataStart + tensor.offset;
    }

    const architecture = typeof metadata["general.architecture"] === "string"
      ? /** @type {string} */ (metadata["general.architecture"])
      : "unknown";
    const fileType = typeof metadata["general.file_type"] === "number"
      ? /** @type {number} */ (metadata["general.file_type"])
      : undefined;
    const declaredParams = typeof metadata["general.parameter_count"] === "number"
      ? /** @type {number} */ (metadata["general.parameter_count"])
      : undefined;
    const dim = (suffix) => {
      const value = metadata[`${architecture}.${suffix}`];
      return typeof value === "number" ? value : undefined;
    };

    return {
      source: label,
      version,
      tensorCount,
      metadataCount,
      metadata,
      tensorTypes,
      tensors,
      dataStart,
      headerBytesRead: Math.min(reader.pos, source.size),
      sizeBytes: source.size,
      architecture,
      name: typeof metadata["general.name"] === "string" ? /** @type {string} */ (metadata["general.name"]) : undefined,
      contextLength: dim("context_length"),
      embeddingLength: dim("embedding_length"),
      blockCount: dim("block_count"),
      headCount: dim("attention.head_count"),
      chatTemplate: typeof metadata["tokenizer.chat_template"] === "string"
        ? /** @type {string} */ (metadata["tokenizer.chat_template"])
        : undefined,
      tokenizerModel: typeof metadata["tokenizer.ggml.model"] === "string"
        ? /** @type {string} */ (metadata["tokenizer.ggml.model"])
        : undefined,
      quantization: fileType !== undefined ? FILE_TYPES[fileType] : mostCommonQuant(tensorTypes),
      parameterCount: declaredParams ?? parameterCount,
      families: [architecture],
    };
  } catch (error) {
    if (error instanceof GgufError) throw error;
    if (error instanceof RangeError) throw new GgufError(error.message);
    throw error;
  }
}

/**
 * @param {number} value
 * @param {number} alignment
 */
function align(value, alignment) {
  const step = alignment > 0 ? alignment : 32;
  return Math.ceil(value / step) * step;
}

/** @param {Record<string, number>} tensorTypes */
function mostCommonQuant(tensorTypes) {
  let best;
  let bestCount = -1;
  for (const [name, count] of Object.entries(tensorTypes)) {
    if (count > bestCount && !name.startsWith("F32")) {
      best = name;
      bestCount = count;
    }
  }
  return best ?? "unknown";
}

/**
 * Very cheap check used before spawning a load: reads only the magic bytes.
 * @param {string} filePath
 */
export async function isGgufFile(filePath) {
  let handle;
  try {
    handle = await fs.open(filePath, "r");
    const buf = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buf, 0, 4, 0);
    return bytesRead === 4 && buf.readUInt32LE(0) === GGUF_MAGIC;
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

/**
 * @typedef {Object} GgufTensorInfo
 * @property {string} name
 * @property {number[]} dims
 * @property {number} type
 * @property {string} typeName
 * @property {number} offset offset within the tensor data section
 * @property {number} absOffset absolute offset within the file
 * @property {number} elements
 */

/**
 * @typedef {Object} GgufInfo
 * @property {string} source
 * @property {number} version
 * @property {number} tensorCount
 * @property {number} metadataCount
 * @property {Record<string, any>} metadata
 * @property {Record<string, number>} tensorTypes
 * @property {GgufTensorInfo[]} tensors
 * @property {number} dataStart
 * @property {number} headerBytesRead
 * @property {number} sizeBytes
 * @property {string} architecture
 * @property {string | undefined} name
 * @property {number | undefined} contextLength
 * @property {number | undefined} embeddingLength
 * @property {number | undefined} blockCount
 * @property {number | undefined} headCount
 * @property {string | undefined} chatTemplate
 * @property {string | undefined} tokenizerModel
 * @property {string} quantization
 * @property {number} parameterCount
 * @property {string[]} families
 */
