FROM node:22.18.0-bookworm-slim@sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e

COPY containers/typescript/package.json containers/typescript/package-lock.json /opt/chaos-runner/

RUN cd /opt/chaos-runner \
    && npm ci --omit=dev \
    && npm cache clean --force \
    && chmod -R a+rX /opt/chaos-runner

ENV PATH="/opt/chaos-runner/node_modules/.bin:${PATH}"

LABEL org.opencontainers.image.source="https://github.com/AraneaDev/Chaos-MCP" \
      org.opencontainers.image.description="Pinned TypeScript/JavaScript mutation runner for Chaos-MCP"

WORKDIR /workspace
CMD ["sh", "-c", "while :; do sleep 3600; done"]
