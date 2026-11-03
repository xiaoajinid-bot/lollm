#!/usr/bin/env node
/**
 * Verify that remote GGUF models are reachable and readable *without*
 * downloading them: for every URL (or `hf:` reference) it reads the header over
 * HTTP Range, reports the architecture, size and traffic, and exits non-zero if
 * anything failed.
 *
 * Usage:
 *   node scripts/verify-remote.mjs <url|hf:repo:file.gguf> [...]
 *   npm run verify:remote -- <url> [...]
 *
 * Options:
 *   --json         machine-readable array instead of a table
 *   --tensor NAME  also read a slice of one tensor
 *   --allow-insecure   permit plain http:// sources
 */
import { inspectRemoteModel, readRemoteTensor } from "../src/models/remote.mjs";
import { formatBytes } from "../src/util/format.mjs";

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const allowInsecure = argv.includes("--allow-insecure");
const tensorIndex = argv.indexOf("--tensor");
const tensor = tensorIndex >= 0 ? argv[tensorIndex + 1] : undefined;
const targets = argv.filter(
  (arg, index) =>
    !arg.startsWith("--") && !(tensorIndex >= 0 && index === tensorIndex + 1),
);

if (targets.length === 0) {
  console.error("usage: node scripts/verify-remote.mjs <url|hf:repo:file.gguf> [...]");
  process.exit(2);
}

/** @type {Array<Record<string, any>>} */
const results = [];
let failures = 0;

for (const target of targets) {
  const startedAt = Date.now();
  try {
    const result = await inspectRemoteModel(target, { allowInsecure });
    const info = result.info;
    /** @type {Record<string, any>} */
    const row = {
      target,
      ok: true,
      url: result.url,
      size: result.size,
      architecture: info.architecture,
      quantization: info.quantization,
      parameters: info.parameterCount,
      contextLength: info.contextLength,
      tensorCount: info.tensorCount,
      chatTemplate: Boolean(info.chatTemplate),
      requests: result.stats.requests,
      bytesFetched: result.stats.bytesFetched,
      percent: result.size ? Number(((result.stats.bytesFetched / result.size) * 100).toFixed(4)) : null,
      elapsedMs: Date.now() - startedAt,
    };
    if (tensor) {
      const slice = await readRemoteTensor(target, tensor, { allowInsecure, maxBytes: 64 * 1024 });
      row.tensor = {
        name: slice.tensor.name,
        type: slice.tensor.typeName,
        dims: slice.tensor.dims,
        offset: slice.tensor.absOffset,
        bytes: slice.bytes.length,
      };
    }
    results.push(row);
  } catch (error) {
    failures += 1;
    results.push({
      target,
      ok: false,
      code: /** @type {any} */ (error).code ?? null,
      status: /** @type {any} */ (error).status ?? null,
      error: /** @type {Error} */ (error).message,
      elapsedMs: Date.now() - startedAt,
    });
  }
}

if (json) {
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
} else {
  for (const row of results) {
    if (!row.ok) {
      process.stdout.write(`FAIL ${row.target}\n     ${row.error}\n`);
      continue;
    }
    process.stdout.write(`OK   ${row.target}\n`);
    process.stdout.write(`     architecture  ${row.architecture}\n`);
    process.stdout.write(`     size          ${formatBytes(row.size)}\n`);
    process.stdout.write(`     parameters    ${row.parameters.toLocaleString()} (${row.quantization})\n`);
    process.stdout.write(`     context       ${row.contextLength ?? "unknown"}\n`);
    process.stdout.write(`     tensors       ${row.tensorCount}\n`);
    process.stdout.write(`     chat template ${row.chatTemplate ? "present" : "none"}\n`);
    process.stdout.write(
      `     fetched       ${formatBytes(row.bytesFetched)} in ${row.requests} request(s) = ${row.percent}% of the file\n`,
    );
    if (row.tensor) {
      process.stdout.write(
        `     tensor        ${row.tensor.name} ${row.tensor.type} [${row.tensor.dims.join(" × ")}] @ ${row.tensor.offset}\n`,
      );
    }
    process.stdout.write(`     elapsed       ${row.elapsedMs} ms\n`);
  }
}

process.exit(failures === 0 ? 0 : 1);
