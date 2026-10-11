FROM node:24-slim

# --- системные зависимости ---
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl git ca-certificates gnupg build-essential python3 openssh-client unzip vim \
    && rm -rf /var/lib/apt/lists/*

# --- GitHub CLI ---
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# --- ngrok ---
RUN curl -sSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc \
    | tee /etc/apt/trusted.gpg.d/ngrok.asc > /dev/null \
    && echo "deb https://ngrok-agent.s3.amazonaws.com buster main" \
    | tee /etc/apt/sources.list.d/ngrok.list > /dev/null \
    && apt-get update && apt-get install -y ngrok && rm -rf /var/lib/apt/lists/*

# --- pnpm через corepack ---
RUN corepack enable && corepack prepare pnpm@latest --activate
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:/root/.local/bin:/root/.bun/bin:/root/.opencode/bin:$PATH"
RUN pnpm config set store-dir /pnpm/store --global

# --- bun (для bunx) ---
RUN curl -fsSL https://bun.sh/install | bash

# --- opencode (standalone-бинарник, не зависит от node/bun в рантайме) ---
ARG OPENCODE_VERSION=1.18.32
RUN curl -fsSL https://opencode.ai/install | bash -s -- --version ${OPENCODE_VERSION}

# --- git identity ---
RUN git config --system user.name "letnull19a" \
    && git config --system user.email "letnull19a@gmail.com"

# --- opencode global config: доступ только к /workspace + host-ключ github.com ---
RUN mkdir -p /root/.config/opencode && printf '%s\n' \
    '{' \
    '  "$schema": "https://opencode.ai/config.json",' \
    '  "permission": {' \
    '    "external_directory": { "*": "deny", "/workspace": "allow", "/workspace/**": "allow" }' \
    '  }' \
    '}' > /root/.config/opencode/opencode.json \
    && printf '%s\n' 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl' > /etc/ssh/ssh_known_hosts

# --- глобальные CLI-инструменты ---
RUN npm i -g typescript pm2 @nestjs/cli vite vitest @rspack/cli @playwright/test

# --- прогрев pnpm store библиотеками, которые проекты подтянут сами ---
RUN mkdir -p /tmp/warmup && cd /tmp/warmup && pnpm init \
    && pnpm add -D zod @trpc/server @trpc/client zustand next \
       @nestjs/core @nestjs/common \
    && cd / && rm -rf /tmp/warmup

# --- playwright browsers ---
ENV PLAYWRIGHT_BROWSERS_PATH=/playwright-browsers
RUN npx playwright install --with-deps chromium

# --- entrypoint: pm2 держит opencode serve живым между рестартами ---
COPY entrypoint.sh /entrypoint.sh
COPY reload-secrets.sh /usr/local/bin/reload-secrets
RUN chmod +x /entrypoint.sh /usr/local/bin/reload-secrets

WORKDIR /workspace
CMD ["/entrypoint.sh"]
