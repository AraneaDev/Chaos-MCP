FROM node:22.18.0-bookworm-slim@sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e

ARG STRYKER_VERSION=9.6.1

RUN npm install --global --omit=dev \
      "@stryker-mutator/core@${STRYKER_VERSION}" \
      "@stryker-mutator/vitest-runner@${STRYKER_VERSION}" \
      "@stryker-mutator/jest-runner@${STRYKER_VERSION}" \
      "@stryker-mutator/mocha-runner@${STRYKER_VERSION}" \
      "@stryker-mutator/jasmine-runner@${STRYKER_VERSION}" \
      "@stryker-mutator/karma-runner@${STRYKER_VERSION}" \
    && npm cache clean --force \
    && chmod -R a+rX /usr/local/lib/node_modules

LABEL org.opencontainers.image.source="https://github.com/AraneaDev/Chaos-MCP" \
      org.opencontainers.image.description="Pinned TypeScript/JavaScript mutation runner for Chaos-MCP"

WORKDIR /workspace
CMD ["sh", "-c", "while :; do sleep 3600; done"]
