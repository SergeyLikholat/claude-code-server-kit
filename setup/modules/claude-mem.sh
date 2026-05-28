#!/bin/bash
# Модуль claude-mem: кросс-сессионная память для Claude через плагин thedotmack/claude-mem
set -e
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

log "Установка модуля: claude-mem (память между сессиями)"

# Проверка что Claude установлен
command -v claude >/dev/null || { err "Сначала установите core: sudo bash install.sh"; exit 1; }

# claude-mem ставится как плагин Claude Code через marketplace
log "Устанавливаю плагин claude-mem..."
claude plugin install thedotmack/claude-mem 2>&1 | tail -10 || warn "Установка плагина не удалась — возможно уже установлен"

# Проверка работоспособности
sleep 2
if curl -sS http://127.0.0.1:37700/api/health 2>/dev/null | grep -q '"status":"ok"'; then
  ok "claude-mem работает на порту 37700"
else
  warn "claude-mem ещё не отвечает. Запустите claude один раз, чтобы плагин активировался."
fi

# Включить semantic injection в settings.json
SETTINGS="/root/.claude/settings.json"
if [ -f "$SETTINGS" ]; then
  python3 -c "
import json
with open('$SETTINGS') as f:
    s = json.load(f)
s.setdefault('claudeMem', {})
s['claudeMem']['enabled'] = True
s['claudeMem']['semanticInject'] = True
with open('$SETTINGS', 'w') as f:
    json.dump(s, f, indent=2)
" && ok "claude-mem включён в settings.json"
fi

# Конфиденциальность
cat <<EOF

${BOLD}${GREEN}✓ Модуль claude-mem установлен${NC}

Что работает:
  • Локальный воркер на 127.0.0.1:37700 (не доступен извне)
  • SQLite + Chroma векторная БД в ~/.claude-mem/
  • Каждая сессия автоматически сохраняется
  • При новой сессии — semantic recall похожего контекста

Конфиденциальность:
  Вся память локальная. Ничего наружу не уходит.
  Чтобы не сохранять определённые проекты — в ~/.claude/settings.json:
    "claudeMem": { "excludedProjects": ["имя-проекта"] }

UI (если хотите смотреть содержимое памяти):
  http://localhost:37700  (через SSH tunnel или Caddy reverse proxy)

EOF
