#!/bin/bash
# setup/core/02-claude-cli.sh — Claude Code CLI
set -e
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

if command -v claude >/dev/null 2>&1; then
  ok "Claude CLI уже установлен: $(claude --version 2>/dev/null | head -1)"
  log "Для обновления: npm install -g @anthropic-ai/claude-code@latest"
else
  log "Устанавливаю Claude Code CLI..."
  npm install -g @anthropic-ai/claude-code

  if command -v claude >/dev/null; then
    ok "Claude CLI установлен: $(claude --version 2>/dev/null | head -1)"
  else
    fatal "Установка не удалась. Попробуйте вручную: npm install -g @anthropic-ai/claude-code"
  fi
fi

log "Первый запуск требует авторизации в Anthropic Console."
log "Откройте: claude"
log "И следуйте инструкциям на экране."
