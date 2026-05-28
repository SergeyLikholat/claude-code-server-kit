#!/bin/bash
# Модуль hooks-extras: дополнительные хуки и автоматизации для Claude
set -e
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

log "Установка модуля: hooks-extras"

HOOKS_DIR="/root/.claude/hooks"
ensure_dir "$HOOKS_DIR" 755

# Копируем generic хуки из kit'а
if [ -d "$KIT_DIR/claude-config/hooks-extras" ]; then
  for hook in "$KIT_DIR/claude-config/hooks-extras"/*; do
    [ -f "$hook" ] || continue
    name=$(basename "$hook")
    if [ ! -f "$HOOKS_DIR/$name" ]; then
      cp "$hook" "$HOOKS_DIR/"
      chmod +x "$HOOKS_DIR/$name"
      ok "  + $name"
    else
      warn "  $name уже существует, не перезаписываю"
    fi
  done
fi

cat <<EOF

${BOLD}${GREEN}✓ Модуль hooks-extras установлен${NC}

Хуки в ~/.claude/hooks/ — это скрипты которые запускаются автоматически:
  • PreToolUse  — перед выполнением tool (валидация, блокировка опасного)
  • PostToolUse — после tool (форматирование, проверки)
  • Stop        — при завершении сессии (финальные проверки, commit)
  • SessionStart — при старте новой сессии (загрузка контекста)

Чтобы активировать конкретный хук — добавьте его в ~/.claude/settings.json:
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "command": "/root/.claude/hooks/format-on-save.sh"
      }
    ]
  }
}

Документация по хукам Claude: https://docs.claude.com/en/docs/claude-code/hooks

EOF
