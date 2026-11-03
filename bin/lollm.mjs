#!/usr/bin/env node
/**
 * lollm CLI — an Ollama-shaped command line for a llama.cpp/Node.js server.
 *
 *   lollm serve
 *   lollm pull qwen2.5:0.5b
 *   lollm run qwen2.5:0.5b "halo!"
 */
import { parseArgs } from "node:util";
import readline from "node:readline/promises";
import path from "node:path";
import fs from "node:fs/promises";

import { APP_NAME, VERSION } from "../src/version.mjs";
import { createLogger } from "../src/logger.mjs";
import { resolveConfig } from "../src/config.mjs";
import { ModelStore } from "../src/models/store.mjs";
import { parseModelfile } from "../src/models/modelfile.mjs";
import { createHash } from "node:crypto";
import { formatBytes, formatDuration, parseDuration, now } from "../src/util/format.mjs";
import { inspectRemoteModel, readRemoteTensor } from "../src/models/remote.mjs";
import { start } from "../src/index.mjs";

const HELP = `${APP_NAME} ${VERSION} — Ollama-compatible local LLM server on llama.cpp (Node.js)

USAGE
  lollm <command> [options]

COMMANDS
  serve                     Start the HTTP API (Ollama + OpenAI compatible)
  run <model> [prompt...]   Chat with a model in the terminal
  pull <reference>          Download a model (Ollama registry, Hugging Face, URL or file)
  inspect <reference>       Read a remote GGUF header with HTTP Range (no full download)
  list, ls                  List installed models
  ps                        Show models loaded in a running server
  show <model>              Show details, template and parameters of a model
  create <name>             Create a model from a Modelfile
  cp <source> <target>      Duplicate a model under a new name
  rm <model...>             Remove one or more models
  embed <model> <text...>   Compute an embedding vector
  version                   Print the version
  help                      Show this help

COMMON OPTIONS
  --host <host>             Bind address (default 127.0.0.1, env LOLLM_HOST)
  --port <port>             Port (default 11434, env LOLLM_PORT)
  --home <dir>              Data directory (default ~/.lollm)
  --models-dir <dir>        Override the model store location
  --backend <llama|mock>    Inference backend (default llama)
  --gpu <auto|false|cuda|metal|vulkan>
  --context-size <tokens>   Context window (default: the model's own, no cap)
  --max-tokens <n>          Optional cap on generated tokens (default: unlimited)
  --max-body-bytes <n>      Optional request body cap (default: unlimited)
  --parallel <n>            Concurrent generations (default 1)
  --keep-alive <duration>   How long models stay loaded (default 5m)
  --verbose                 Verbose logging
  --json                    Machine-readable output (list/show/inspect)
  --allow-insecure          Permit plain http:// model downloads (env LOLLM_ALLOW_INSECURE)
  --hf-endpoint <url>       Base URL for hf: references (mirrors/proxies)

SERVE
  lollm serve --port 11434 --verbose

INSPECT (on-demand, Range requests)
  lollm inspect hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:qwen2.5-0.5b-instruct-q4_k_m.gguf
  lollm inspect https://example.com/model.gguf --json
  lollm inspect https://example.com/model.gguf --tensor token_embd.weight
  lollm inspect https://example.com/model.gguf --block-size 65536 --json

PULL
  lollm pull qwen2.5:0.5b
  lollm pull hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:qwen2.5-0.5b-instruct-q4_k_m.gguf --name qwen2.5:0.5b
  lollm pull ./models/my-model.gguf --name mine:latest

CREATE
  lollm create my-tutor --from qwen2.5:0.5b --system "You are a patient tutor."
  lollm create my-tutor -f Modelfile

Docs: https://github.com/xiaoajinid-bot/lollm
`;

const OPTIONS = {
  host: { type: "string" },
  port: { type: "string" },
  home: { type: "string" },
  "models-dir": { type: "string" },
  backend: { type: "string" },
  gpu: { type: "string" },
  "gpu-layers": { type: "string" },
  threads: { type: "string" },
  "context-size": { type: "string" },
  parallel: { type: "string" },
  "keep-alive": { type: "string" },
  "max-loaded-models": { type: "string" },
  verbose: { type: "boolean", short: "v" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  name: { type: "string", short: "n" },
  from: { type: "string" },
  file: { type: "string", short: "f" },
  system: { type: "string", short: "s" },
  template: { type: "string" },
  parameter: { type: "string", short: "p", multiple: true },
  temperature: { type: "string" },
  quiet: { type: "boolean", short: "q" },
  open: { type: "boolean" },
  force: { type: "boolean" },
  tensor: { type: "string" },
  "block-size": { type: "string" },
  "max-bytes": { type: "string" },
  "max-tokens": { type: "string" },
  "max-body-bytes": { type: "string" },
  "hf-endpoint": { type: "string" },
  "allow-insecure": { type: "boolean" },
};

/** @param {string | undefined} value */
const toInt = (value) => {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * @param {Record<string, any>} values
 */
function configOverrides(values) {
  return {
    host: values.host,
    port: toInt(values.port),
    home: values.home,
    modelsDir: values["models-dir"],
    backend: values.backend,
    gpu: values.gpu === undefined ? undefined : values.gpu === "false" ? false : values.gpu,
    gpuLayers: toInt(values["gpu-layers"]),
    threads: toInt(values.threads),
    contextSize: values["context-size"] === "auto" ? undefined : toInt(values["context-size"]),
    maxTokens: toInt(values["max-tokens"]),
    maxBodyBytes: toInt(values["max-body-bytes"]),
    hfEndpoint: values["hf-endpoint"],
    parallel: toInt(values.parallel),
    keepAlive: values["keep-alive"],
    maxLoadedModels: toInt(values["max-loaded-models"]),
    verbose: values.verbose === true ? true : undefined,
    logLevel: values.verbose ? "debug" : undefined,
    allowInsecure: values["allow-insecure"] === true ? true : undefined,
  };
}

/** @param {Record<string, any>} values */
async function makeStore(values, logger) {
  const config = resolveConfig(configOverrides(values));
  const store = new ModelStore({
    modelsDir: config.modelsDir,
    logger: logger.child("store"),
    registry: config.ollamaRegistry,
    hfToken: config.hfToken,
    hfEndpoint: config.hfEndpoint,
    allowInsecure: config.allowInsecure,
  });
  await store.init();
  return { config, store };
}

/** @param {string} text */
const dim = (text) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\u001b[90m${text}\u001b[0m` : text);
/** @param {string} text */
const bold = (text) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\u001b[1m${text}\u001b[0m` : text);
/** @param {string} text */
const cyan = (text) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\u001b[36m${text}\u001b[0m` : text);

/**
 * @param {{status: string, digest?: string, total?: number, completed?: number}} event
 */
function makeProgressPrinter(quiet = false) {
  let lastLength = 0;
  let lastStatus = "";
  let startedAt = Date.now();
  let lastCompleted = 0;
  const tty = Boolean(process.stdout.isTTY) && !quiet;
  return (event) => {
    if (quiet) return;
    const { status, total, completed } = event;
    if (status !== lastStatus) {
      lastStatus = status;
      startedAt = Date.now();
      lastCompleted = 0;
    }
    if (!total) {
      if (tty) {
        const line = status;
        process.stdout.write(`\r${line.padEnd(lastLength)}`);
        lastLength = line.length;
      } else if (status !== "downloading") {
        process.stdout.write(`${status}\n`);
      }
      return;
    }
    const percent = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
    const elapsed = (Date.now() - startedAt) / 1000;
    const speed = elapsed > 0.2 ? (completed - lastCompleted) / elapsed : 0;
    const line =
      `${status}  ${String(percent).padStart(3)}% ` +
      `${formatBytes(completed)}/${formatBytes(total)}` +
      (speed > 0 ? `  ${formatBytes(speed)}/s` : "");
    if (tty) {
      process.stdout.write(`\r${line.padEnd(lastLength)}`);
      lastLength = line.length;
      if (percent >= 100) process.stdout.write("\n");
    } else if (percent === 100) {
      process.stdout.write(`${line}\n`);
    }
  };
}

/** @param {string} model */
async function commandServe(values, positionals) {
  const logger = createLogger({ level: values.verbose ? "debug" : "info" });
  const instance = await start({ ...configOverrides(values), logger });
  const { url, config } = instance;
  const lines = [
    "",
    bold(`${APP_NAME} ${VERSION}`),
    dim(`models   ${config.modelsDir}`),
    dim(`backend  ${config.backend}${config.backend === "mock" ? " (no real inference)" : ""}`),
    "",
    `  Ollama API  ${cyan(`${url}/api`)}`,
    `  OpenAI API  ${cyan(`${url}/v1`)}`,
    `  Playground  ${cyan(`${url}/playground`)}`,
    "",
    dim("Press Ctrl+C to stop."),
    "",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down…`);
    try {
      await instance.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  await new Promise(() => {});
  void positionals;
}

/** @param {Record<string, any>} values @param {string[]} positionals */
async function commandInspect(values, positionals) {
  const reference = positionals[0];
  if (!reference) throw new Error("usage: lollm inspect <url|hf:repo:file.gguf> [--tensor name] [--json]");
  const config = resolveConfig(configOverrides(values));
  const options = {
    hfToken: config.hfToken,
    hfEndpoint: config.hfEndpoint,
    allowInsecure: config.allowInsecure,
    blockSize: toInt(values["block-size"]),
  };

  if (values.tensor) {
    const result = await readRemoteTensor(reference, values.tensor, {
      ...options,
      maxBytes: toInt(values["max-bytes"]) ?? 64 * 1024,
    });
    const hash = createHash("sha256").update(result.bytes).digest("hex");
    if (values.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            url: result.url,
            tensor: result.tensor,
            bytes_fetched: result.bytes.length,
            sha256: hash,
            stats: result.stats,
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
    process.stdout.write(`${bold(result.tensor.name)}\n`);
    process.stdout.write(`  type      ${result.tensor.typeName}\n`);
    process.stdout.write(`  dims      [${result.tensor.dims.join(" × ")}]\n`);
    process.stdout.write(`  elements  ${result.tensor.elements.toLocaleString()}\n`);
    process.stdout.write(`  file      offset ${result.tensor.absOffset.toLocaleString()}\n`);
    process.stdout.write(`\n  fetched   ${formatBytes(result.bytes.length)} slice (sha256 ${hash.slice(0, 16)}…)\n`);
    process.stdout.write(
      `  network   ${result.stats.requests} request(s), ${formatBytes(result.stats.bytesFetched)} total\n`,
    );
    process.stdout.write(
      `\n  ${dim("only this slice was fetched with Range requests; the rest of the file stayed on the server")}\n`,
    );
    return;
  }

  const result = await inspectRemoteModel(reference, options);
  const info = result.info;
  if (values.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          url: result.url,
          size: result.size,
          etag: result.etag,
          stats: result.stats,
          model: {
            architecture: info.architecture,
            name: info.name,
            quantization: info.quantization,
            parameter_count: info.parameterCount,
            context_length: info.contextLength,
            embedding_length: info.embeddingLength,
            block_count: info.blockCount,
            tensor_count: info.tensorCount,
            header_bytes: info.headerBytesRead,
            data_start: info.dataStart,
            chat_template: info.chatTemplate ? true : false,
          },
          tensors: info.tensors.map((tensor) => ({
            name: tensor.name,
            type: tensor.typeName,
            dims: tensor.dims,
            elements: tensor.elements,
            offset: tensor.absOffset,
          })),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  process.stdout.write(`${bold(result.url)}\n`);
  process.stdout.write(`  size          ${formatBytes(result.size)}\n`);
  process.stdout.write(`  architecture  ${info.architecture}\n`);
  process.stdout.write(`  parameters    ${info.parameterCount.toLocaleString()} (${info.quantization})\n`);
  process.stdout.write(`  context       ${info.contextLength ?? "unknown"}\n`);
  process.stdout.write(`  tensors       ${info.tensorCount}\n`);
  process.stdout.write(`  chat template ${info.chatTemplate ? "present" : "none"}\n`);
  process.stdout.write(`\n  ${bold("on-demand I/O")}\n`);
  process.stdout.write(`  requests      ${result.stats.requests}\n`);
  process.stdout.write(`  downloaded    ${formatBytes(result.stats.bytesFetched)} (${((result.stats.bytesFetched / result.size) * 100).toFixed(2)}% of the file)\n`);
  process.stdout.write(`  saved         ${formatBytes(Math.max(0, result.size - result.stats.bytesFetched))}\n`);
  process.stdout.write(`\n  ${dim("only metadata was fetched; tensor payloads are read on demand with Range requests")}\n`);
}

/** @param {Record<string, any>} values @param {string[]} positionals */
async function commandPull(values, positionals) {
  const reference = positionals[0];
  if (!reference) throw new Error("usage: lollm pull <model|hf:repo:file|url|path> [--name name]");
  const logger = createLogger({ level: values.verbose ? "debug" : "warn" });
  const { store } = await makeStore(values, logger);
  const progress = makeProgressPrinter(values.quiet === true);
  const result = await store.pull(reference, { name: values.name, onProgress: progress });
  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${bold("✔")} ${result.model} ready${result.size ? dim(` (${formatBytes(result.size)})`) : ""}\n`);
  }
}

/** @param {Record<string, any>} values */
async function commandList(values) {
  const logger = createLogger({ level: "warn" });
  const { store } = await makeStore(values, logger);
  const models = await store.list();
  if (values.json) {
    process.stdout.write(`${JSON.stringify({ models }, null, 2)}\n`);
    return;
  }
  if (models.length === 0) {
    process.stdout.write(`No models installed. Try: ${cyan("lollm pull qwen2.5:0.5b")}\n`);
    return;
  }
  const rows = models.map((model) => [
    model.name,
    formatBytes(model.size),
    model.details.parameter_size,
    model.details.quantization_level,
    new Date(model.modified_at).toLocaleString(),
  ]);
  const header = ["NAME", "SIZE", "PARAMS", "QUANT", "MODIFIED"];
  printTable([header, ...rows]);
}

/** @param {string[][]} rows */
function printTable(rows) {
  const widths = rows[0].map((_, index) => Math.max(...rows.map((row) => (row[index] ?? "").length)));
  const [head, ...body] = rows;
  process.stdout.write(`${bold(head.map((cell, index) => cell.padEnd(widths[index])).join("  "))}\n`);
  for (const row of body) {
    process.stdout.write(`${row.map((cell, index) => String(cell ?? "").padEnd(widths[index])).join("  ")}\n`);
  }
}

/** @param {Record<string, any>} values */
async function commandPs(values) {
  const config = resolveConfig(configOverrides(values));
  const url = `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}/api/ps`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error(`server responded ${response.status}`);
    const data = await response.json();
    if (values.json) {
      process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
      return;
    }
    if (!data.models?.length) {
      process.stdout.write(`No models loaded (${url}).\n`);
      return;
    }
    printTable([
      ["NAME", "SIZE", "EXPIRES"],
      ...data.models.map((model) => [model.name, formatBytes(model.size), String(model.expires_at)]),
    ]);
  } catch (error) {
    process.stdout.write(
      `Cannot reach a lollm server at ${url} (${/** @type {Error} */ (error).message}).\n` +
        `Start one with: ${cyan("lollm serve")}\n`,
    );
  }
}

/** @param {Record<string, any>} values @param {string[]} positionals */
async function commandShow(values, positionals) {
  const model = positionals[0];
  if (!model) throw new Error("usage: lollm show <model> [--json]");
  const logger = createLogger({ level: "warn" });
  const { store } = await makeStore(values, logger);
  const resolved = await store.resolve(model);
  const show = await store.show(model);
  if (values.json) {
    process.stdout.write(`${JSON.stringify(show, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${bold(resolved.name)}\n`);
  process.stdout.write(`  architecture  ${resolved.details.family}\n`);
  process.stdout.write(`  parameters    ${resolved.details.parameter_size}\n`);
  process.stdout.write(`  quantization  ${resolved.details.quantization_level}\n`);
  process.stdout.write(`  size          ${formatBytes(resolved.size)}\n`);
  process.stdout.write(`  context       ${resolved.gguf.contextLength ?? "unknown"}\n`);
  process.stdout.write(`  digest        ${resolved.digest}\n`);
  process.stdout.write(`  capabilities  ${resolved.capabilities.join(", ")}\n`);
  process.stdout.write(`  blob          ${resolved.modelPath}\n`);
  if (show.system) process.stdout.write(`\n${bold("SYSTEM")}\n${show.system}\n`);
  if (show.template) process.stdout.write(`\n${bold("TEMPLATE")}\n${show.template}\n`);
  if (show.parameters) process.stdout.write(`\n${bold("PARAMETERS")}\n${show.parameters}\n`);
}

/** @param {Record<string, any>} values @param {string[]} positionals */
async function commandRun(values, positionals) {
  const model = positionals[0];
  if (!model) throw new Error("usage: lollm run <model> [prompt...]");
  const prompt = positionals.slice(1).join(" ");
  const logger = createLogger({ level: values.verbose ? "debug" : "warn" });
  const instance = await start({ ...configOverrides(values), logger, port: 0, playground: false });
  const { engine, close } = instance;

  const options = {
    ...(values.temperature ? { temperature: Number(values.temperature) } : {}),
    ...(values.parameter
      ? Object.fromEntries(
          values.parameter
            .map((entry) => String(entry).split("="))
            .filter(([key, value]) => key && value !== undefined)
            .map(([key, value]) => [key, Number.isFinite(Number(value)) ? Number(value) : value]),
        )
      : {}),
  };

  /** @type {{role: string, content: string}[]} */
  const history = [];
  const ask = async (text) => {
    history.push({ role: "user", content: text });
    let firstTokenAt = 0;
    const startedAt = now();
    process.stdout.write(`${cyan("lollm>")} `);
    const result = await engine.chat({
      model,
      messages: history,
      options,
      keepAlive: values["keep-alive"] ?? "10m",
      onToken: (chunk) => {
        if (!firstTokenAt) firstTokenAt = now();
        process.stdout.write(chunk);
      },
    });
    if (!firstTokenAt) process.stdout.write(result.text);
    history.push({ role: "assistant", content: result.text });
    const elapsed = (now() - startedAt) / 1000;
    const tps = elapsed > 0 ? (result.timings.completionTokens / elapsed).toFixed(1) : "?";
    process.stdout.write(
      `\n${dim(`[${result.timings.completionTokens} tokens, ${tps} tok/s, ${formatDuration(elapsed * 1000)}]`)}\n\n`,
    );
    return result;
  };

  const cleanup = async () => {
    await close();
  };

  if (prompt) {
    try {
      await ask(prompt);
    } finally {
      await cleanup();
    }
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  process.stdout.write(
    `${bold(APP_NAME)} ${dim(`· ${model}`)}  ${dim("(type /bye or Ctrl+D to quit)")}\n\n`,
  );
  try {
    for (;;) {
      let line;
      try {
        line = await rl.question(cyan("you> "));
      } catch {
        break;
      }
      const text = line.trim();
      if (text === "") continue;
      if (["/bye", "/exit", "exit", "quit"].includes(text)) break;
      if (text === "/reset") {
        history.length = 0;
        process.stdout.write(`${dim("history cleared")}\n`);
        continue;
      }
      await ask(text);
    }
  } finally {
    rl.close();
    await cleanup();
  }
}

/** @param {Record<string, any>} values @param {string[]} positionals */
async function commandRemove(values, positionals) {
  if (positionals.length === 0) throw new Error("usage: lollm rm <model...>");
  const logger = createLogger({ level: "warn" });
  const { store } = await makeStore(values, logger);
  for (const model of positionals) {
    const result = await store.remove(model);
    process.stdout.write(`deleted ${result.model}\n`);
  }
}

/** @param {Record<string, any>} values @param {string[]} positionals */
async function commandCopy(values, positionals) {
  const [source, destination] = positionals;
  if (!source || !destination) throw new Error("usage: lollm cp <source> <destination>");
  const logger = createLogger({ level: "warn" });
  const { store } = await makeStore(values, logger);
  await store.copy(source, destination);
  process.stdout.write(`${source} copied to ${destination}\n`);
}

/** @param {Record<string, any>} values @param {string[]} positionals */
async function commandCreate(values, positionals) {
  const model = positionals[0];
  if (!model) throw new Error("usage: lollm create <name> --from <model|path> [-f Modelfile]");
  const logger = createLogger({ level: values.verbose ? "debug" : "warn" });
  const { store } = await makeStore(values, logger);

  /** @type {any} */
  let parsed = {};
  if (values.file) {
    const text = await fs.readFile(path.resolve(values.file), "utf8");
    try {
      parsed = parseModelfile(text);
    } catch (error) {
      throw new Error(`invalid Modelfile ${values.file}: ${/** @type {Error} */ (error).message}`);
    }
  }

  /** @type {Record<string, unknown>} */
  const parameters = { ...(parsed.parameters ?? {}) };
  for (const entry of values.parameter ?? []) {
    const [key, ...rest] = String(entry).split("=");
    if (!key || rest.length === 0) throw new Error(`--parameter expects key=value, got "${entry}"`);
    parameters[key] = rest.join("=");
  }

  const result = await store.create({
    model,
    from: values.from ?? parsed.from,
    system: values.system ?? parsed.system,
    template: values.template ?? parsed.template,
    license: parsed.license,
    parameters,
  });
  process.stdout.write(`created ${result.model}\n`);
}

/** @param {Record<string, any>} values @param {string[]} positionals */
async function commandEmbed(values, positionals) {
  const [model, ...textParts] = positionals;
  const text = textParts.join(" ");
  if (!model || !text) throw new Error("usage: lollm embed <model> <text...>");
  const logger = createLogger({ level: values.verbose ? "debug" : "warn" });
  const instance = await start({ ...configOverrides(values), logger, port: 0, playground: false });
  try {
    const result = await instance.engine.embed({ model, input: [text] });
    const vector = result.embeddings[0];
    if (values.json) {
      process.stdout.write(`${JSON.stringify({ model: result.model, embedding: vector }, null, 2)}\n`);
      return;
    }
    process.stdout.write(`dimensions: ${vector.length}\n`);
    process.stdout.write(`embedding: [${vector.slice(0, 8).map((value) => value.toFixed(4)).join(", ")}${vector.length > 8 ? ", …" : ""}]\n`);
  } finally {
    await instance.close();
  }
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({ args: process.argv.slice(2), options: OPTIONS, allowPositionals: true, strict: false });
  } catch (error) {
    process.stderr.write(`error: ${/** @type {Error} */ (error).message}\n\n${HELP}`);
    process.exitCode = 1;
    return;
  }
  const { values, positionals } = parsed;
  const [command = "help", ...rest] = positionals;

  if (values.help || command === "help" || command === "--help") {
    process.stdout.write(HELP);
    return;
  }
  if (command === "version" || command === "--version") {
    process.stdout.write(`${APP_NAME} ${VERSION}\n`);
    return;
  }

  try {
    switch (command) {
      case "serve":
      case "server":
        await commandServe(values, rest);
        break;
      case "run":
        await commandRun(values, rest);
        break;
      case "pull":
        await commandPull(values, rest);
        break;
      case "inspect":
      case "info":
        await commandInspect(values, rest);
        break;
      case "list":
      case "ls":
        await commandList(values);
        break;
      case "ps":
        await commandPs(values);
        break;
      case "show":
        await commandShow(values, rest);
        break;
      case "create":
        await commandCreate(values, rest);
        break;
      case "cp":
      case "copy":
        await commandCopy(values, rest);
        break;
      case "rm":
      case "delete":
        await commandRemove(values, rest);
        break;
      case "embed":
        await commandEmbed(values, rest);
        break;
      default:
        process.stderr.write(`unknown command "${command}"\n\n${HELP}`);
        process.exitCode = 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: ${message}\n`);
    if (values.verbose && error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  }
  void parseDuration;
}

void main();
