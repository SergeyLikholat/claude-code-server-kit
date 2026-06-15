#!/bin/bash
# setup/harden-admin.sh — защита админ-директорий от пользователей V2.
#
# Закрывает админ-данные правами ОС так, чтобы userA/userB (через Bash-tool
# Claude или SSH) НЕ могли их прочитать. Общие тулы (/opt/*, ecc-base,
# parakeet) остаются доступны на чтение/исполнение.
#
# Использование: sudo bash setup/harden-admin.sh [--admin-user NAME]
#   По умолчанию админ = root. Если завели отдельный sudo-аккаунт — передайте его.
set -e
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

require_root

ADMIN_USER="root"
ADMIN_HOME="/root"
for ((i=1;i<=$#;i++)); do
  case "${!i}" in
    --admin-user) j=$((i+1)); ADMIN_USER="${!j}"; ADMIN_HOME="$(getent passwd "$ADMIN_USER" | cut -d: -f6)" ;;
  esac
done
[ -n "$ADMIN_HOME" ] || fatal "Не найден home для $ADMIN_USER"

section "Hardening админа: $ADMIN_USER ($ADMIN_HOME)"

# ============================================================
# 1. Админ home + секреты — 700/600
# ============================================================
chmod 700 "$ADMIN_HOME"
ok "$ADMIN_HOME → 700"

for d in .secrets .config/rclone .ssh .claude; do
  if [ -d "$ADMIN_HOME/$d" ]; then
    chmod -R go-rwx "$ADMIN_HOME/$d"
    ok "$ADMIN_HOME/$d → закрыт для group/other"
  fi
done
# restic-пароль и подобные — 600
for f in "$ADMIN_HOME"/.secrets/* ; do
  [ -f "$f" ] && chmod 600 "$f"
done 2>/dev/null || true

# ============================================================
# 2. Общие тулы остаются читаемыми (явно НЕ трогаем приватное)
# ============================================================
for d in /opt/ecc-base /opt/claude-telegram-router /opt/context-mgr /opt/parakeet /opt/parakeet-server; do
  [ -d "$d" ] && chmod -R a+rX "$d" 2>/dev/null || true
done
log "Общие тулы оставлены world-readable (/opt/*)"

# ============================================================
# 3. Проверка: пользователи НЕ читают админ-секреты
# ============================================================
echo
section "Verification"
FAIL=0
# найти всех пользователей группы ccusers
USERS="$(getent group ccusers | cut -d: -f4 | tr ',' ' ')"
if [ -z "$USERS" ]; then
  warn "В группе ccusers нет пользователей — проверять некого"
else
  for u in $USERS; do
    # попытка чтения админ-секрета должна провалиться
    if sudo -u "$u" test -r "$ADMIN_HOME/.secrets" 2>/dev/null && \
       sudo -u "$u" ls "$ADMIN_HOME/.secrets" >/dev/null 2>&1; then
      err "$u МОЖЕТ читать $ADMIN_HOME/.secrets — ИЗОЛЯЦИЯ НАРУШЕНА"
      FAIL=1
    else
      ok "$u не читает $ADMIN_HOME/.secrets"
    fi
    if sudo -u "$u" ls "$ADMIN_HOME" >/dev/null 2>&1; then
      err "$u МОЖЕТ листать $ADMIN_HOME — проверьте chmod 700"
      FAIL=1
    else
      ok "$u не листает $ADMIN_HOME"
    fi
    # проверка sudoers
    if sudo -u "$u" sudo -n true 2>/dev/null; then
      err "$u имеет passwordless sudo — УБЕРИТЕ из sudoers"
      FAIL=1
    else
      ok "$u не sudoer"
    fi
    # общий тул должен читаться
    if [ -d /opt/ecc-base ]; then
      sudo -u "$u" test -r /opt/ecc-base && ok "$u читает /opt/ecc-base (shared)" || warn "$u НЕ читает /opt/ecc-base"
    fi
  done
fi

echo
if [ "$FAIL" = "0" ]; then
  ok "Изоляция админа в порядке"
else
  fatal "Найдены нарушения изоляции — см. выше"
fi
