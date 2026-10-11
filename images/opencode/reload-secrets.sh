#!/bin/sh
# Перечитывает ~/.secrets/*.env и перезапускает только opencode (без рестарта контейнера).
# Использование внутри контейнера: reload-secrets
# С хоста: docker exec opencode-dev reload-secrets
set -e

SECRETS_DIR="/root/.secrets"

mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"
chmod 600 "$SECRETS_DIR"/* 2>/dev/null || true

loaded=0
for f in "$SECRETS_DIR/.env" "$SECRETS_DIR"/*.env; do
  [ -f "$f" ] || continue
  echo "=== loading secrets from $f"
  set -a
  # shellcheck disable=SC1090
  . "$f"
  set +a
  loaded=1
done

if [ "$loaded" = "0" ]; then
  echo "=== no secret files found in $SECRETS_DIR (.env / *.env)"
fi

if pm2 describe opencode >/dev/null 2>&1; then
  echo "=== restarting opencode with updated env"
  pm2 restart opencode --update-env
else
  echo "=== opencode not running, starting it"
  pm2 start "cd /workspace && opencode serve --port 4096 --hostname 0.0.0.0" --name opencode
fi

pm2 save
echo "=== done"
