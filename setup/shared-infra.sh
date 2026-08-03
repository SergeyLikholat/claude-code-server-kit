#!/bin/bash
# setup/shared-infra.sh — общая инфраструктура для V2 multi-user.
#
# Ставит ОДИН раз (под root) то, что разделяется между всеми пользователями:
#   - группы ccusers (общий read) и sharedproj (общие проекты)
#   - /srv/shared/projects (2775, setgid) — общий каталог проектов
#   - глобальный claude CLI (/usr/local/bin/claude)
#   - ECC base в /opt/ecc-base (read-only shared, per-user settings ссылаются туда)
#   - роутер-код в /opt/claude-telegram-router (общий, инстансы per-user через systemd @)
#   - parakeet (опц., общий stateless HTTP-сервис)
#   - bootstrap мастер-credential Claude (для копирования в каждого юзера)
#
# Память (claude-mem) НЕ ставится — в V2 память только per-user obsidian + context-mgr.
#
# Использование: sudo bash setup/shared-infra.sh [--with-parakeet]
set -e
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

require_root

WITH_PARAKEET=false
for arg in "$@"; do
  case "$arg" in
    --with-parakeet) WITH_PARAKEET=true ;;
  esac
done

section "V2 Shared Infra"

# ============================================================
# 1. Группы
# ============================================================
for grp in ccusers sharedproj; do
  if getent group "$grp" >/dev/null; then
    log "Группа $grp уже есть"
  else
    groupadd "$grp"
    ok "Группа $grp создана"
  fi
done

# ============================================================
# 2. Общий каталог проектов (setgid → новые файлы наследуют группу)
# ============================================================
SHARED_PROJECTS="${SHARED_PROJECTS:-/srv/shared/projects}"
ensure_dir "$SHARED_PROJECTS" 2775
chgrp -R sharedproj "$SHARED_PROJECTS" 2>/dev/null || true
chmod 2775 "$SHARED_PROJECTS"
ok "Общие проекты: $SHARED_PROJECTS (root:sharedproj 2775)"

# ============================================================
# 3. Глобальный claude CLI (переиспользуем core-скрипт)
# ============================================================
if command -v claude >/dev/null 2>&1; then
  ok "claude CLI уже установлен: $(command -v claude)"
else
  log "Устанавливаю claude CLI глобально"
  bash "$KIT_DIR/setup/core/02-claude-cli.sh"
fi

# ============================================================
# 4. ECC base → /opt/ecc-base (shared read-only)
# ============================================================
ECC_SHARED="${ECC_SHARED:-/opt/ecc-base}"
log "Устанавливаю ECC base в $ECC_SHARED (shared)"
ECC_DIR="$ECC_SHARED" ECC_INSTALL_TARGET="skip" bash "$KIT_DIR/setup/core/03-ecc-base.sh"
# read-only для группы ccusers, владелец root
chgrp -R ccusers "$ECC_SHARED" 2>/dev/null || true
chmod -R a+rX "$ECC_SHARED"
ok "ECC base shared: $ECC_SHARED (read-only для пользователей)"

# ============================================================
# 5. Роутер-код в /opt/claude-telegram-router (общий)
# ============================================================
ROUTER_DIR="/opt/claude-telegram-router"
ensure_dir /opt 755
if [ ! -d "$ROUTER_DIR" ]; then
  cp -r "$KIT_DIR/tools/claude-telegram-router" "$ROUTER_DIR"
  log "Код роутера → $ROUTER_DIR"
else
  log "$ROUTER_DIR уже существует — обновляю код (кроме node_modules)"
  for f in "$KIT_DIR/tools/claude-telegram-router"/*.js "$KIT_DIR/tools/claude-telegram-router/package.json"; do
    [ -f "$f" ] && cp "$f" "$ROUTER_DIR/$(basename "$f")" 2>/dev/null || true
  done
fi
ensure_node
if [ ! -d "$ROUTER_DIR/node_modules" ]; then
  log "npm install зависимостей роутера..."
  (cd "$ROUTER_DIR" && npm install --production --silent 2>&1 | tail -3) || warn "npm install вернул ошибку"
fi
chmod -R a+rX "$ROUTER_DIR"
ok "Роутер-код shared: $ROUTER_DIR"

# ============================================================
# 6. context-mgr код в /opt/context-mgr (общий, конфиг per-user)
# ============================================================
CTXMGR_DIR="/opt/context-mgr"
if [ -d "$KIT_DIR/tools/context-mgr" ]; then
  if [ ! -d "$CTXMGR_DIR" ]; then
    cp -r "$KIT_DIR/tools/context-mgr" "$CTXMGR_DIR"
  else
    cp "$KIT_DIR/tools/context-mgr/"*.js "$CTXMGR_DIR/" 2>/dev/null || true
  fi
  chmod -R a+rX "$CTXMGR_DIR"
  ok "context-mgr код shared: $CTXMGR_DIR"
fi

# ============================================================
# 7. Parakeet (опционально, общий)
# ============================================================
if [ "$WITH_PARAKEET" = "true" ]; then
  log "Устанавливаю parakeet (shared)"
  bash "$KIT_DIR/setup/modules/parakeet.sh" || warn "parakeet установка вернула ошибку"
fi

# ============================================================
# 8. Bootstrap мастер-credential
# ============================================================
MASTER_CRED="/root/.claude/.credentials.json"
echo
if [ -f "$MASTER_CRED" ]; then
  ok "Мастер-credential найден: $MASTER_CRED (будет копироваться юзерам в provision-user.sh)"
else
  warn "Мастер-credential НЕ найден ($MASTER_CRED)."
  echo "  Авторизуйтесь один раз под root:  claude   (пройдите OAuth)"
  echo "  Затем provision-user.sh скопирует credential каждому пользователю."
fi

cat <<EOF

${BOLD}${GREEN}✓ Shared infra установлена${NC}

Дальше — на каждого пользователя:
  sudo bash setup/provision-user.sh <username>

Защита админа:
  sudo bash setup/harden-admin.sh

Подписка: один Anthropic-аккаунт используется всеми «мирами» (общий
credential). Лимиты подписки — общие на всех. См. docs/V2-MULTIUSER.md.
EOF
