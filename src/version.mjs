import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** @type {{name: string, version: string, description: string}} */
const pkg = require("../package.json");

export const PKG_NAME = pkg.name;
export const VERSION = pkg.version;
export const APP_NAME = "lollm";
export const USER_AGENT = `${PKG_NAME}/${VERSION}`;

/**
 * Ollama clients probe `/api/version` and compare against the daemon version.
 * lollm is not Ollama, but reporting a compatible version keeps clients
 * (Continue, Open WebUI, LangChain, ...) from bailing out.
 */
export const OLLAMA_COMPAT_VERSION = "0.5.7";
