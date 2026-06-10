#!/usr/bin/env bash
# Wrapper для запуска claude-mem worker через systemd.
# Автоматически находит самую свежую установленную версию плагина —
# выживает при `claude plugin update claude-mem`.
set -e

CACHE_DIR="${HOME:-/root}/.claude/plugins/cache/thedotmack/claude-mem"
if [ ! -d "$CACHE_DIR" ]; then
  echo "claude-mem plugin not installed in $CACHE_DIR" >&2
  echo "Run: claude plugin marketplace add thedotmack/claude-mem && claude plugin install claude-mem@thedotmack" >&2
  exit 1
fi

LATEST="$(ls -1v "$CACHE_DIR" | tail -1)"
WORKER="$CACHE_DIR/$LATEST/scripts/worker-service.cjs"

if [ ! -f "$WORKER" ]; then
  echo "worker-service.cjs not found in $CACHE_DIR/$LATEST/scripts/" >&2
  exit 1
fi

# Скрипт имеет shebang #!/usr/bin/env bun — вызываем bun явно
# (в systemd PATH урезанный, лучше абсолютным путём при наличии).
BUN="$(command -v bun || true)"
if [ -z "$BUN" ]; then
  echo "bun not found. Install: npm install -g bun" >&2
  exit 1
fi

exec "$BUN" "$WORKER" --daemon
