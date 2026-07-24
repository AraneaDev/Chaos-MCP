FROM python:3.13.5-slim-bookworm@sha256:4c2cf9917bd1cbacc5e9b07320025bdb7cdf2df7b0ceaccb55e9dd7e30987419

COPY containers/python/requirements.txt /opt/chaos-runner/requirements.txt

RUN python -m pip install --no-cache-dir \
      --require-hashes \
      --requirement /opt/chaos-runner/requirements.txt \
    && chmod -R a+rX /usr/local/lib/python3.13/site-packages

LABEL org.opencontainers.image.source="https://github.com/AraneaDev/Chaos-MCP" \
      org.opencontainers.image.description="Pinned Python mutation runner for Chaos-MCP"

WORKDIR /workspace
CMD ["sh", "-c", "while :; do sleep 3600; done"]
