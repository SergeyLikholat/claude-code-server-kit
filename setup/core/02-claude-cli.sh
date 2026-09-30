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

if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  log "Вход в подписку: токен из secrets.env (CLAUDE_CODE_OAUTH_TOKEN) — отдельный вход не нужен."
else
  log "Первый запуск требует входа в подписку Claude."
  log "Откройте: claude  (или на сервере без браузера: claude setup-token → secrets.env)"
  log "И следуйте инструкциям на экране."
fi
