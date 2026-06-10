#!/bin/bash
# Модуль claude-mem: кросс-сессионная память для Claude через плагин thedotmack/claude-mem
set -e
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

log "Установка модуля: claude-mem (память между сессиями)"

# 1. Node + Bun — нужны для worker'а плагина (v13 запускает воркер через bun-runner.js).
ensure_node
ensure_bun || warn "Bun не установлен — worker не сможет стартовать (поставьте: npm install -g bun)"

# 2. Установка плагина через marketplace thedotmack.
# Прямой `claude plugin install thedotmack/claude-mem` падает с
# "not found in any configured marketplace" — сначала ДОЛЖЕН быть marketplace.
install_claude_plugin "claude-mem" "thedotmack" "thedotmack/claude-mem" || \
  fatal "Не удалось установить claude-mem. Установите вручную и перезапустите модуль."

# 3. systemd-unit для воркера — иначе после reboot или kill -9 он не поднимется.
log "▸ Устанавливаю wrapper /opt/claude-mem/run-worker.sh"
ensure_dir /opt/claude-mem 755
install -m 0755 "$KIT_DIR/tools/claude-mem/run-worker.sh" /opt/claude-mem/run-worker.sh

log "▸ Устанавливаю systemd-unit claude-mem-worker"
TARGET_USER="${SUDO_USER:-root}"
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
[ -z "$TARGET_HOME" ] && TARGET_HOME="${HOME:-/root}"
install_systemd_unit "claude-mem-worker" \
  "$KIT_DIR/systemd/claude-mem-worker.service.template" \
  "USER=$TARGET_USER" \
  "HOME_DIR=$TARGET_HOME"

systemctl enable claude-mem-worker.service
systemctl restart claude-mem-worker.service
sleep 3

# 4. Проверка работоспособности
if curl -sS http://127.0.0.1:37700/api/health 2>/dev/null | grep -q '"status":"ok"'; then
  ok "claude-mem работает на порту 37700"
else
  warn "claude-mem пока не отвечает. Логи: journalctl -u claude-mem-worker -n 50"
fi

# 5. Включить semantic injection в settings.json (если ещё нет)
SETTINGS="${HOME:-/root}/.claude/settings.json"
if [ -f "$SETTINGS" ]; then
  python3 - <<EOF
import json, pathlib
p = pathlib.Path("$SETTINGS")
s = json.loads(p.read_text())
cm = s.setdefault("claudeMem", {})
cm.setdefault("enabled", True)
cm.setdefault("semanticInject", True)
p.write_text(json.dumps(s, indent=2))
EOF
  ok "claude-mem включён в settings.json"
fi

cat <<EOF

${BOLD}${GREEN}✓ Модуль claude-mem установлен${NC}

Что работает:
  • systemd-unit claude-mem-worker (Restart=always, enabled)
  • Локальный воркер на 127.0.0.1:37700
  • SQLite + Chroma векторная БД в ~/.claude-mem/
  • Семантический recall похожего контекста при новой сессии

Команды:
  • Логи:    journalctl -u claude-mem-worker -f
  • Статус:  systemctl status claude-mem-worker
  • Health:  curl http://127.0.0.1:37700/api/health

Конфиденциальность:
  Вся память локальная. Ничего наружу не уходит.
  Исключить проекты — в ~/.claude/settings.json:
    "claudeMem": { "excludedProjects": ["имя-проекта"] }

EOF
