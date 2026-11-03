import test from "node:test";
import assert from "node:assert/strict";

import { renderTemplate, renderChatTemplate } from "../src/chat/template.mjs";

const CLASSIC = `{{ if .System }}<|im_start|>system
{{ .System }}<|im_end|>
{{ end }}{{ if .Prompt }}<|im_start|>user
{{ .Prompt }}<|im_end|>
{{ end }}<|im_start|>assistant
{{ .Response }}<|im_end|>
`;

test("renders system + prompt in the classic Ollama format", () => {
  const out = renderTemplate(CLASSIC, { System: "Be terse.", Prompt: "hi", Response: "" });
  assert.equal(
    out,
    "<|im_start|>system\nBe terse.<|im_end|>\n<|im_start|>user\nhi<|im_end|>\n<|im_start|>assistant\n<|im_end|>\n",
  );
});

test("omits empty sections", () => {
  const out = renderTemplate(CLASSIC, { System: "", Prompt: "hi", Response: "" });
  assert.doesNotMatch(out, /system/);
  assert.match(out, /<\|im_start\|>user\nhi<\|im_end\|>/);
});

test("ranges over messages and resolves fields", () => {
  const template = `{{- range .Messages }}
<|start|>{{ .Role }}
{{ .Content }}<|end|>
{{- end }}
<|assistant|>`;
  const out = renderChatTemplate(template, {
    messages: [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
    ],
  });
  // Go's text/template keeps the newline that follows `{{- range .Messages }}`.
  assert.equal(out, "\n<|start|>user\none<|end|>\n<|start|>assistant\ntwo<|end|>\n<|assistant|>");
});

test("supports if/else and unknown fields", () => {
  const out = renderTemplate("{{ if .Tools }}tools:{{ .Tools }}{{ else }}no tools{{ end }}/{{ .Nope }}", {
    Tools: "",
  });
  assert.equal(out, "no tools/");
});

test("strips whitespace with trim markers", () => {
  assert.equal(renderTemplate("a   {{- .X -}}   b", { X: "X" }), "aXb");
});

test("unsupported constructs degrade instead of throwing", () => {
  assert.equal(renderTemplate("a{{ template \"x\" }}b", {}), "ab");
  assert.equal(renderTemplate("{{ range .Missing }}x{{ end }}", {}), "");
});
