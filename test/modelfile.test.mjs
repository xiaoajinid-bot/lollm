import test from "node:test";
import assert from "node:assert/strict";

import {
  buildModelfileText,
  formatParametersText,
  parseModelfile,
  parseParametersText,
} from "../src/models/modelfile.mjs";

test("parses a full Modelfile", () => {
  const parsed = parseModelfile(`
    # a comment
    FROM qwen2.5:0.5b

    PARAMETER temperature 0.7
    PARAMETER stop "<|im_end|>"
    PARAMETER stop "<|endoftext|>"
    PARAMETER num_ctx 8192

    SYSTEM """You are a patient tutor.
Always answer in Indonesian."""

    TEMPLATE """{{ if .System }}<|system|>{{ .System }}<|end|>{{ end }}{{ .Prompt }}"""

    LICENSE MIT

    MESSAGE user hello
    MESSAGE assistant hi there
  `);

  assert.equal(parsed.from, "qwen2.5:0.5b");
  assert.equal(parsed.system, "You are a patient tutor.\nAlways answer in Indonesian.");
  assert.match(parsed.template, /\{\{ \.Prompt \}\}/);
  assert.equal(parsed.license, "MIT");
  assert.equal(parsed.parameters.temperature, "0.7");
  assert.equal(parsed.parameters.num_ctx, "8192");
  assert.deepEqual(parsed.parameters.stop, ["<|im_end|>", "<|endoftext|>"]);
  assert.deepEqual(parsed.messages, [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi there" },
  ]);
});

test("parses single-line triple quoted values without eating the quotes", () => {
  const parsed = parseModelfile('SYSTEM """Be brief."""');
  assert.equal(parsed.system, "Be brief.");
});

test("rejects unknown directives and malformed lines", () => {
  assert.throws(() => parseModelfile("FOO bar"), /unsupported Modelfile directive "FOO"/);
  assert.throws(() => parseModelfile("PARAMETER temperature"), /PARAMETER needs a name and a value/);
  assert.throws(() => parseModelfile('SYSTEM """unterminated'), /unterminated triple-quoted value/);
});

test("parameters text round-trips and keeps repeated values", () => {
  const text = formatParametersText({ temperature: 0.8, stop: ["</s>", "<|eot|>"], num_ctx: 4096 });
  const parsed = parseParametersText(text);
  assert.equal(parsed.temperature, "0.8");
  assert.equal(parsed.num_ctx, "4096");
  assert.deepEqual(parsed.stop, ["</s>", "<|eot|>"]);
});

test("buildModelfileText renders a usable Modelfile", () => {
  const text = buildModelfileText({
    from: "/models/blobs/sha256-abc",
    system: "Be nice.",
    template: "{{ .Prompt }}",
    parameters: { temperature: 0.5 },
  });
  assert.match(text, /^FROM \/models\/blobs\/sha256-abc/);
  assert.match(text, /SYSTEM """Be nice\."""/);
  assert.match(text, /PARAMETER temperature 0\.5/);
  const reparsed = parseModelfile(text);
  assert.equal(reparsed.system, "Be nice.");
  assert.equal(reparsed.parameters.temperature, "0.5");
});
