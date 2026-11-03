import fsp from "node:fs/promises";

/**
 * Byte sources are the seam that lets the GGUF parser run over a local file
 * *or* a remote HTTP object fetched with Range requests.
 *
 * @typedef {Object} ByteSource
 * @property {number} size total number of bytes
 * @property {string} label human readable source (path or URL)
 * @property {(offset: number, length: number) => Promise<Buffer>} read
 * @property {() => Promise<void>} [close]
 */

/**
 * Buffered sequential reader on top of a random-access byte source.
 *
 * The GGUF header is read in small steps (a key, a length, a value), so pulling
 * a fresh request for every field would be wasteful over HTTP. This buffers a
 * window and only asks the source when the window runs out — which is also what
 * makes header parsing cost a couple of Range requests instead of hundreds.
 */
export class BufferedReader {
  /**
   * @param {ByteSource} source
   * @param {{chunkSize?: number, maxBuffer?: number}} [options]
   */
  constructor(source, options = {}) {
    this.source = source;
    this.chunkSize = options.chunkSize ?? 256 * 1024;
    this.maxBuffer = options.maxBuffer ?? 8 * 1024 * 1024;
    this.bufStart = 0;
    /** @type {Buffer} */
    this.buf = Buffer.alloc(0);
    this.pos = 0;
  }

  get size() {
    return this.source.size;
  }

  /** @param {number} n */
  async ensure(n) {
    if (this.pos + n > this.source.size) {
      throw new RangeError("unexpected end of GGUF file while reading header");
    }
    const available = this.bufStart + this.buf.length - this.pos;
    if (available >= n) return;
    const want = Math.min(Math.max(n, this.chunkSize), this.maxBuffer);
    const chunk = await this.source.read(this.pos, want);
    if (chunk.length < n) {
      throw new RangeError("unexpected end of GGUF file while reading header");
    }
    this.buf = chunk;
    this.bufStart = this.pos;
  }

  /** @param {number} n @returns {Promise<Buffer>} */
  async bytes(n) {
    await this.ensure(n);
    const start = this.pos - this.bufStart;
    const out = this.buf.subarray(start, start + n);
    this.pos += n;
    return out;
  }

  async u8() {
    await this.ensure(1);
    const value = this.buf.readUInt8(this.pos - this.bufStart);
    this.pos += 1;
    return value;
  }

  async i8() {
    await this.ensure(1);
    const value = this.buf.readInt8(this.pos - this.bufStart);
    this.pos += 1;
    return value;
  }

  async u16() {
    await this.ensure(2);
    const value = this.buf.readUInt16LE(this.pos - this.bufStart);
    this.pos += 2;
    return value;
  }

  async i16() {
    await this.ensure(2);
    const value = this.buf.readInt16LE(this.pos - this.bufStart);
    this.pos += 2;
    return value;
  }

  async u32() {
    await this.ensure(4);
    const value = this.buf.readUInt32LE(this.pos - this.bufStart);
    this.pos += 4;
    return value;
  }

  async i32() {
    await this.ensure(4);
    const value = this.buf.readInt32LE(this.pos - this.bufStart);
    this.pos += 4;
    return value;
  }

  async f32() {
    await this.ensure(4);
    const value = this.buf.readFloatLE(this.pos - this.bufStart);
    this.pos += 4;
    return value;
  }

  async f64() {
    await this.ensure(8);
    const value = this.buf.readDoubleLE(this.pos - this.bufStart);
    this.pos += 8;
    return value;
  }

  async u64() {
    await this.ensure(8);
    const value = this.buf.readBigUInt64LE(this.pos - this.bufStart);
    this.pos += 8;
    return value;
  }

  async i64() {
    await this.ensure(8);
    const value = this.buf.readBigInt64LE(this.pos - this.bufStart);
    this.pos += 8;
    return value;
  }

  /** @param {number} n */
  skip(n) {
    this.pos += n;
  }

  /**
   * @param {number} length
   * @param {number} [maxBytes]
   */
  async string(length, maxBytes = 4 * 1024 * 1024) {
    if (length > maxBytes) {
      this.skip(length);
      return "";
    }
    const raw = await this.bytes(length);
    return raw.toString("utf8");
  }
}

/**
 * Local file as a byte source.
 */
export class FileByteSource {
  /**
   * @param {fsp.FileHandle} handle
   * @param {string} filePath
   * @param {number} size
   */
  constructor(handle, filePath, size) {
    this.handle = handle;
    this.label = filePath;
    this.size = size;
  }

  /** @param {string} filePath */
  static async open(filePath) {
    const handle = await fsp.open(filePath, "r");
    const stat = await handle.stat();
    return new FileByteSource(handle, filePath, stat.size);
  }

  /**
   * @param {number} offset
   * @param {number} length
   */
  async read(offset, length) {
    const target = Buffer.allocUnsafe(Math.min(length, Math.max(0, this.size - offset)));
    const { bytesRead } = await this.handle.read(target, 0, target.length, offset);
    return target.subarray(0, bytesRead);
  }

  async close() {
    await this.handle.close();
  }
}

/**
 * In-memory source, handy for tests and for parsing GGUF buffers.
 */
export class BufferByteSource {
  /** @param {Buffer} buffer @param {string} [label] */
  constructor(buffer, label = "<buffer>") {
    this.buffer = buffer;
    this.size = buffer.length;
    this.label = label;
  }

  /**
   * @param {number} offset
   * @param {number} length
   */
  async read(offset, length) {
    return this.buffer.subarray(offset, Math.min(offset + length, this.size));
  }

  async close() {}
}
