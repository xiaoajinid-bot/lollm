/**
 * Every failure that should reach the client as a structured HTTP response is
 * wrapped in an `HttpError`. Anything else is reported as a generic 500 and
 * logged with its stack trace.
 */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {{type?: string, code?: string, cause?: unknown, details?: unknown}} [options]
   */
  constructor(status, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "HttpError";
    this.status = status;
    this.type = options.type ?? typeForStatus(status);
    this.code = options.code;
    this.details = options.details;
    this.expose = true;
  }
}

function typeForStatus(status) {
  if (status === 400) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 409) return "conflict_error";
  if (status === 413) return "payload_too_large";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "server_error";
  return "api_error";
}

/** @param {string} message @param {string} [code] */
export const badRequest = (message, code) =>
  new HttpError(400, message, { code: code ?? "invalid_request" });

/** @param {string} message @param {string} [code] */
export const notFound = (message, code) =>
  new HttpError(404, message, { code: code ?? "not_found" });

/** @param {string} message @param {string} [code] */
export const conflict = (message, code) =>
  new HttpError(409, message, { code: code ?? "conflict" });

/** @param {string} message @param {string} [code] */
export const unsupported = (message, code) =>
  new HttpError(501, message, { code: code ?? "unsupported" });

/** @param {string} message @param {unknown} [cause] */
export const upstream = (message, cause) =>
  new HttpError(502, message, { code: "upstream_error", cause });

/**
 * Normalize an arbitrarily thrown value into an `HttpError`.
 * @param {unknown} error
 * @returns {HttpError}
 */
export function toHttpError(error) {
  if (error instanceof HttpError) return error;
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return new HttpError(499, "request aborted by client", { code: "aborted" });
    }
    const err = new HttpError(500, error.message || "internal error", {
      code: "internal_error",
      cause: error,
    });
    err.expose = false;
    return err;
  }
  const err = new HttpError(500, "internal error", { code: "internal_error" });
  err.expose = false;
  return err;
}
