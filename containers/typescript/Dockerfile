FROM node:22.18.0-bookworm-slim@sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e

# `ps` is absent from the slim base but a POSIX baseline that test tooling
# assumes: Vite — reached through @stryker-mutator/vitest-runner — shells out to
# it, and without it StrykerJS dies with `spawn ps ENOENT` before the first
# mutant runs. These images sandbox arbitrary project suites, so the utilities
# those suites take for granted have to be present.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends procps \
    && rm -rf /var/lib/apt/lists/*

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
