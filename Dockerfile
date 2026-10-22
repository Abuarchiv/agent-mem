# agent-mem in Docker. Your agents stay on your computer; install-docker.sh connects them to this container.
# Build: docker build -t agent-mem https://github.com/Abuarchiv/agent-mem.git
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system --add safe.directory '*'
COPY --from=ghcr.io/astral-sh/uv:0.13.5 /uv /usr/local/bin/

# The agent CLIs that write facts, each logged in once inside the container (`agent-mem login <agent>`).
# install-docker.sh passes only the agents found on your computer; each one is 180 to 370 MB.
# They keep their login in /data/cli-home, so the read-only home folder of the host stays untouched.
ARG AGENTS="claude codex copilot opencode"
# Pinned: a new CLI release can change its flags or output; raise these on purpose and rebuild.
ARG CLAUDE_VERSION=2.1.308 CODEX_VERSION=0.163.0 COPILOT_VERSION=1.0.102 OPENCODE_VERSION=2.1.2
RUN mkdir -p /opt/cli-bin \
 && for agent in $AGENTS; do \
      case $agent in \
        claude) npm install -g @anthropic-ai/claude-code@$CLAUDE_VERSION ;; \
        codex) npm install -g @openai/codex@$CODEX_VERSION ;; \
        copilot) npm install -g @github/copilot@$COPILOT_VERSION ;; \
        opencode) curl -fsSL https://opencode.ai/v2/install | HOME=/opt/opencode bash -s -- --version $OPENCODE_VERSION >/dev/null \
                  && ln -s /opt/opencode/.opencode/bin/opencode /usr/local/bin/opencode ;; \
        *) echo "unknown agent $agent" >&2; exit 1 ;; \
      esac || exit 1; \
      printf '#!/bin/sh\nHOME=/data/cli-home exec /usr/local/bin/%s "$@"\n' "$agent" > /opt/cli-bin/$agent; \
    done \
 && npm cache clean --force && chmod -R a+rx /opt/cli-bin

ENV UV_TOOL_DIR=/opt/uv/tools UV_TOOL_BIN_DIR=/opt/uv/bin UV_PYTHON_INSTALL_DIR=/opt/uv/python UV_COMPILE_BYTECODE=1 \
    AGENT_MEM_DATA_DIR=/data AGENT_MEM_MODEL_DIR=/opt/models AGENT_MEM_VIEWER_BIND=0.0.0.0 AGENT_MEM_IN_DOCKER=1
ENV PATH=/opt/cli-bin:/opt/uv/bin:$PATH
COPY . /tmp/agent-mem
RUN uv tool install --python 3.12 "/tmp/agent-mem[semantic,observer]" && rm -rf /tmp/agent-mem /root/.cache \
 && agent-mem models install && rm -rf /data/* \
 && mkdir -p /data/cli-home && chmod 700 /data

# The home folder of the host is mounted read-only; the container writes only to this volume.
VOLUME /data
EXPOSE 37778
ENTRYPOINT []
CMD ["agent-mem", "serve", "--quiet"]
