/**
 * A tiny Go-template renderer for Ollama-style chat templates.
 *
 * Ollama models ship a `TEMPLATE` written in Go's text/template syntax:
 *
 *   {{- range .Messages }}
 *   <|im_start|>{{ .Role }}
 *   {{ .Content }}<|im_end|>
 *   {{- end }}
 *   <|im_start|>assistant
 *
 * The subset implemented here (`if`, `else`, `range`, `end`, field access and
 * whitespace trimming) covers every template shipped in the Ollama library.
 * Unsupported constructs render as empty strings rather than throwing, so an
 * exotic template degrades to a worse prompt instead of a broken server.
 */

/**
 * @param {string} template
 * @param {Record<string, unknown>} context
 * @returns {string}
 */
export function renderTemplate(template, context) {
  if (!template) return "";
  const tokens = tokenize(String(template));
  const state = { i: 0 };
  const { nodes } = parseNodes(tokens, state, []);
  return renderNodes(nodes, context);
}

/**
 * Render the prompt for a chat request.
 *
 * @param {string} template
 * @param {Object} input
 * @param {string | null | undefined} [input.system]
 * @param {{role: string, content: string}[]} input.messages
 * @param {string} [input.prompt] explicit prompt (legacy /api/generate)
 * @param {unknown} [input.tools]
 */
export function renderChatTemplate(template, input) {
  const messages = input.messages ?? [];
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const prompt = input.prompt ?? lastUser?.content ?? "";
  return renderTemplate(template, {
    System: input.system ?? "",
    Prompt: prompt,
    Response: "",
    Messages: messages.map((message) => ({
      Role: message.role,
      Content: message.content,
      ...(message.tool_calls ? { ToolCalls: message.tool_calls } : {}),
    })),
    Tools: input.tools ? JSON.stringify(input.tools) : "",
  });
}

/**
 * @param {string} template
 */
function tokenize(template) {
  /** @type {{type: "text"|"action", value: string, trimLeft?: boolean, trimRight?: boolean}[]} */
  const tokens = [];
  let index = 0;
  while (index < template.length) {
    const start = template.indexOf("{{", index);
    if (start === -1) {
      tokens.push({ type: "text", value: template.slice(index) });
      break;
    }
    if (start > index) tokens.push({ type: "text", value: template.slice(index, start) });
    const end = template.indexOf("}}", start + 2);
    if (end === -1) {
      tokens.push({ type: "text", value: template.slice(start) });
      break;
    }
    let action = template.slice(start + 2, end).trim();
    let trimLeft = false;
    let trimRight = false;
    if (action.startsWith("-")) {
      trimLeft = true;
      action = action.slice(1).trim();
    }
    if (action.endsWith("-")) {
      trimRight = true;
      action = action.slice(0, -1).trim();
    }
    tokens.push({ type: "action", value: action, trimLeft, trimRight });
    index = end + 2;
  }

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type !== "action") continue;
    if (token.trimLeft) {
      const previous = tokens[i - 1];
      if (previous?.type === "text") previous.value = previous.value.replace(/\s+$/, "");
    }
    if (token.trimRight) {
      const next = tokens[i + 1];
      if (next?.type === "text") next.value = next.value.replace(/^\s+/, "");
    }
  }
  return tokens;
}

/**
 * @typedef {{type: "text", value: string}
 *   | {type: "action", expr: string}
 *   | {type: "if"|"range", expr: string, body: TemplateNode[], else: TemplateNode[]}} TemplateNode
 */

/**
 * @param {ReturnType<typeof tokenize>} tokens
 * @param {{i: number}} state
 * @param {string[]} stop
 * @returns {{nodes: TemplateNode[], stop: string | null}}
 */
function parseNodes(tokens, state, stop) {
  /** @type {TemplateNode[]} */
  const nodes = [];
  while (state.i < tokens.length) {
    const token = tokens[state.i];
    if (token.type === "text") {
      nodes.push({ type: "text", value: token.value });
      state.i += 1;
      continue;
    }
    const action = token.value;
    if (action === "" || action.startsWith("/*")) {
      state.i += 1;
      continue;
    }
    const keyword = action.split(/\s+/)[0];
    if (stop.includes(keyword)) return { nodes, stop: keyword };

    state.i += 1;
    if (keyword === "if" || keyword === "range" || keyword === "with") {
      const expr = action.slice(keyword.length).trim();
      const body = parseNodes(tokens, state, ["else", "end"]);
      /** @type {TemplateNode[]} */
      let elseNodes = [];
      if (body.stop === "else") {
        state.i += 1; // consume `else`
        const alternative = parseNodes(tokens, state, ["end"]);
        elseNodes = alternative.nodes;
        if (alternative.stop === "end") state.i += 1;
      } else if (body.stop === "end") {
        state.i += 1;
      }
      nodes.push({
        type: keyword === "range" ? "range" : "if",
        expr,
        body: body.nodes,
        else: elseNodes,
      });
      continue;
    }
    if (keyword === "end" || keyword === "else") return { nodes, stop: keyword };
    if (keyword === "define" || keyword === "block") {
      // Not supported; swallow the block so the rest still renders.
      parseNodes(tokens, state, ["end"]);
      continue;
    }
    if (keyword === "template") {
      // Inline partial included by name: not supported, renders as nothing.
      continue;
    }

    nodes.push({ type: "action", expr: action });
  }
  return { nodes, stop: null };
}

/**
 * @param {TemplateNode[]} nodes
 * @param {unknown} dot
 * @returns {string}
 */
function renderNodes(nodes, dot) {
  let out = "";
  for (const node of nodes) {
    if (node.type === "text") {
      out += node.value;
      continue;
    }
    if (node.type === "action") {
      out += stringify(resolve(node.expr, dot));
      continue;
    }
    if (node.type === "if") {
      out += truthy(resolve(node.expr, dot)) ? renderNodes(node.body, dot) : renderNodes(node.else, dot);
      continue;
    }
    if (node.type === "range") {
      const value = resolve(node.expr, dot);
      if (Array.isArray(value)) {
        for (const item of value) out += renderNodes(node.body, item);
      } else if (value && typeof value === "object") {
        for (const item of Object.values(value)) out += renderNodes(node.body, item);
      }
      continue;
    }
  }
  return out;
}

/**
 * @param {string} expr
 * @param {unknown} dot
 * @returns {unknown}
 */
function resolve(expr, dot) {
  let path = expr.trim();
  if (path === "") return "";
  if (path.startsWith("$")) {
    // Variables are not supported; be forgiving.
    path = path.replace(/^\$[A-Za-z0-9_]*\.?/, ".");
  }
  if (path.startsWith(".")) path = path.slice(1);
  if (path === "") return dot;
  let value = dot;
  for (const part of path.split(".")) {
    if (part === "") continue;
    if (value === null || value === undefined) return undefined;
    if (typeof value !== "object") return undefined;
    value = /** @type {Record<string, unknown>} */ (value)[part];
  }
  return value;
}

/** @param {unknown} value */
function stringify(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return "";
}

/** @param {unknown} value */
function truthy(value) {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}
