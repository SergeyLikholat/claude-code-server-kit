#!/bin/bash
# setup/core/03-ecc-base.sh — установка everything-claude-code base (~150 скиллов, агенты, правила)
set -e
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

ECC_DIR="/root/everything-claude-code"
ECC_REPO="https://github.com/affaan-m/everything-claude-code.git"

if [ -d "$ECC_DIR/.git" ]; then
  log "ECC уже склонирован, обновляю..."
  cd "$ECC_DIR" && git pull --ff-only || warn "git pull не удался — возможно есть локальные изменения"
else
  log "Клонирую everything-claude-code (~160 МБ)..."
  git clone --depth 50 "$ECC_REPO" "$ECC_DIR"
fi

ok "ECC base в $ECC_DIR"

# Установка ECC в ~/.claude через его install скрипт (если есть)
if [ -f "$ECC_DIR/install.sh" ]; then
  log "Запускаю ECC install.sh..."
  cd "$ECC_DIR"
  bash install.sh --skip-prompts 2>&1 | tail -20 || warn "ECC install вернул ошибку (продолжаю)"
else
  warn "$ECC_DIR/install.sh не найден — устанавливаю вручную (symlinks)"

  ensure_dir /root/.claude 755
  for sub in agents skills rules commands; do
    if [ -d "$ECC_DIR/$sub" ]; then
      ensure_dir "/root/.claude/$sub" 755
      # Копируем (а не симлинк — на случай если ECC обновится с breaking changes)
      cp -rn "$ECC_DIR/$sub"/* "/root/.claude/$sub/" 2>/dev/null || true
      local_count=$(ls "/root/.claude/$sub" | wc -l)
      ok "$sub: $local_count items"
    fi
  done
fi

log "База агентов/скиллов в ~/.claude/"
