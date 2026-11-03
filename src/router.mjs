/**
 * Minimal path router with `:params`. No dependencies, no regex soup.
 */
export class Router {
  constructor() {
    /** @type {Array<{method: string, segments: string[], handler: RouteHandler, raw: string}>} */
    this.routes = [];
  }

  /**
   * @param {string} method
   * @param {string} pattern e.g. `/v1/models/:id`
   * @param {RouteHandler} handler
   */
  add(method, pattern, handler) {
    this.routes.push({
      method: method.toUpperCase(),
      segments: splitPath(pattern),
      handler,
      raw: pattern,
    });
    return this;
  }

  /**
   * @param {string} pattern
   * @param {RouteHandler} handler
   */
  get(pattern, handler) {
    return this.add("GET", pattern, handler);
  }

  /**
   * @param {string} pattern
   * @param {RouteHandler} handler
   */
  post(pattern, handler) {
    return this.add("POST", pattern, handler);
  }

  /**
   * @param {string} pattern
   * @param {RouteHandler} handler
   */
  delete(pattern, handler) {
    return this.add("DELETE", pattern, handler);
  }

  /**
   * @param {string} method
   * @param {string} pathname
   * @returns {{handler: RouteHandler, params: Record<string, string>} | {allow: string[]} | null}
   */
  match(method, pathname) {
    const parts = splitPath(pathname);
    /** @type {string[]} */
    const allowed = new Set();
    for (const route of this.routes) {
      const params = matchSegments(route.segments, parts);
      if (!params) continue;
      if (route.method === method.toUpperCase()) return { handler: route.handler, params };
      allowed.add(route.method);
    }
    if (allowed.size > 0) return { allow: [...allowed] };
    return null;
  }
}

/** @param {string} value */
function splitPath(value) {
  return value.split("/").filter((segment) => segment.length > 0);
}

/**
 * @param {string[]} pattern
 * @param {string[]} parts
 * @returns {Record<string, string> | null}
 */
function matchSegments(pattern, parts) {
  /** @type {Record<string, string>} */
  const params = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const segment = pattern[i];
    if (segment === "*") {
      params["*"] = parts.slice(i).join("/");
      return params;
    }
    if (i >= parts.length) return null;
    if (segment.startsWith(":")) {
      params[segment.slice(1)] = decodeURIComponent(parts[i]);
      continue;
    }
    if (segment !== parts[i]) return null;
  }
  return pattern.length === parts.length ? params : null;
}

/**
 * @typedef {Object} RequestContext
 * @property {import("node:http").IncomingMessage} req
 * @property {import("node:http").ServerResponse} res
 * @property {Record<string, string>} params
 * @property {URL} url
 * @property {AbortSignal} signal
 */

/** @typedef {(ctx: RequestContext) => Promise<void> | void} RouteHandler */
