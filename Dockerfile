# syntax=docker/dockerfile:1
#
# Coding container: Ubuntu + Node.js + opencode + pi + herdr + playwright + ssh
#
# Adjustable via build args (see config.yaml -> image.buildArgs):
#   BASE_IMAGE          Ubuntu base image
#   NODE_VERSION        Major Node.js version installed via NodeSource
#   EXTRA_APT_PACKAGES  Space separated list of extra apt packages
#   EXTRA_NPM_PACKAGES  Space separated list of extra global npm packages
#   INSTALL_PLAYWRIGHT  "true" (default) or "false"

ARG BASE_IMAGE=ubuntu:26.04
FROM ${BASE_IMAGE}

ARG NODE_VERSION=22
ARG EXTRA_APT_PACKAGES=""
ARG EXTRA_NPM_PACKAGES=""
ARG INSTALL_PLAYWRIGHT=true

ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/usr/lib/playwright-browsers

# --- Base tooling -----------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl wget gnupg git \
        openssh-server \
        build-essential \
        htop vim nano less tree unzip zip rsync \
        jq fd-find ripgrep \
        iputils-ping bind9-dnsutils \
        ${EXTRA_APT_PACKAGES} \
    && ( [ -x /usr/bin/fd-find ] && ln -sf /usr/bin/fd-find /usr/local/bin/fd \
         || ln -sf /usr/bin/fdfind /usr/local/bin/fd ) \
    && rm -rf /var/lib/apt/lists/*

# --- Node.js (NodeSource) ---------------------------------------------------
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# --- Package managers -------------------------------------------------------
# corepack exposes pnpm/yarn (and npm) shims that honor each repo's
# packageManager pin (e.g. "pnpm@11.6.0"); a repo pin not matching the
# pre-fetched versions is still downloaded on first use. Pre-fetch the
# current pnpm/yarn (incl. pnpm's native binary, pulled on first run) at
# build time so first use inside a pod is offline-fast.
RUN corepack enable \
    && corepack prepare pnpm@latest --activate \
    && corepack prepare yarn@latest --activate \
    && pnpm --version >/dev/null \
    && yarn --version >/dev/null

# --- Native module build headers ---------------------------------------------
# Headers for node-gyp / prebuild-install so native npm packages (sharp,
# bcrypt, sqlite3, ...) compile at npm install time instead of failing.
RUN apt-get update && apt-get install -y --no-install-recommends \
        pkg-config \
        zlib1g-dev libssl-dev libpq-dev libsqlite3-dev libffi-dev \
        libxml2-dev libxslt1-dev libpng-dev libbz2-dev liblzma-dev \
        uuid-dev libkrb5-dev libcairo2-dev \
    && rm -rf /var/lib/apt/lists/*

# --- Coding agents / CLIs ---------------------------------------------------
# opencode (installer adds PATH for interactive shells only; ENV + profile.d
# cover non-interactive shells and login shells)
RUN curl -fsSL https://opencode.ai/install | bash
ENV PATH="/root/.opencode/bin:${PATH}"
RUN printf 'export PATH="/root/.opencode/bin:$PATH"\n' > /etc/profile.d/opencode.sh
# pi (pi.dev)
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent
# herdr (https://herdr.dev) - terminal multiplexer/runtime for coding agents.
# Install to /usr/local/bin so it's on PATH for all shells incl. sshd sessions.
RUN curl -fsSL https://herdr.dev/install.sh | HERDR_INSTALL_DIR=/usr/local/bin sh \
    && herdr --version
# turbo (monorepo runner)
RUN npm install -g turbo
# extra global npm packages
RUN if [ -n "${EXTRA_NPM_PACKAGES}" ]; then npm install -g ${EXTRA_NPM_PACKAGES}; fi

# --- Playwright -------------------------------------------------------------
RUN if [ "${INSTALL_PLAYWRIGHT}" = "true" ]; then \
        npm install -g playwright \
        && npx playwright install --with-deps chrome; \
    fi

# --- Database clients -------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
        postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# --- SSH server -------------------------------------------------------------
RUN mkdir -p /root/.ssh && \
    chmod 700 /root/.ssh && \
    touch /root/.ssh/authorized_keys && \
    chmod 600 /root/.ssh/authorized_keys && \
    sed -ri 's/^#?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config && \
    sed -ri 's/^#?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config && \
    sed -ri 's/^#?PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config && \
    ssh-keygen -A
# /run may be a fresh tmpfs at start, so recreate the privsep dir at boot.
# sshd builds each session's environment from scratch (USER/HOME/PATH/SHELL +
# PAM), so the container's env (image ENV + pod spec) is not visible in SSH
# sessions; the entrypoint republishes it for login shells.
RUN cat > /entrypoint.sh <<'ENTRYPOINT' && chmod +x /entrypoint.sh
#!/bin/bash
mkdir -p /run/sshd
: > /etc/profile.d/99-container-env.sh
while IFS= read -r -d '' kv; do
    name=${kv%%=*}
    value=${kv#*=}
    escaped=${value//"'"/"'\\''"}
    printf "export %s='%s'\n" "$name" "$escaped"
done < /proc/self/environ >> /etc/profile.d/99-container-env.sh
exec /usr/sbin/sshd -D "$@"
ENTRYPOINT

# --- Workspace --------------------------------------------------------------
RUN mkdir -p /workspace
WORKDIR /workspace
# Land in /workspace on every interactive login
RUN printf '\ncd /workspace 2>/dev/null || cd ~\n' >> /root/.bashrc \
    && printf '\ncd /workspace 2>/dev/null || cd ~\n' >> /root/.profile

EXPOSE 22

ENTRYPOINT ["/entrypoint.sh"]
