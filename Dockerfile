# agent-mem in Docker. Your agents stay on your computer; install-docker.sh connects them to this container.
# Build: docker build -t agent-mem https://github.com/Abuarchiv/agent-mem.git
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system --add safe.directory '*'
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/

# The agent CLIs that write facts, each logged in once inside the container (`agent-mem login <agent>`).
# They keep their login in /data/cli-home, so the read-only home folder of the host stays untouched.
RUN npm install -g @anthropic-ai/claude-code @openai/codex @github/copilot && npm cache clean --force \
 && mkdir -p /opt/cli-bin \
 && for cli in claude codex copilot; do \
      printf '#!/bin/sh\nHOME=/data/cli-home exec /usr/local/bin/%s "$@"\n' "$cli" > /opt/cli-bin/$cli; \
    done \
 && chmod a+rx /opt/cli-bin/*

ENV UV_TOOL_DIR=/opt/uv/tools UV_TOOL_BIN_DIR=/opt/uv/bin UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    AGENT_MEM_DATA_DIR=/data AGENT_MEM_VIEWER_BIND=0.0.0.0 AGENT_MEM_IN_DOCKER=1
ENV PATH=/opt/cli-bin:/opt/uv/bin:$PATH
COPY . /tmp/agent-mem
RUN uv tool install --python 3.12 "/tmp/agent-mem[semantic,observer]" && rm -rf /tmp/agent-mem /root/.cache \
 && agent-mem models install \
 && mkdir -p /data/cli-home && chmod 700 /data

# The home folder of the host is mounted read-only; the container writes only to this volume.
VOLUME /data
EXPOSE 37778
ENTRYPOINT []
CMD ["agent-mem", "serve", "--quiet"]
