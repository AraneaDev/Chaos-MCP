FROM rust:1.94.0-slim-bookworm@sha256:a86cada82e36ebd7a9bffed7548792c55a952fdb20718eea9278a936bcb76e62 AS builder

ARG CARGO_MUTANTS_VERSION=27.1.0

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates pkg-config libssl-dev \
    && cargo install --locked --version "${CARGO_MUTANTS_VERSION}" cargo-mutants

FROM rust:1.94.0-slim-bookworm@sha256:a86cada82e36ebd7a9bffed7548792c55a952fdb20718eea9278a936bcb76e62

# procps supplies `ps`, absent from the slim base but a POSIX baseline that test
# tooling assumes; its absence broke StrykerJS in the TypeScript image and the
# same class of failure is open to any suite these sandboxes run.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git pkg-config libssl3 procps \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/local/cargo/bin/cargo-mutants /usr/local/bin/cargo-mutants

LABEL org.opencontainers.image.source="https://github.com/AraneaDev/Chaos-MCP" \
      org.opencontainers.image.description="Pinned Rust mutation runner for Chaos-MCP"

WORKDIR /workspace
CMD ["sh", "-c", "while :; do sleep 3600; done"]
