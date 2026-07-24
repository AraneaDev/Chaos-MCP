# Chaos-MCP mutation-engine images

Chaos-MCP publishes one OCI image per supported language. Each image contains
one pinned mutation engine and its language runtime; the MCP server itself
continues to run on the host. This gives users reproducible engine versions
without requiring StrykerJS, Cosmic Ray, cargo-mutants, Infection, or their
language toolchains to be installed globally.

| Image                  | Runtime         | Mutation engine      |
| ---------------------- | --------------- | -------------------- |
| `chaos-mcp-typescript` | Node.js 22.18.0 | StrykerJS 9.6.1      |
| `chaos-mcp-python`     | Python 3.13.5   | Cosmic Ray 8.4.6     |
| `chaos-mcp-rust`       | Rust 1.94.0     | cargo-mutants 27.1.0 |
| `chaos-mcp-php`        | PHP 8.4.10      | Infection 0.34.0     |

Official images are published to `ghcr.io/araneadev` for `linux/amd64` and
`linux/arm64`. Image tags match Chaos-MCP releases. From a source checkout:

```sh
CHAOS_MCP_TAG="v$(node -p "require('./package.json').version")"
docker pull "ghcr.io/araneadev/chaos-mcp-typescript:${CHAOS_MCP_TAG}"
docker pull "ghcr.io/araneadev/chaos-mcp-python:${CHAOS_MCP_TAG}"
docker pull "ghcr.io/araneadev/chaos-mcp-rust:${CHAOS_MCP_TAG}"
docker pull "ghcr.io/araneadev/chaos-mcp-php:${CHAOS_MCP_TAG}"
```

Chaos-MCP chooses the tags matching its own version. Docker and Podman normally
pull a missing image during container creation, but pre-pulling avoids making a
large download compete with the startup timeout. Verify local availability:

```sh
node build/index.js --container-doctor
```

See the main [container execution documentation](../README.md#container-execution)
for configuration, image overrides, security controls, and dependency-mount
behavior.

## Runtime model

For each audit, the server:

1. creates the normal temporary mutation sandbox on the host;
2. creates one short-lived container and mounts only that sandbox at
   `/workspace`;
3. runs the prebuild and mutation commands in the same container; and
4. forcibly removes the container on completion, failure, cancellation, or
   timeout.

The real workspace is never mounted. The container has a read-only root
filesystem, dropped Linux capabilities, `no-new-privileges`, a private `/tmp`,
and bounded CPU, memory, and process counts. Project dependencies remain the
project's responsibility; recognized dependency directories linked into the
sandbox are mounted read-only.

## Local builds

Build all four single-platform images into the local Docker image store:

```sh
docker buildx bake local
```

Bake may build its four targets concurrently. On a resource-constrained host,
build them sequentially:

```sh
docker buildx bake typescript-local
docker buildx bake python-local
docker buildx bake rust-local
docker buildx bake php-local
```

Local images use the `dev` tag by default. Point Chaos-MCP at them explicitly:

```json
{
  "container": {
    "mode": "container",
    "images": {
      "typescript": "ghcr.io/araneadev/chaos-mcp-typescript:dev",
      "python": "ghcr.io/araneadev/chaos-mcp-python:dev",
      "rust": "ghcr.io/araneadev/chaos-mcp-rust:dev",
      "php": "ghcr.io/araneadev/chaos-mcp-php:dev"
    }
  }
}
```

The default Bake group builds multi-platform images for registry publication.
Override `REGISTRY` and `VERSION` for a private registry or test tag:

```sh
REGISTRY=registry.example.com/team VERSION=test docker buildx bake
```

## Reproducibility and publication

Base images, mutation-engine versions, and their dependency graphs are pinned:
npm uses `package-lock.json`, pip requires a fully hashed `requirements.txt`,
Composer uses `composer.lock`, and Cargo installs with `--locked`. The runtime
configuration accepts per-language image overrides, including digest-pinned
images for projects that require another runtime version.

Pull-request CI builds every Dockerfile without publishing it. When Release
Please creates a GitHub release, the release workflow builds all four images
for AMD64 and ARM64, attaches SBOM and provenance attestations, and publishes
the release tag to GHCR.
