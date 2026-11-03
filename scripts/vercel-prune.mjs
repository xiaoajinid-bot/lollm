#!/usr/bin/env node
/**
 * Vercel build helper: npm installs the prebuilt llama.cpp binary for *every*
 * platform flavour of node-llama-cpp (CPU, CUDA, Vulkan, arm64, …), which is
 * ~700 MB and far beyond the serverless bundle budget. A function can only ever
 * run on linux-x64 here, so drop the rest before the build traces files.
 *
 * Usage: node scripts/vercel-prune.mjs [--keep <flavour>]
 */
import fs from "node:fs/promises";
import path from "node:path";

const KEEP = (() => {
  const index = process.argv.indexOf("--keep");
  return new Set([index >= 0 ? process.argv[index + 1] : "linux-x64"]);
})();

const root = path.resolve("node_modules", "@node-llama-cpp");

/**
 * @param {string} target
 */
async function size(target) {
  let total = 0;
  const entries = await fs.readdir(target, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) total += await size(full);
    else total += (await fs.stat(full).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

const flavours = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
if (flavours.length === 0) {
  console.log("[vercel] no @node-llama-cpp packages installed — nothing to prune");
  process.exit(0);
}

const removed = [];
for (const entry of flavours) {
  if (!entry.isDirectory() || KEEP.has(entry.name)) continue;
  const full = path.join(root, entry.name);
  const bytes = await size(full);
  await fs.rm(full, { recursive: true, force: true });
  removed.push(`${entry.name} (${Math.round(bytes / 1e6)} MB)`);
}

const kept = [...KEEP].filter((name) => flavours.some((entry) => entry.name === name));
console.log(`[vercel] kept @node-llama-cpp: ${kept.join(", ") || "(none)"}`);
if (removed.length > 0) console.log(`[vercel] pruned: ${removed.join(", ")}`);
