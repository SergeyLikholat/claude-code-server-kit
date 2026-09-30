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
# Полная среда одной командой (docs/FULL-STACK.md):
#   sudo bash install.sh --full --secrets secrets.env
#       core + память (llm-memory-kit) + T3 + модули, для которых в файле есть ключи.
#       Каждый ключ проверяется вживую до установки; при полном файле — ни одного вопроса.
#   --secrets FILE      взять ключи из файла (шаблон: secrets.example.env); годится и с --module
#   --delete-secrets    после установки удалить FILE (копия — ~/.config/kit/secrets.env)
#   sudo bash install.sh --apply-secrets [--secrets FILE]
#       заменить ключи (например, продлённый токен Claude): проверка, сохранение, перезапуск T3
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
# shellcheck disable=SC1091
source "$KIT_DIR/setup/lib/secrets.sh"

# ============================================================
# Парсинг аргументов
# ============================================================
MODE=""
MODULES=()
NON_INTERACTIVE=false
SKIP_GEMINI=false
PARAKEET_VARIANT="parakeet"
SECRETS_FILE=""

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
    --full)
      MODE="full"
      ;;
    --apply-secrets)
      MODE="apply-secrets"
      ;;
    --secrets)
      shift
      SECRETS_FILE="${1:-}"
      [ -n "$SECRETS_FILE" ] || { err "--secrets: укажите файл"; exit 1; }
      ;;
    --delete-secrets)
      export KIT_DELETE_SECRETS=1
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
      export KIT_NONINTERACTIVE=1
      ;;
    --skip-gemini)
      SKIP_GEMINI=true
      ;;
    --variant)
      shift
      PARAKEET_VARIANT="$1"
      ;;
    -h|--help)
      awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"
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

# Ключи: явный --secrets, иначе — сохранённые прошлой установкой (~/.config/kit/secrets.env),
# чтобы повтор модуля или --full не спрашивал заново то, что уже известно
if [ -n "$SECRETS_FILE" ]; then
  kit_load_secrets "$SECRETS_FILE" || exit 1
  export KIT_NONINTERACTIVE=1
elif [[ " full apply-secrets modules core all update " == *" $MODE "* ]]; then
  if [ -r "$(kit_config_dir)/secrets.env" ]; then
    kit_load_secrets "$(kit_config_dir)/secrets.env" || exit 1
    KIT_SECRETS_FILE=""   # это и есть хранилище — удалять нечего
  fi
fi

# ============================================================
# Список модулей и их описаний
# ============================================================
declare -A MODULE_DESCRIPTIONS=(
  ["tg-bot"]="Telegram-бот для управления Claude с телефона"
  ["backup"]="Автоматические шифрованные бэкапы на Яндекс.Диск"
  ["parakeet"]="Голосовая транскрипция (Parakeet или GigaAM)"
  ["helpers"]="Полезные мелочи: nanobanana, gemini-tts, openpyxl_safe, tg-md"
  ["hooks-extras"]="Дополнительные хуки и автоматизации"
  ["memory"]="Память между сессиями (ставит llm-memory-kit: хуки + ночные сборщики)"
  ["t3"]="T3 Code: Claude в браузере и Android-приложении, свой домен с TLS"
)

# claude-mem УБРАН из V2: память теперь per-user через obsidian-vault + context-mgr
# (ставится автоматически в provision-user.sh). См. docs/V2-MULTIUSER.md.
ALL_MODULES=("tg-bot" "backup" "parakeet" "helpers" "hooks-extras" "memory" "t3")

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
  echo "Ключи и T3:"
  [ -f "$(kit_config_dir)/secrets.env" ] && ok "ключи: $(kit_config_dir)/secrets.env" || echo "  — ключи не сохранялись (install.sh --secrets)"
  [ -f "$(kit_config_dir)/claude.env" ] && ok "токен Claude для служб и cron: $(kit_config_dir)/claude.env" || echo "  — токена Claude для служб нет"
  if command -v t3-update >/dev/null 2>&1; then kit_as_user t3-update status 2>/dev/null | sed 's/^/  /'; fi

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
  [ "$MODE" = "full" ] && return 0   # в --full итог печатается один раз, в конце

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

# Результаты модулей за этот запуск — для итоговой таблицы
declare -A MODULE_RESULT=()
MODULE_ORDER=()

# Запустить один модуль: 0 — установлен, KIT_RC_SKIPPED — пропущен (нет ключа), иначе — ошибка.
# Ошибка модуля не останавливает остальные: итог покажет, что упало.
run_module() {
  local m="$1" script rc=0
  script="$KIT_DIR/setup/modules/${m}.sh"
  MODULE_ORDER+=("$m")
  if [ ! -x "$script" ]; then
    err "Модуль не найден: $m"
    echo "Доступные: ${ALL_MODULES[*]}"
    MODULE_RESULT[$m]="нет такого модуля"
    return 0
  fi
  section "Модуль: $m"
  log "${MODULE_DESCRIPTIONS[$m]:-}"
  "$script" || rc=$?
  case "$rc" in
    0) mark_installed "$m"; MODULE_RESULT[$m]="установлен" ;;
    "$KIT_RC_SKIPPED") MODULE_RESULT[$m]="пропущен (нет ключей/настроек)" ;;
    *) MODULE_RESULT[$m]="ОШИБКА (код $rc)" ;;
  esac
}

# С --secrets модули проверяют ключи до установки, как и --full
validate_if_secrets() {
  if [ -n "$SECRETS_FILE" ] && [ "${KIT_VALIDATED:-0}" != "1" ]; then
    kit_validate_secrets partial || exit 1
    export KIT_VALIDATED=1
  fi
}

cmd_modules() {
  require_root
  validate_if_secrets
  for m in "${MODULES[@]}"; do
    run_module "$m"
  done
  [ -n "$SECRETS_FILE" ] && { kit_persist_secrets; kit_install_claude_env; kit_cleanup_secrets_source; }
  return 0
}

cmd_all() {
  cmd_core
  MODULES=("${ALL_MODULES[@]}")
  cmd_modules
}

# ============================================================
# --full: вся среда одной командой
# ============================================================
cmd_full() {
  require_root
  require_ubuntu
  section "Полная установка: сервер → Claude Code → обвязка → память → T3"

  if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && ! kit_is_noninteractive; then
    echo "Нужен токен подписки Claude: на компьютере с Claude Code выполните  claude setup-token"
    ask_secret "Вставьте токен (sk-ant-oat01-…)" CLAUDE_CODE_OAUTH_TOKEN
    export CLAUDE_CODE_OAUTH_TOKEN
  fi

  # Что ставим, кроме core: память и helpers — всегда, T3 — всегда (сам скажет, если нет
  # домена), остальное — если для него есть ключ.
  local plan=(memory helpers)
  [ -n "${RCLONE_YANDEX_TOKEN:-}" ] && plan+=(backup)
  [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && plan+=(tg-bot)
  [ "${KIT_WITH_PARAKEET:-}" = "1" ] && plan+=(parakeet)
  plan+=(t3)
  log "План: core ${plan[*]}"

  kit_validate_secrets full || exit 1
  export KIT_VALIDATED=1

  # Пароль бэкапа: если не задан — генерируем сейчас, чтобы он попал в сохранённые ключи
  if [[ " ${plan[*]} " == *" backup "* ]] && [ -z "${RESTIC_PASSWORD:-}" ] && [ ! -f /root/.secrets/restic-password ]; then
    RESTIC_PASSWORD="$(openssl rand -base64 32 | tr -d '\n')"
    export RESTIC_PASSWORD BACKUP_RESTIC_PASSWORD="$RESTIC_PASSWORD"
    KIT_RESTIC_GENERATED=1
  fi

  kit_persist_secrets
  kit_install_claude_env
  export KIT_NONINTERACTIVE=1   # дальше — без вопросов

  cmd_core
  MODULE_ORDER+=(core); MODULE_RESULT[core]="установлен"

  # Если API Anthropic не дал однозначного ответа — пробный запрос через уже установленный CLI
  if [ "${KIT_CLAUDE_CHECK_PENDING:-0}" = "1" ]; then
    kit_check_claude_token_cli || fatal "Токен Claude не работает — исправьте и запустите --apply-secrets"
  fi

  local m
  for m in "${plan[@]}"; do run_module "$m"; done

  kit_cleanup_secrets_source
  print_summary
}

# Итог: что встало, куда заходить, что делать дальше
print_summary() {
  local m failed=0 t3s="/var/lib/claude-code-server-kit/t3-summary.txt" link url apk ttl caddy https
  section "Итог установки"
  for m in "${MODULE_ORDER[@]}"; do
    printf "  %-14s %s\n" "$m" "${MODULE_RESULT[$m]}"
    [[ "${MODULE_RESULT[$m]}" == ОШИБКА* ]] && failed=1
  done
  echo

  if [ -f "$t3s" ] && [ "${MODULE_RESULT[t3]:-}" = "установлен" ]; then
    url="$(grep '^T3_URL=' "$t3s" | cut -d= -f2-)"
    link="$(grep '^T3_PAIR_LINK=' "$t3s" | cut -d= -f2-)"
    ttl="$(grep '^T3_PAIR_TTL=' "$t3s" | cut -d= -f2-)"
    apk="$(grep '^T3_APK_URL=' "$t3s" | cut -d= -f2-)"
    caddy="$(grep '^T3_CADDY=' "$t3s" | cut -d= -f2-)"
    https="$(grep '^T3_HTTPS_OK=' "$t3s" | cut -d= -f2-)"
    echo -e "${BOLD}T3:${NC} $url"
    if [ -n "$link" ]; then
      echo "  Приглашение (одноразовое, $ttl):"
      echo -e "  ${BOLD}$link${NC}"
      command -v qrencode >/dev/null 2>&1 && qrencode -t ANSIUTF8 "$link"
    fi
    [ -n "$apk" ] && echo "  Android-приложение: $apk"
    [ "$caddy" != "ok" ] && warn "  Прокси для домена настроить вручную — см. вывод модуля t3 выше"
    [ "$caddy" = "ok" ] && [ "$https" != "1" ] && warn "  https пока не открывается — проверьте A-запись; журнал: journalctl -u caddy -n 50"
    echo
  fi

  echo -e "${BOLD}Claude:${NC} вход по токену подписки (действует год)."
  echo "  Продлить: claude setup-token → новое значение CLAUDE_CODE_OAUTH_TOKEN в"
  echo "  $(kit_config_dir)/secrets.env → sudo bash install.sh --apply-secrets"
  if [ "${KIT_RESTIC_GENERATED:-0}" = "1" ]; then
    echo
    warn "Пароль бэкапа сгенерирован: он в $(kit_config_dir)/secrets.env (RESTIC_PASSWORD)."
    warn "  Перепишите его в менеджер паролей: без него бэкап не восстановить, а сервер может пропасть."
  fi
  echo
  echo -e "${BOLD}Дальше:${NC}"
  echo "  • открыть приглашение в браузере или приложении и начать тред;"
  echo "  • проверить состояние: sudo bash install.sh --check; T3 — t3-update status;"
  echo "  • подробно о слоях и модулях: docs/FULL-STACK.md"
  [ "$failed" = 0 ] || { err "Часть модулей не встала — см. таблицу выше"; return 1; }
}

# ============================================================
# --apply-secrets: заменить ключи на работающем сервере
# ============================================================
cmd_apply_secrets() {
  require_root
  [ -n "${KIT_SECRETS_FILE:-}${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || \
    fatal "Нет ключей: укажите --secrets FILE или заполните $(kit_config_dir)/secrets.env"
  kit_validate_secrets apply || exit 1
  kit_persist_secrets
  kit_install_claude_env
  if [ -f "$(kit_home)/.config/systemd/user/t3code.service" ] && command -v t3-update >/dev/null 2>&1; then
    log "Перезапускаю T3, чтобы служба взяла новый токен"
    kit_as_user t3-update restart || warn "T3 не перезапустился — см. t3-update status"
  fi
  kit_cleanup_secrets_source
  ok "Ключи применены. Новые шеллы и ночные задачи возьмут токен сами."
}

cmd_update() {
  require_root
  section "Обновление установленного"
  log "git pull в kit..."
  cd "$KIT_DIR" && git pull --ff-only

  log "Перезапускаю core..."
  cmd_core

  if [ -f /var/lib/claude-code-server-kit/installed-modules ]; then
    MODULES=()
    while IFS= read -r m; do
      [ "$m" = "core" ] && continue
      # T3 обновляется своей командой (новая сборка + откат), повтор модуля лишь перезапустил бы службу
      [ "$m" = "t3" ] && { log "t3: обновление — t3-update <архив или ссылка>"; continue; }
      MODULES+=("$m")
    done < /var/lib/claude-code-server-kit/installed-modules
    cmd_modules
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
  core)     validate_if_secrets; cmd_core ;;
  modules)  cmd_modules ;;
  full)     cmd_full ;;
  apply-secrets) cmd_apply_secrets ;;
  all)      cmd_all ;;
  update)   cmd_update ;;
  shared-infra)    require_root; bash "$KIT_DIR/setup/shared-infra.sh" ;;
  provision-user)  require_root; bash "$KIT_DIR/setup/provision-user.sh" "$PROVISION_USER" ;;
  harden-admin)    require_root; bash "$KIT_DIR/setup/harden-admin.sh" ;;
  *)        err "Неизвестный режим: $MODE"; exit 1 ;;
esac
