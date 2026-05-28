FROM mcr.microsoft.com/devcontainers/typescript-node:22

# Install system dependencies
RUN apt-get update && apt-get install -y \
    sqlite3 \
    git \
    curl \
    vim \
    procps \
    htop \
    lsof \
    net-tools \
    iputils-ping \
    wget \
    jq \
    less \
    tree \
    ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Install Zellij (terminal multiplexer)
RUN ZELLIJ_VERSION=0.43.1 && \
    curl -L "https://github.com/zellij-org/zellij/releases/download/v${ZELLIJ_VERSION}/zellij-x86_64-unknown-linux-musl.tar.gz" | \
    tar -xz -C /usr/local/bin && \
    chmod +x /usr/local/bin/zellij && \
    zellij --version

# Install GitHub CLI (gh)
# Pinned to v2.93.0 for reproducibility (avoid GitHub API rate limits during build)
RUN GH_VERSION=2.93.0 && \
    curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" | \
    tar -xz -C /tmp && \
    mv /tmp/gh_${GH_VERSION}_linux_amd64/bin/gh /usr/local/bin/ && \
    rm -rf /tmp/gh_${GH_VERSION}_linux_amd64

# Install pnpm (for developers who want to build from source)
# and agor-live from npm for quick start
# NOTE: Using @latest for devcontainer to always get newest versions
RUN npm install -g pnpm@latest agor-live@latest @anthropic-ai/claude-code@latest @google/gemini-cli@latest @openai/codex@latest @opencode-ai/cli@latest

WORKDIR /workspaces

# Note: Source code is available in /workspaces/agor for development
# To develop on Agor itself: cd /workspaces/agor && pnpm install && pnpm build
# Otherwise, the globally installed agor-live is used
