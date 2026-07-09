FROM node:20-bookworm-slim

RUN npm install -g @anthropic-ai/claude-code

ENV HOME=/tmp/nexus-home \
    XDG_CONFIG_HOME=/tmp/nexus-home/.config \
    XDG_DATA_HOME=/tmp/nexus-home/.local/share \
    XDG_CACHE_HOME=/tmp/nexus-home/.cache

WORKDIR /workspace

ENTRYPOINT ["claude"]
