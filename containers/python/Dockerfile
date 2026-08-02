FROM python:3.13.5-slim-bookworm@sha256:4c2cf9917bd1cbacc5e9b07320025bdb7cdf2df7b0ceaccb55e9dd7e30987419

# procps supplies `ps`, absent from the slim base but a POSIX baseline that test
# tooling assumes; its absence broke StrykerJS in the TypeScript image and the
# same class of failure is open to any suite these sandboxes run.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends procps \
    && rm -rf /var/lib/apt/lists/*

COPY containers/python/requirements.txt /opt/chaos-runner/requirements.txt

RUN python -m pip install --no-cache-dir \
      --require-hashes \
      --requirement /opt/chaos-runner/requirements.txt \
    && chmod -R a+rX /usr/local/lib/python3.13/site-packages

LABEL org.opencontainers.image.source="https://github.com/AraneaDev/Chaos-MCP" \
      org.opencontainers.image.description="Pinned Python mutation runner for Chaos-MCP"

WORKDIR /workspace
CMD ["sh", "-c", "while :; do sleep 3600; done"]
