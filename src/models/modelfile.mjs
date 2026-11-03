/**
 * Modelfile support (the Ollama dialect).
 *
 *   FROM qwen2.5:0.5b
 *   PARAMETER temperature 0.7
 *   PARAMETER stop "<|im_end|>"
 *   SYSTEM """You are a terse assistant."""
 *   TEMPLATE """{{ .System }}{{ .Prompt }}"""
 *   LICENSE MIT
 *   MESSAGE user hello
 *
 * Only the directives that matter for inference are kept; unknown directives
 * raise a clear error instead of being silently dropped.
 */

const KNOWN = new Set(["FROM", "PARAMETER", "SYSTEM", "TEMPLATE", "LICENSE", "MESSAGE", "ADAPTER", "COMMENT"]);

/**
 * @typedef {Object} ParsedModelfile
 * @property {string | null} from
 * @property {string | null} system
 * @property {string | null} template
 * @property {string | null} license
 * @property {Record<string, string | string[]>} parameters
 * @property {{role: string, content: string}[]} messages
 * @property {string[]} adapters
 */

/**
 * @param {string} text
 * @returns {ParsedModelfile}
 */
export function parseModelfile(text) {
  if (typeof text !== "string") throw new TypeError("modelfile content must be a string");
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  /** @type {ParsedModelfile} */
  const result = {
    from: null,
    system: null,
    template: null,
    license: null,
    parameters: {},
    messages: [],
    adapters: [],
  };

  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    i += 1;
    if (line === "" || line.startsWith("#")) continue;

    const match = /^([A-Za-z]+)\b\s*(.*)$/.exec(line);
    if (!match) throw new Error(`cannot parse Modelfile line ${i}: ${rawLine}`);
    const command = match[1].toUpperCase();
    if (!KNOWN.has(command)) {
      throw new Error(`unsupported Modelfile directive "${match[1]}" on line ${i}`);
    }

    let rest = match[2] ?? "";

    // Multi-line triple quoted values (SYSTEM/TEMPLATE/LICENSE/MESSAGE).
    if (/^"""/.test(rest) && !/^"""[\s\S]*"""$/.test(rest)) {
      const parts = [rest.slice(3)];
      let closed = false;
      while (i < lines.length) {
        const next = lines[i];
        i += 1;
        if (next.includes('"""')) {
          parts.push(next.slice(0, next.indexOf('"""')));
          closed = true;
          break;
        }
        parts.push(next);
      }
      if (!closed) throw new Error(`unterminated triple-quoted value for ${command}`);
      rest = parts.join("\n");
    }

    switch (command) {
      case "FROM": {
        if (rest === "") throw new Error("FROM requires a model or a path");
        result.from = unquote(rest);
        break;
      }
      case "ADAPTER": {
        if (rest !== "") result.adapters.push(unquote(rest));
        break;
      }
      case "SYSTEM": {
        result.system = mergeText(result.system, unquote(rest));
        break;
      }
      case "TEMPLATE": {
        result.template = mergeText(result.template, unquote(rest));
        break;
      }
      case "LICENSE": {
        result.license = mergeText(result.license, unquote(rest));
        break;
      }
      case "PARAMETER": {
        const [key, ...valueParts] = rest.split(/\s+/);
        if (!key || valueParts.length === 0) throw new Error(`PARAMETER needs a name and a value (line ${i})`);
        const value = unquote(valueParts.join(" "));
        const existing = result.parameters[key];
        if (existing === undefined) result.parameters[key] = value;
        else if (Array.isArray(existing)) existing.push(value);
        else result.parameters[key] = [existing, value];
        break;
      }
      case "MESSAGE": {
        const [role, ...content] = rest.split(/\s+/);
        if (!role || content.length === 0) throw new Error(`MESSAGE needs a role and content (line ${i})`);
        result.messages.push({ role: role.toLowerCase(), content: unquote(content.join(" ")) });
        break;
      }
      default:
        break;
    }
  }

  return result;
}

/** @param {string | null} current @param {string} next */
function mergeText(current, next) {
  return current === null ? next : `${current}\n${next}`;
}

/** @param {string} value */
function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 6 && trimmed.startsWith('"""') && trimmed.endsWith('"""')) {
    return trimmed.slice(3, -3).replace(/^\n/, "").replace(/\n$/, "");
  }
  if (trimmed.length >= 2) {
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return trimmed.slice(1, -1);
      }
    }
    if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
    if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
      return trimmed.replace(/^```[a-z]*\n?/i, "").replace(/```$/, "");
    }
  }
  return trimmed;
}

/**
 * Parse the `params` layer used by Ollama manifests: one `key value` per line.
 * @param {string} text
 * @returns {Record<string, string | string[]>}
 */
export function parseParametersText(text) {
  /** @type {Record<string, string | string[]>} */
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const [key, ...rest] = trimmed.split(/\s+/);
    const value = unquote(rest.join(" "));
    const existing = out[key];
    if (existing === undefined) out[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[key] = [existing, value];
  }
  return out;
}

/**
 * Serialize parameters back to the `key value` line format.
 * @param {Record<string, unknown>} parameters
 */
export function formatParametersText(parameters) {
  /** @type {string[]} */
  const lines = [];
  for (const [key, value] of Object.entries(parameters ?? {})) {
    if (value === undefined || value === null) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      const text = String(item);
      const needsQuotes = text === "" || /\s/.test(text) || text.startsWith('"');
      lines.push(`${key} ${needsQuotes ? JSON.stringify(text) : text}`);
    }
  }
  return lines.join("\n");
}

/**
 * Render a Modelfile for `/api/show`.
 * @param {{from: string, system?: string | null, template?: string | null, license?: string | null, parameters?: Record<string, unknown>}} input
 */
export function buildModelfileText(input) {
  /** @type {string[]} */
  const out = [`FROM ${input.from}`];
  if (input.template) out.push(`TEMPLATE """${input.template}"""`);
  if (input.system) out.push(`SYSTEM """${input.system}"""`);
  if (input.license) out.push(`LICENSE """${input.license}"""`);
  const params = formatParametersText(input.parameters ?? {});
  if (params) {
    for (const line of params.split("\n")) out.push(`PARAMETER ${line}`);
  }
  return out.join("\n");
}
