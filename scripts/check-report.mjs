#!/usr/bin/env node
/**
 * Publish a report file as a GitHub check run, so CI output is readable from the
 * API even when job logs are not (handy for deployments that only expose HTTP).
 *
 * Usage: node scripts/check-report.mjs <report.json> --name "lollm probe" [--conclusion failure]
 * Requires GITHUB_TOKEN, GITHUB_SHA and GITHUB_REPOSITORY in the environment.
 */
import fs from "node:fs/promises";

const argv = process.argv.slice(2);
const file = argv.find((arg) => !arg.startsWith("--"));
const valueOf = (/** @type {string} */ flag, /** @type {string} */ fallback) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : fallback;
};
const name = valueOf("--name", "lollm report");
const conclusion = valueOf("--conclusion", "success");

const token = process.env.GITHUB_TOKEN;
const sha = process.env.GITHUB_SHA;
const repo = process.env.GITHUB_REPOSITORY;

if (!file || !token || !sha || !repo) {
  console.error("usage: GITHUB_TOKEN=… GITHUB_SHA=… GITHUB_REPOSITORY=… node scripts/check-report.mjs <report.json>");
  process.exit(2);
}

let summary = "no report";
try {
  summary = await fs.readFile(file, "utf8");
} catch {
  // keep the placeholder
}
if (summary.length > 60_000) summary = `${summary.slice(0, 60_000)}\n…truncated`;

const response = await fetch(`https://api.github.com/repos/${repo}/check-runs`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    name,
    head_sha: sha,
    status: "completed",
    conclusion,
    output: { title: name, summary: summary || "no report" },
  }),
});

if (!response.ok) {
  console.error(`check run failed: ${response.status} ${await response.text()}`);
  process.exit(1);
}
const body = await response.json();
console.log(`published check run ${body.id} (${conclusion})`);
