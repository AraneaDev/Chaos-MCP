variable "REGISTRY" {
  default = "ghcr.io/araneadev"
}

variable "VERSION" {
  default = "dev"
}

group "default" {
  targets = ["typescript", "python", "rust", "php"]
}

target "_common" {
  platforms = ["linux/amd64", "linux/arm64"]
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
