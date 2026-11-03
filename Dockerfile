# lollm — Ollama-compatible LLM server on llama.cpp
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    LOLLM_HOST=0.0.0.0 \
    LOLLM_PORT=11434 \
    LOLLM_HOME=/data

WORKDIR /app

# Dependencies first for better layer caching. node-llama-cpp downloads its
# prebuilt llama.cpp binaries here; on unsupported platforms install them
# manually or switch to the mock backend.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY bin ./bin
COPY src ./src
COPY web ./web

# Model store lives on a volume: /data/models/{blobs,manifests}
VOLUME ["/data"]
EXPOSE 11434

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.LOLLM_PORT || 11434) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["node", "bin/lollm.mjs"]
CMD ["serve"]
