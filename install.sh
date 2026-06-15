#!/bin/bash
# install.sh — главный orchestrator установки.
#
# Режимы:
#   sudo bash install.sh                    # core (обязательная база)
#   sudo bash install.sh --module NAME      # один модуль
#   sudo bash install.sh --module N1,N2     # несколько модулей
#   sudo bash install.sh --all              # core + все модули
#   sudo bash install.sh --list             # показать доступные модули
#   sudo bash install.sh --check            # проверка что установлено
#   sudo bash install.sh --update           # обновить установленное
#   sudo bash install.sh --non-interactive  # без подсказок (берёт всё из .env)
#
# V2 multi-user (несколько пользователей на одном сервере):
#   sudo bash install.sh --shared-infra            # общая инфра (один раз)
#   sudo bash install.sh --provision-user <name>   # завести пользователя
#   sudo bash install.sh --harden-admin            # защитить админ-директории
#   См. docs/V2-MULTIUSER.md

set -e

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export KIT_DIR
# shellcheck disable=SC1091
source "$KIT_DIR/setup/lib/common.sh"

# ============================================================
# Парсинг аргументов
# ============================================================
MODE=""
MODULES=()
NON_INTERACTIVE=false
SKIP_GEMINI=false
PARAKEET_VARIANT="parakeet"

while [ $# -gt 0 ]; do
  case "$1" in
    --module|--modules)
      shift
      IFS=',' read -ra MODULES <<< "$1"
      MODE="${MODE:-modules}"
      ;;
    --all)
      MODE="all"
      ;;
    --list)
      MODE="list"
      ;;
    --check)
      MODE="check"
      ;;
    --update)
      MODE="update"
      ;;
    --shared-infra)
      MODE="shared-infra"
      ;;
    --provision-user)
      shift
      PROVISION_USER="$1"
      MODE="provision-user"
      ;;
    --harden-admin)
      MODE="harden-admin"
      ;;
    --non-interactive)
      NON_INTERACTIVE=true
      ;;
    --skip-gemini)
      SKIP_GEMINI=true
      ;;
    --variant)
      shift
      PARAKEET_VARIANT="$1"
      ;;
    -h|--help)
      head -20 "$0" | grep -E '^#' | sed 's/^# *//'
      exit 0
      ;;
    *)
      err "Неизвестный аргумент: $1"
      exit 1
      ;;
  esac
  shift
done

# Если режим не задан — core
MODE="${MODE:-core}"

# ============================================================
# Список модулей и их описаний
# ============================================================
declare -A MODULE_DESCRIPTIONS=(
  ["tg-bot"]="Telegram-бот для управления Claude с телефона"
  ["backup"]="Автоматические шифрованные бэкапы на Яндекс.Диск"
  ["parakeet"]="Голосовая транскрипция (Parakeet или GigaAM)"
  ["helpers"]="Полезные мелочи: nanobanana, gemini-tts, openpyxl_safe, tg-md"
  ["hooks-extras"]="Дополнительные хуки и автоматизации"
)

# claude-mem УБРАН из V2: память теперь per-user через obsidian-vault + context-mgr
# (ставится автоматически в provision-user.sh). См. docs/V2-MULTIUSER.md.
ALL_MODULES=("tg-bot" "backup" "parakeet" "helpers" "hooks-extras")

# ============================================================
# Команды
# ============================================================
cmd_list() {
  section "Доступные модули"
  for m in "${ALL_MODULES[@]}"; do
    local installed="—"
    [ -f "/var/lib/claude-code-server-kit/installed-modules" ] && \
      grep -q "^$m$" /var/lib/claude-code-server-kit/installed-modules 2>/dev/null && installed="✓ установлен"

    printf "  %-15s %-12s  %s\n" "$m" "$installed" "${MODULE_DESCRIPTIONS[$m]}"
  done
  echo
  echo "Установить: sudo bash install.sh --module ИМЯ"
  echo "Подробно: см. MODULES.md"
}

cmd_check() {
  section "Состояние установки"

  echo "Core:"
  command -v claude >/dev/null && ok "claude CLI установлен ($(claude --version 2>/dev/null | head -1))" || warn "claude CLI не найден"
  [ -d /root/.claude ] && ok "~/.claude/ существует" || warn "~/.claude/ не найдена"
  { [ -d /opt/ecc-base ] || [ -d /root/everything-claude-code ]; } && ok "ECC base склонирован" || warn "ECC base не найден"

  # V2 multi-user
  if getent group ccusers >/dev/null 2>&1; then
    echo
    echo "V2 multi-user:"
    [ -d /opt/ecc-base ] && ok "shared ECC: /opt/ecc-base" || warn "нет /opt/ecc-base"
    [ -d /srv/shared/projects ] && ok "общие проекты: /srv/shared/projects" || warn "нет /srv/shared/projects"
    local users
    users="$(getent group ccusers | cut -d: -f4)"
    echo "  пользователи ccusers: ${users:-(нет)}"
    for u in ${users//,/ }; do
      for unit in "tg-router@$u" "ctx-mgr-monitor@$u.timer" "ctx-mgr-daily@$u.timer"; do
        local st; st=$(systemctl is-active "$unit" 2>/dev/null || echo n/a)
        printf "    %-28s %s\n" "$unit" "$st"
      done
    done
  fi

  echo
  echo "Модули:"
  for m in "${ALL_MODULES[@]}"; do
    if [ -f "/var/lib/claude-code-server-kit/installed-modules" ] && \
       grep -q "^$m$" /var/lib/claude-code-server-kit/installed-modules 2>/dev/null; then
      ok "$m"
    else
      echo "  ${YELLOW}—${NC} $m (не установлен)"
    fi
  done

  echo
  echo "Демоны:"
  for svc in claude-telegram tg-router parakeet-server backup.timer; do
    if systemctl list-unit-files "${svc}.service" "${svc}.timer" >/dev/null 2>&1; then
      local state
      state=$(systemctl is-active "$svc" 2>/dev/null || echo "n/a")
      case "$state" in
        active) ok "$svc — активен" ;;
        inactive) warn "$svc — остановлен" ;;
        failed) err "$svc — упал" ;;
        *) echo "  $svc — $state" ;;
      esac
    fi
  done

  echo
  echo "Бэкап (последний):"
  if [ -f /var/log/backup-main.log ]; then
    local last_done
    last_done=$(grep "DONE in" /var/log/backup-main.log 2>/dev/null | tail -1)
    [ -n "$last_done" ] && echo "  $last_done" || warn "Бэкап ещё не запускался"
  else
    warn "Лог бэкапа не найден"
  fi
}

cmd_core() {
  require_root
  require_ubuntu

  section "Установка CORE (обязательная база)"

  load_env "$KIT_DIR/.env" 2>/dev/null || true

  for script in \
    "$KIT_DIR/setup/core/01-prereqs.sh" \
    "$KIT_DIR/setup/core/02-claude-cli.sh" \
    "$KIT_DIR/setup/core/03-ecc-base.sh" \
    "$KIT_DIR/setup/core/04-minimal-config.sh"
  do
    if [ -x "$script" ]; then
      log "▸ $(basename "$script")"
      "$script"
    else
      warn "Пропуск (не найден или нет +x): $script"
    fi
  done

  mark_installed "core"

  cat <<EOF

${BOLD}${GREEN}══════════════════════════════════════════════════════════════${NC}
${BOLD}${GREEN}  ✓ Core установлен!                                          ${NC}
${BOLD}${GREEN}══════════════════════════════════════════════════════════════${NC}

Что готово:
  • Claude Code CLI установлен
  • База агентов и скиллов в ~/.claude/
  • Минимальный settings.json

Дальше:
  ${BOLD}claude${NC}                                              — начать работу
  ${BOLD}sudo bash install.sh --list${NC}                         — какие модули доступны
  ${BOLD}sudo bash install.sh --module backup${NC}                — поставить бэкап
  ${BOLD}sudo bash install.sh --module tg-bot${NC}                — поставить Telegram-бота

EOF
}

cmd_modules() {
  require_root

  for m in "${MODULES[@]}"; do
    local script="$KIT_DIR/setup/modules/${m}.sh"
    if [ ! -x "$script" ]; then
      err "Модуль не найден: $m"
      echo "Доступные: ${ALL_MODULES[*]}"
      continue
    fi

    section "Модуль: $m"
    log "${MODULE_DESCRIPTIONS[$m]:-}"
    if "$script"; then
      mark_installed "$m"
    fi
  done
}

cmd_all() {
  cmd_core
  for m in "${ALL_MODULES[@]}"; do
    MODULES=("$m")
    cmd_modules
  done
}

cmd_update() {
  require_root
  section "Обновление установленного"
  log "git pull в kit..."
  cd "$KIT_DIR" && git pull --ff-only

  log "Перезапускаю core..."
  cmd_core

  if [ -f /var/lib/claude-code-server-kit/installed-modules ]; then
    while IFS= read -r m; do
      [ "$m" = "core" ] && continue
      MODULES=("$m")
      cmd_modules
    done < /var/lib/claude-code-server-kit/installed-modules
  fi
}

# ============================================================
# Утилита: отметить модуль как установленный
# ============================================================
mark_installed() {
  local m="$1"
  mkdir -p /var/lib/claude-code-server-kit
  touch /var/lib/claude-code-server-kit/installed-modules
  if ! grep -q "^$m$" /var/lib/claude-code-server-kit/installed-modules 2>/dev/null; then
    echo "$m" >> /var/lib/claude-code-server-kit/installed-modules
  fi
}

# ============================================================
# Маршрутизация
# ============================================================
case "$MODE" in
  list)     cmd_list ;;
  check)    cmd_check ;;
  core)     cmd_core ;;
  modules)  cmd_modules ;;
  all)      cmd_all ;;
  update)   cmd_update ;;
  shared-infra)    require_root; bash "$KIT_DIR/setup/shared-infra.sh" ;;
  provision-user)  require_root; bash "$KIT_DIR/setup/provision-user.sh" "$PROVISION_USER" ;;
  harden-admin)    require_root; bash "$KIT_DIR/setup/harden-admin.sh" ;;
  *)        err "Неизвестный режим: $MODE"; exit 1 ;;
esac
