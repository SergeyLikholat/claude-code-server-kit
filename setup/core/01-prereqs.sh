#!/bin/bash
# setup/core/01-prereqs.sh — системные пакеты
set -e
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

log "Обновляю apt index..."
DEBIAN_FRONTEND=noninteractive apt-get update -qq

log "Устанавливаю базовые пакеты..."
apt_install \
  curl wget git \
  python3 python3-pip python3-venv \
  jq \
  build-essential \
  ca-certificates \
  ufw \
  tmux htop ncdu \
  unzip \
  sqlite3

# Node.js (нужен для Claude Code CLI и многих tools)
if ! command -v node >/dev/null || [ "$(node -v 2>/dev/null | grep -oE '[0-9]+' | head -1)" -lt 20 ]; then
  log "Устанавливаю Node.js 20.x..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt_install nodejs
fi

ok "Системные пакеты установлены"
log "Node:   $(node -v 2>/dev/null || echo нет)"
log "Python: $(python3 --version 2>/dev/null || echo нет)"
log "Git:    $(git --version | awk '{print $3}')"
