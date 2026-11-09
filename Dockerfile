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
#   APP_USER/APP_UID/APP_GID  Non-root user for opt-in rootless projects
#                              (default ubuntu/1000/1000, the base image user;
#                              root pods ignore it)

ARG BASE_IMAGE=ubuntu:26.04
FROM ${BASE_IMAGE}

ARG NODE_VERSION=26
ARG EXTRA_APT_PACKAGES=""
ARG EXTRA_NPM_PACKAGES=""
ARG INSTALL_PLAYWRIGHT=true
ARG APP_USER=ubuntu
ARG APP_UID=1000
ARG APP_GID=1000

ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/usr/lib/playwright-browsers

# --- Base tooling -----------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl wget gnupg git \
        openssh-server passwd \
        build-essential \
        htop vim nano less tree unzip zip rsync \
        jq fd-find ripgrep \
        iputils-ping bind9-dnsutils \
        ${EXTRA_APT_PACKAGES} \
    && ( [ -x /usr/bin/fd-find ] && ln -sf /usr/bin/fd-find /usr/local/bin/fd \
         || ln -sf /usr/bin/fdfind /usr/local/bin/fd ) \
    && rm -rf /var/lib/apt/lists/*

# --- Non-root user (rootless mode) ------------------------------------------
# One image serves both modes: root pods keep the historical root path and
# rootless pods set runAsUser to this user. Tooling is installed for both
# homes; the entrypoint branches on the effective UID at start.
RUN if id -u "${APP_USER}" >/dev/null 2>&1; then \
        existing_uid="$(id -u "${APP_USER}")"; existing_gid="$(id -g "${APP_USER}")"; \
        if [ "$existing_uid" != "${APP_UID}" ] || [ "$existing_gid" != "${APP_GID}" ]; then \
            echo "APP_USER ${APP_USER} exists as ${existing_uid}:${existing_gid}, not ${APP_UID}:${APP_GID}; pick matching build args" >&2; \
            exit 1; \
        fi; \
    elif getent passwd "${APP_UID}" >/dev/null; then \
        echo "APP_UID ${APP_UID} is already used by $(getent passwd "${APP_UID}" | cut -d: -f1); reuse that user name or pick a free APP_UID" >&2; \
        exit 1; \
    else \
        if ! getent group "${APP_GID}" >/dev/null; then groupadd --gid "${APP_GID}" "${APP_USER}"; fi; \
        useradd --uid "${APP_UID}" --gid "${APP_GID}" --create-home --shell /bin/bash "${APP_USER}"; \
    fi \
    && mkdir -p "/home/${APP_USER}/.ssh" "/home/${APP_USER}/.config" "/home/${APP_USER}/.npm-global" \
    && touch "/home/${APP_USER}/.ssh/authorized_keys" \
    && chmod 700 "/home/${APP_USER}/.ssh" \
    && chmod 600 "/home/${APP_USER}/.ssh/authorized_keys" \
    && chown -R "${APP_UID}:${APP_GID}" "/home/${APP_USER}" \
    && { gpasswd -d "${APP_USER}" sudo >/dev/null 2>&1 || true; }

# --- Node.js (NodeSource) ---------------------------------------------------
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*
# Rootless: send runtime `npm install -g` into the user's writable prefix.
RUN su -l -s /bin/bash "${APP_USER}" -c 'npm config set prefix "$HOME/.npm-global"'

# --- Package managers -------------------------------------------------------
# corepack exposes pnpm/yarn (and npm) shims that honor each repo's
# packageManager pin (e.g. "pnpm@11.6.0"); a repo pin not matching the
# pre-fetched versions is still downloaded on first use. Pre-fetch the
# current pnpm/yarn (incl. pnpm's native binary, pulled on first run) at
# build time so first use inside a pod is offline-fast.
# NOTE: Node 25+ no longer ships corepack, so install it via npm first.
RUN npm install -g corepack@latest \
    && corepack enable \
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
# opencode (V2 installer replaces the V1 binary; installer adds PATH for interactive shells only; ENV + profile.d
# cover non-interactive shells and login shells)
RUN curl -fsSL https://opencode.ai/v2/install | bash
ENV PATH="/root/.opencode/bin:${PATH}"
RUN printf 'export PATH="/root/.opencode/bin:$PATH"\n' > /etc/profile.d/opencode.sh
# Rootless: install the same CLI into the non-root user's home. The entrypoint
# republishes the image PATH (which includes both homes) for SSH sessions.
RUN su -l -s /bin/bash "${APP_USER}" -c 'curl -fsSL https://opencode.ai/v2/install | bash'
# Keep the root path first so root sessions resolve the same binary as before.
ENV PATH="/root/.opencode/bin:/home/${APP_USER}/.opencode/bin:${PATH}"
# pi (pi.dev) - npm method per https://pi.dev/docs/latest/quickstart (installer
# is interactive; npm is Docker-friendly). Requires Node >=22.19 (we install Node 26.x above).
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent \
    && pi --version
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
# The entrypoint lives in ./entrypoint.sh. It branches on the effective UID:
# root keeps the historical /run/sshd + /etc/profile.d path, a non-root user
# starts its own sshd on CODING_CONTAINER_SSH_PORT (default 2222). The sed
# keeps a Windows (CRLF) checkout from baking '\r' into the shebang.
COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

# --- Workspace --------------------------------------------------------------
RUN mkdir -p /workspace && chown "${APP_UID}:${APP_GID}" /workspace

# --- pi config --------------------------------------------------------------
# Pre-create the default agent dir (~/.pi/agent) so tools like Herdr don't
# warn about a missing extensions folder on first run. Pi creates these
# lazily, so an empty dir is the correct "installed properly" state.
RUN mkdir -p /root/.pi/agent/extensions /root/.pi/agent/skills /root/.pi/agent/prompts /root/.pi/agent/themes \
    && mkdir -p "/home/${APP_USER}/.pi/agent/extensions" "/home/${APP_USER}/.pi/agent/skills" "/home/${APP_USER}/.pi/agent/prompts" "/home/${APP_USER}/.pi/agent/themes" \
    && chown -R "${APP_UID}:${APP_GID}" "/home/${APP_USER}/.pi"

# --- opencode config (v2) -----------------------------------------------------
# Server config (opencode.json) + terminal config (cli.json) + custom provider
# options + global agents. Note: v2 no longer reads tui.json (replaced by the
# single global cli.json); the tui.json source file is kept only for rollback.
RUN mkdir -p /root/.config/opencode
COPY opencode/opencode.json /root/.config/opencode/opencode.json
COPY opencode/cli.json /root/.config/opencode/cli.json
COPY opencode/esuyo-opencode-custom-provider.json /root/.config/opencode/esuyo-opencode-custom-provider.json
COPY opencode/agent /root/.config/opencode/agents
# The same defaults for the non-root user, so rootless pods look identical.
COPY opencode/opencode.json /home/${APP_USER}/.config/opencode/opencode.json
COPY opencode/cli.json /home/${APP_USER}/.config/opencode/cli.json
COPY opencode/esuyo-opencode-custom-provider.json /home/${APP_USER}/.config/opencode/esuyo-opencode-custom-provider.json
COPY opencode/agent /home/${APP_USER}/.config/opencode/agents
RUN chown -R "${APP_UID}:${APP_GID}" "/home/${APP_USER}/.config"

WORKDIR /workspace
# Land in /workspace on every interactive login
RUN printf '\ncd /workspace 2>/dev/null || cd ~\n' >> /root/.bashrc \
    && printf '\ncd /workspace 2>/dev/null || cd ~\n' >> /root/.profile \
    && printf '\ncd /workspace 2>/dev/null || cd ~\n' >> "/home/${APP_USER}/.bashrc" \
    && printf '\ncd /workspace 2>/dev/null || cd ~\n' >> "/home/${APP_USER}/.profile" \
    && chown "${APP_UID}:${APP_GID}" "/home/${APP_USER}/.bashrc" "/home/${APP_USER}/.profile"

EXPOSE 22 2222

ENTRYPOINT ["/entrypoint.sh"]
