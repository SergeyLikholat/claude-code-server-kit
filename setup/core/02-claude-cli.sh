#!/bin/bash
# setup/core/02-claude-cli.sh — Claude Code CLI
set -e
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

# Всегда свежая версия: без явного @latest npm ставил устаревшую сборку (2.1.197 при актуальной
# 2.1.28x), и Claude отказывался запускаться — «версия устарела». --allow-scripts: npm 12 по
# умолчанию не выполняет postinstall, а он у claude-code докладывает нативный бинарник.
NPM_ARGS=(install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@latest)

if command -v claude >/dev/null 2>&1; then
  log "Claude CLI уже установлен: $(claude --version 2>/dev/null | head -1) — обновляю до последней"
else
  log "Устанавливаю Claude Code CLI..."
fi
npm "${NPM_ARGS[@]}" || fatal "Установка не удалась. Попробуйте вручную: npm ${NPM_ARGS[*]}"
hash -r

if command -v claude >/dev/null; then
  ok "Claude CLI: $(claude --version 2>/dev/null | head -1)"
else
  fatal "claude не найден после установки. Попробуйте вручную: npm ${NPM_ARGS[*]}"
fi
