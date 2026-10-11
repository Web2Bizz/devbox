#!/bin/sh
set -e

mkdir -p /root/.ssh /root/.secrets
chmod 700 /root/.ssh /root/.secrets
chmod 600 /root/.secrets/* 2>/dev/null || true

# автозагрузка секретов для mcp-серверов и opencode: ~/.secrets/*.env
if [ -d /root/.secrets ]; then
  for f in /root/.secrets/.env /root/.secrets/*.env; do
    [ -f "$f" ] || continue
    echo "=== loading secrets from $f"
    set -a
    # shellcheck disable=SC1090
    . "$f"
    set +a
  done
fi

if [ ! -e /root/.ssh/id_ed25519 ] && [ ! -e /root/.ssh/id_rsa ]; then
  ssh-keygen -t ed25519 -N "" -C "opencode-cloud" -f /root/.ssh/id_ed25519
  echo "=== add this key to GitHub (Settings -> SSH and GPG keys):"
  cat /root/.ssh/id_ed25519.pub
fi

if [ ! -f /root/.ssh/config ]; then
  printf '%s\n' 'Host *' '  StrictHostKeyChecking accept-new' > /root/.ssh/config
  chmod 600 /root/.ssh/config
fi
chmod 600 /root/.ssh/id_ed25519 /root/.ssh/id_rsa 2>/dev/null || true

pm2 delete opencode 2>/dev/null || true

pm2 start "cd /workspace && opencode serve --port 4096 --hostname 0.0.0.0" --name opencode

pm2 save
exec pm2 logs opencode --lines 0
