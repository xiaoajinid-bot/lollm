# Contributing

Thanks for taking a look! This project is intentionally small and dependency-light, so most
contributions are a single file.

## Setup

```bash
git clone https://github.com/xiaoajinid-bot/lollm
cd lollm
npm install                 # optional: node-llama-cpp prebuilt binaries
npm test                    # runs against the mock backend, no weights needed
npm run check               # syntax check every module
```

For UI work, start the server with the mock backend — it replies instantly and never touches the
filesystem outside `~/.lollm`:

```bash
lollm serve --backend mock
open http://127.0.0.1:11434/playground
```

## Ground rules

- **No new runtime dependencies.** The package ships without them on purpose; the HTTP server,
  GGUF reader, template renderer and CLI are all hand-written. Dev-only tooling is fine but should
  be justified.
- **Tests come first for behaviour changes.** The suite is hermetic: no network, no model downloads,
  no GPU. Add fixtures with `test/helpers/gguf-fixture.mjs` instead of committing binary models;
  remote/`Range` behaviour is exercised against `test/helpers/range-server.mjs` on loopback.
- **Keep both APIs in sync.** A feature added to `/api/chat` usually has an OpenAI equivalent; note
  explicitly in the PR when it does not.
- **Errors are part of the API.** Use `HttpError` helpers (`badRequest`, `notFound`, ...) so clients
  get the documented shape.
- **No dead code or TODOs in shipped paths.** If something is unsupported, say so in the response
  and in the docs.

## Style

- ESM only, 2-space indentation, double quotes, semicolons, trailing commas where prettier-like.
- Prefer small, named functions with JSDoc types over clever one-liners.
- Comments explain *why*, not *what*.
- Do not reformat unrelated files in a feature PR.

## Local checks

```bash
npm run check && npm test
```

Both must pass before opening a pull request. If you touched docs, mention which files changed in
the PR description.

## Reporting bugs

Include:

1. `lollm version` and Node version.
2. The command or request that failed.
3. The model reference (name, source, quantization) and whether it was pulled or imported.
4. Logs from `lollm serve --verbose`.

Never paste full model licenses or private prompts; redact what is sensitive.
