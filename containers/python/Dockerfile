FROM python:3.13.5-slim-bookworm@sha256:4c2cf9917bd1cbacc5e9b07320025bdb7cdf2df7b0ceaccb55e9dd7e30987419

ARG COSMIC_RAY_VERSION=8.4.6

RUN python -m pip install --no-cache-dir \
      "cosmic-ray==${COSMIC_RAY_VERSION}" \
      "pytest==8.4.1" \
    && chmod -R a+rX /usr/local/lib/python3.13/site-packages

LABEL org.opencontainers.image.source="https://github.com/AraneaDev/Chaos-MCP" \
      org.opencontainers.image.description="Pinned Python mutation runner for Chaos-MCP"

WORKDIR /workspace
CMD ["sh", "-c", "while :; do sleep 3600; done"]
