#!/bin/bash
# setup/core/03-ecc-base.sh — установка everything-claude-code base (~150 скиллов, агенты, правила)
set -e
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

# ECC_DIR — куда клонировать. Дефолт /root (V1). shared-infra.sh (V2) передаёт
# ECC_DIR=/opt/ecc-base. ECC_INSTALL_TARGET — чей ~/.claude наполнять (или skip).
ECC_DIR="${ECC_DIR:-/root/everything-claude-code}"
ECC_REPO="${ECC_REPO:-https://github.com/affaan-m/everything-claude-code.git}"
ECC_INSTALL_TARGET="${ECC_INSTALL_TARGET:-/root/.claude}"

if [ -d "$ECC_DIR/.git" ]; then
  log "ECC уже склонирован, обновляю..."
  cd "$ECC_DIR" && git pull --ff-only || warn "git pull не удался — возможно есть локальные изменения"
else
  log "Клонирую everything-claude-code (~160 МБ)..."
  git clone --depth 50 "$ECC_REPO" "$ECC_DIR"
fi

ok "ECC base в $ECC_DIR"

# V2 shared-infra: клонируем ECC в /opt/ecc-base как ОБЩИЙ read-only источник,
# а per-user ~/.claude наполнять не нужно (settings ссылаются на /opt/ecc-base
# через subpaths). Передаётся ECC_INSTALL_TARGET=skip.
if [ "$ECC_INSTALL_TARGET" = "skip" ]; then
  ok "ECC только склонирован (shared), per-user установка пропущена"
  log "База доступна как shared: $ECC_DIR"
  return 0 2>/dev/null || exit 0
fi

# Установка ECC в <target>/.claude через его install скрипт (если есть)
if [ -f "$ECC_DIR/install.sh" ] && [ "$ECC_INSTALL_TARGET" = "/root/.claude" ]; then
  log "Запускаю ECC install.sh..."
  cd "$ECC_DIR"
  bash install.sh --skip-prompts 2>&1 | tail -20 || warn "ECC install вернул ошибку (продолжаю)"
else
  log "Устанавливаю ECC в $ECC_INSTALL_TARGET (копирование)"
  ensure_dir "$ECC_INSTALL_TARGET" 755
  for sub in agents skills rules commands; do
    if [ -d "$ECC_DIR/$sub" ]; then
      ensure_dir "$ECC_INSTALL_TARGET/$sub" 755
      # Копируем (а не симлинк — на случай если ECC обновится с breaking changes)
      cp -rn "$ECC_DIR/$sub"/* "$ECC_INSTALL_TARGET/$sub/" 2>/dev/null || true
      local_count=$(ls "$ECC_INSTALL_TARGET/$sub" | wc -l)
      ok "$sub: $local_count items"
    fi
  done
fi

log "База агентов/скиллов в $ECC_INSTALL_TARGET"
