# Chaos-MCP language runners

Each image contains one pinned mutation engine and its language runtime. The
MCP server remains on the host; it mounts only the temporary mutation sandbox
at `/workspace` and executes prebuild and engine commands in one short-lived
container.

| Image                     | Runtime        | Mutation engine      |
| ------------------------- | -------------- | -------------------- |
| `chaos-mcp-typescript`    | Node.js 22.18.0 | StrykerJS 9.6.1     |
| `chaos-mcp-python`        | Python 3.13.5   | Cosmic Ray 8.4.6     |
| `chaos-mcp-rust`          | Rust 1.94.0     | cargo-mutants 27.1.0 |
| `chaos-mcp-php`           | PHP 8.4.10      | Infection 0.34.0     |

Build every local image:

```sh
docker buildx bake
```

Base images and mutation-engine versions are pinned. The runtime configuration
accepts per-language image overrides, including digest-pinned images for
projects that require another runtime version.
