variable "REGISTRY" {
  default = "ghcr.io/araneadev"
}

variable "VERSION" {
  default = "dev"
}

group "default" {
  targets = ["typescript", "python", "rust", "php"]
}

group "local" {
  targets = ["typescript-local", "python-local", "rust-local", "php-local"]
}

target "_common" {
  platforms = ["linux/amd64", "linux/arm64"]
}

target "_local" {
  platforms = ["linux/amd64"]
  output = ["type=docker"]
}

target "typescript" {
  inherits = ["_common"]
  context = "."
  dockerfile = "containers/typescript/Dockerfile"
  tags = ["${REGISTRY}/chaos-mcp-typescript:${VERSION}"]
}

target "python" {
  inherits = ["_common"]
  context = "."
  dockerfile = "containers/python/Dockerfile"
  tags = ["${REGISTRY}/chaos-mcp-python:${VERSION}"]
}

target "rust" {
  inherits = ["_common"]
  context = "."
  dockerfile = "containers/rust/Dockerfile"
  tags = ["${REGISTRY}/chaos-mcp-rust:${VERSION}"]
}

target "php" {
  inherits = ["_common"]
  context = "."
  dockerfile = "containers/php/Dockerfile"
  tags = ["${REGISTRY}/chaos-mcp-php:${VERSION}"]
}

target "typescript-local" {
  inherits = ["typescript", "_local"]
}

target "python-local" {
  inherits = ["python", "_local"]
}

target "rust-local" {
  inherits = ["rust", "_local"]
}

target "php-local" {
  inherits = ["php", "_local"]
}
