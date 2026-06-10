#!/bin/bash
# Модуль tg-bot: Telegram-роутер для управления Claude.
#
# По умолчанию ставит один бот (tg-router).
# Опция --second-bot ставит ВТОРОЙ бот (tg-router2) рядом с первым
#   (для членов семьи / команды / тестового канала).

set -e
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

MODULE_NAME="tg-bot"
INSTALL_SECOND=false

# Парсинг аргументов модуля
for arg in "$@"; do
  case "$arg" in
    --second-bot) INSTALL_SECOND=true ;;
  esac
done

log "Установка модуля: $MODULE_NAME"

# Гарантировать Node.js — нужен и для роутера, и для запуска
# MCP-сервера плагина claude-plugins-official/telegram.
ensure_node

# Установить официальный Telegram-плагин Claude Code (MCP-сервер reply/react/
# download_attachment). Без него headless-claude worker внутри роутера
# физически не может отправить ответ — он лишь напишет в stdout, который
# пользователь не видит, и в чате тишина.
log "▸ Telegram MCP-плагин (claude-plugins-official/telegram)"
install_claude_plugin "telegram" "claude-plugins-official" "anthropics/claude-plugins-official" || \
  warn "Плагин не установлен — бот сможет принимать сообщения, но не отвечать через MCP"

# Создать дефолтный routing.json — без него index.js падает на каждом
# сообщении (JSON.parse(readFileSync(ROUTING_FILE))).
ensure_default_routing() {
  local state_dir="$1"
  local routing_file="$state_dir/routing.json"
  ensure_dir "$state_dir" 700
  if [ -f "$routing_file" ]; then
    log "  routing.json уже существует — не трогаю"
    return 0
  fi
  local sid
  sid="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || python3 -c 'import uuid;print(uuid.uuid4())')"
  cat > "$routing_file" <<EOF
{
  "general": {
    "name": "General",
    "project_dir": "/root",
    "session_id": "$sid"
  },
  "topics": {},
  "ux": {}
}
EOF
  chmod 600 "$routing_file"
  log "  routing.json создан: $routing_file"
}

# ============================================================
# Общая функция установки одного бота
# ============================================================
install_bot() {
  local name="$1"               # tg-router или tg-router2
  local workdir="$2"            # /opt/claude-telegram-router(2)
  local runtime_dir="$3"        # claude-telegram(2)
  local state_dir="$4"          # /root/.claude/channels/telegram(2)
  local env_file="$5"           # /root/.claude/channels/telegram(2)/.env
  local template="$6"           # путь к systemd template
  local token_var="$7"          # имя переменной с токеном

  log "▸ Установка $name (workdir: $workdir)"

  # 1. Получить токен
  local TOKEN="${!token_var:-}"
  if [ -z "$TOKEN" ]; then
    ask "Telegram Bot Token для $name (от @BotFather)" "" TOKEN
  fi
  if [ -z "$TOKEN" ]; then
    warn "Токен для $name не указан — пропускаю"
    return 0
  fi

  # 2. Проверка токена
  log "Проверяю токен..."
  local bot_info
  bot_info=$(curl -sS "https://api.telegram.org/bot${TOKEN}/getMe" 2>/dev/null || echo '{"ok":false}')
  if ! echo "$bot_info" | grep -q '"ok":true'; then
    err "Токен невалидный. Проверьте у @BotFather."
    return 1
  fi
  local bot_username
  bot_username=$(echo "$bot_info" | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"]["username"])' 2>/dev/null)
  ok "  Бот: @$bot_username"

  # 3. Установка кода в /opt/
  ensure_dir /opt 755
  if [ ! -d "$workdir" ]; then
    cp -r "$KIT_DIR/tools/claude-telegram-router" "$workdir"
    log "  Код скопирован в $workdir"
  else
    log "  $workdir уже существует, не перезаписываю код (используем существующий)"
  fi

  # 4. npm install (если ещё не сделан)
  if [ ! -d "$workdir/node_modules" ]; then
    log "  npm install зависимостей..."
    (cd "$workdir" && npm install --production --silent 2>&1 | tail -3) || warn "  npm install вернул ошибку"
  fi

  # 5. Env-файл (соглашение: /root/.claude/channels/telegram(2)/.env)
  ensure_dir "$state_dir" 700
  if [ ! -f "$env_file" ]; then
    cat > "$env_file" <<EOF
TELEGRAM_BOT_TOKEN=$TOKEN
TELEGRAM_FORCE_POLLING=0
# PARAKEET_URL=http://127.0.0.1:8002/transcribe   # раскомментируйте после установки модуля parakeet
EOF
    chmod 600 "$env_file"
    log "  Env создан: $env_file"
  else
    log "  $env_file уже существует — НЕ перезаписываю (используем существующий)"
  fi

  # 5b. Дефолтный routing.json (требуется loadRouting() в index.js).
  ensure_default_routing "$state_dir"

  # 6. Systemd unit
  if [ "$name" = "tg-router2" ]; then
    install_systemd_unit "$name" "$template" \
      "WORKDIR=$workdir" \
      "RUNTIME_DIR=$runtime_dir" \
      "STATE_DIR=$state_dir" \
      "ENV_FILE=$env_file"
  else
    install_systemd_unit "$name" "$template" \
      "WORKDIR=$workdir" \
      "RUNTIME_DIR=$runtime_dir" \
      "ENV_FILE=$env_file"
  fi

  # 7. Enable + start
  systemctl enable "${name}.service"
  systemctl restart "${name}.service"
  sleep 2

  if systemctl is-active --quiet "${name}.service"; then
    ok "  $name запущен и enabled (стартует автоматически после перезагрузки)"
  else
    warn "  $name не запустился. Логи: journalctl -u $name -n 50"
  fi

  echo "BOT_USERNAME_${name//-/_}=$bot_username" >> /tmp/tg-bot-install.summary
}

# ============================================================
# Установка основного бота (tg-router)
# ============================================================
install_bot \
  "tg-router" \
  "/opt/claude-telegram-router" \
  "claude-telegram" \
  "/root/.claude/channels/telegram" \
  "/root/.claude/channels/telegram/.env" \
  "$KIT_DIR/systemd/tg-router.service.template" \
  "TELEGRAM_BOT_TOKEN"

# ============================================================
# Бонус: tg-notify utilities (notify.sh + schedule-notify.sh)
# ============================================================
# Standalone-скрипты для отправки TG-сообщений из cron / других скриптов.
# Используют тот же TELEGRAM_BOT_TOKEN что и роутер.
log "▸ Установка tg-notify утилит в /opt/tg-notify/"
ensure_dir /opt/tg-notify 755
cp -n "$KIT_DIR/tools/tg-notify/notify.sh" /opt/tg-notify/ 2>/dev/null || true
cp -n "$KIT_DIR/tools/tg-notify/schedule-notify.sh" /opt/tg-notify/ 2>/dev/null || true
chmod +x /opt/tg-notify/*.sh 2>/dev/null || true
ok "  → /opt/tg-notify/notify.sh и schedule-notify.sh готовы"
log "  Примеры использования: см. /opt/tg-notify/README.md (или tools/tg-notify/README.md в kit'е)"
cp -n "$KIT_DIR/tools/tg-notify/README.md" /opt/tg-notify/ 2>/dev/null || true

# ============================================================
# Опционально: второй бот (tg-router2)
# ============================================================
if [ "$INSTALL_SECOND" = "true" ]; then
  echo
  log "▸ Установка второго бота (--second-bot)"
  install_bot \
    "tg-router2" \
    "/opt/claude-telegram-router2" \
    "claude-telegram2" \
    "/root/.claude/channels/telegram2" \
    "/root/.claude/channels/telegram2/.env" \
    "$KIT_DIR/systemd/tg-router2.service.template" \
    "TELEGRAM_BOT_TOKEN_2"
fi

# ============================================================
# Финал
# ============================================================
cat <<EOF

${BOLD}${GREEN}✓ Модуль tg-bot установлен${NC}

Что работает:
  • tg-router  — systemd unit enabled (автоматически стартует после перезагрузки)
$([ "$INSTALL_SECOND" = "true" ] && echo "  • tg-router2 — systemd unit enabled (второй бот)")

Полезные команды:
  • Логи:      journalctl -u tg-router -f
  • Статус:    systemctl status tg-router
  • Рестарт:   sudo systemctl restart tg-router
$([ "$INSTALL_SECOND" = "true" ] && echo "  • Аналогично tg-router2")

Чтобы добавить второй бот позже:
  sudo bash install.sh --module tg-bot -- --second-bot

Конфиги (env-файлы с токенами):
  • /root/.claude/channels/telegram/.env  (основной)
$([ "$INSTALL_SECOND" = "true" ] && echo "  • /root/.claude/channels/telegram2/.env (второй)")

EOF

rm -f /tmp/tg-bot-install.summary
