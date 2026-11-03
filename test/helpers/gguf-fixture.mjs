import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * Builds a syntactically valid (but weightless) GGUF file for tests.
 * Only the header is written: metadata + tensor descriptors. lollm never
 * reads tensor data, and the mock backend never loads the file, so this is
 * enough to exercise the whole store/API stack offline.
 */

const TYPE = { UINT8: 0, INT8: 1, UINT16: 2, INT16: 3, UINT32: 4, INT32: 5, FLOAT32: 6, BOOL: 7, STRING: 8, ARRAY: 9, UINT64: 10, INT64: 11, FLOAT64: 12 };

/**
 * @param {unknown} value
 * @param {number} stringLengthBytes
 * @returns {{type: number, buffer: Buffer}}
 */
function encodeValue(value, stringLengthBytes) {
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.alloc(stringLengthBytes);
    if (stringLengthBytes === 8) length.writeBigUInt64LE(BigInt(bytes.length));
    else length.writeUInt32LE(bytes.length, 0);
    return { type: TYPE.STRING, buffer: Buffer.concat([length, bytes]) };
  }
  if (typeof value === "boolean") {
    return { type: TYPE.BOOL, buffer: Buffer.from([value ? 1 : 0]) };
  }
  if (typeof value === "bigint") {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(value);
    return { type: TYPE.UINT64, buffer };
  }
  if (typeof value === "number") {
    if (Number.isInteger(value) && value >= 0 && value <= 0xffffffff) {
      const buffer = Buffer.alloc(4);
      buffer.writeUInt32LE(value);
      return { type: TYPE.UINT32, buffer };
    }
    if (Number.isInteger(value)) {
      const buffer = Buffer.alloc(4);
      buffer.writeInt32LE(value);
      return { type: TYPE.INT32, buffer };
    }
    const buffer = Buffer.alloc(4);
    buffer.writeFloatLE(value);
    return { type: TYPE.FLOAT32, buffer };
  }
  if (Array.isArray(value)) {
    const encoded = value.map((item) => encodeValue(item, stringLengthBytes));
    const itemType = encoded[0]?.type ?? TYPE.STRING;
    const count = Buffer.alloc(stringLengthBytes);
    if (stringLengthBytes === 8) count.writeBigUInt64LE(BigInt(value.length));
    else count.writeUInt32LE(value.length, 0);
    // The outer value type is written by `encodeKeyValue`; an array value only
    // carries its item type followed by the element count.
    const itemTypeBuffer = Buffer.alloc(4);
    itemTypeBuffer.writeUInt32LE(itemType, 0);
    return {
      type: TYPE.ARRAY,
      buffer: Buffer.concat([itemTypeBuffer, count, ...encoded.map((item) => item.buffer)]),
    };
  }
  throw new Error(`unsupported fixture metadata value: ${String(value)}`);
}

/**
 * @param {string} key
 * @param {unknown} value
 * @param {number} stringLengthBytes
 */
function encodeKeyValue(key, value, stringLengthBytes) {
  const keyBytes = Buffer.from(key, "utf8");
  const keyLength = Buffer.alloc(stringLengthBytes);
  if (stringLengthBytes === 8) keyLength.writeBigUInt64LE(BigInt(keyBytes.length));
  else keyLength.writeUInt32LE(keyBytes.length, 0);
  const encoded = encodeValue(value, stringLengthBytes);
  const type = Buffer.alloc(4);
  type.writeUInt32LE(encoded.type);
  return Buffer.concat([keyLength, keyBytes, type, encoded.buffer]);
}

/**
 * @param {{version?: number, metadata?: Record<string, unknown>, tensors?: {name: string, dims: number[], type?: number, offset?: number}[], metadataOrder?: string[]}} [options]
 */
export function buildGgufBuffer(options = {}) {
  const version = options.version ?? 3;
  const metadata = options.metadata ?? {};
  const tensors = options.tensors ?? [];
  const stringLengthBytes = version === 1 ? 4 : 8;

  const header = Buffer.alloc(24);
  header.writeUInt32LE(0x46554747, 0); // "GGUF"
  header.writeUInt32LE(version, 4);
  header.writeBigUInt64LE(BigInt(tensors.length), 8);
  header.writeBigUInt64LE(BigInt(Object.keys(metadata).length), 16);

  const parts = [header];
  for (const [key, value] of Object.entries(metadata)) {
    parts.push(encodeKeyValue(key, value, stringLengthBytes));
  }
  for (const tensor of tensors) {
    const nameBytes = Buffer.from(tensor.name, "utf8");
    const nameLength = Buffer.alloc(stringLengthBytes);
    if (stringLengthBytes === 8) nameLength.writeBigUInt64LE(BigInt(nameBytes.length));
    else nameLength.writeUInt32LE(nameBytes.length, 0);
    const dimsHeader = Buffer.alloc(4);
    dimsHeader.writeUInt32LE(tensor.dims.length);
    const dims = tensor.dims.map((dim) => {
      const buffer = Buffer.alloc(8);
      buffer.writeBigUInt64LE(BigInt(dim));
      return buffer;
    });
    const type = Buffer.alloc(4);
    type.writeUInt32LE(tensor.type ?? 1, 0); // F16 by default
    const offset = Buffer.alloc(8);
    offset.writeBigUInt64LE(BigInt(tensor.offset ?? 0));
    parts.push(Buffer.concat([nameLength, nameBytes, dimsHeader, ...dims, type, offset]));
  }
  return Buffer.concat(parts);
}

/** Default metadata for a tiny Qwen-like model. */
export function fixtureMetadata(overrides = {}) {
  return {
    "general.architecture": "qwen2",
    "general.name": "Tiny Test Model",
    "general.file_type": 15, // Q4_K_M
    "general.parameter_count": 494_000_000,
    "general.quantization_version": 2,
    "tokenizer.ggml.model": "gpt2",
    "tokenizer.ggml.tokens": Array.from({ length: 128 }, (_, index) => `tok${index}`),
    "tokenizer.chat_template":
      "{{- if .System }}<|im_start|>system\n{{ .System }}<|im_end|>\n{{ end -}}<|im_start|>user\n{{ .Prompt }}<|im_end|>\n<|im_start|>assistant\n",
    "qwen2.context_length": 32768,
    "qwen2.embedding_length": 896,
    "qwen2.block_count": 24,
    "qwen2.attention.head_count": 14,
    "qwen2.rope.freq_base": 1_000_000.0,
    ...overrides,
  };
}

/**
 * Write a fixture GGUF to disk.
 * @param {string} filePath
 * @param {{metadata?: Record<string, unknown>, tensors?: {name: string, dims: number[], type?: number}[], version?: number}} [options]
 */
export async function writeGgufFixture(filePath, options = {}) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const buffer = buildGgufBuffer({
    version: options.version,
    metadata: options.metadata ?? fixtureMetadata(),
    tensors: options.tensors ?? [
      { name: "token_embd.weight", dims: [896, 151_936], type: 1 },
      { name: "output.weight", dims: [896, 151_936], type: 1 },
    ],
  });
  await fs.writeFile(filePath, buffer);
  return filePath;
}

/**
 * Create an isolated temp directory for a test file.
 * @param {string} [prefix]
 */
export async function tempDir(prefix = "lollm-test-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}
