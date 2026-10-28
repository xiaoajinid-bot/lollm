/** Loader ESM: mengarahkan import lib/llm-engine.mjs ke stub-engine.mjs. */

const STUB_URL = new URL('./stub-engine.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  const isEngine =
    specifier === '../lib/llm-engine.mjs' ||
    specifier === './llm-engine.mjs' ||
    specifier.endsWith('/lib/llm-engine.mjs');

  if (isEngine) {
    return { url: STUB_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
