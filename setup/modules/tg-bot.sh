#!/bin/bash
# Модуль tg-bot: Telegram-бот для управления Claude
set -e
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

MODULE_NAME="tg-bot"
log "Установка модуля: $MODULE_NAME"

# ============================================================
# 1. Сбор данных от пользователя
# ============================================================
ask "Telegram Bot Token (от @BotFather)" "" TELEGRAM_BOT_TOKEN
if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
  warn "Bot token не указан — модуль пропущен"
  echo
  echo "Как получить:"
  echo "  1. Откройте https://t.me/BotFather"
  echo "  2. /newbot, придумайте имя"
  echo "  3. Скопируйте токен вида 123456:ABCdef..."
  echo "  4. Запустите: TELEGRAM_BOT_TOKEN=ваш_токен sudo bash install.sh --module tg-bot"
  exit 0
fi

ask "Telegram Chat ID (группа или ваш личный, например -1001234567890)" "" TELEGRAM_CHAT_ID
ask "Использовать форум-режим с топиками? (y/n)" "n" TG_FORUM_MODE

# Проверка валидности токена
log "Проверяю токен..."
BOT_INFO=$(curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe" 2>/dev/null || echo '{"ok":false}')
if echo "$BOT_INFO" | grep -q '"ok":true'; then
  BOT_USERNAME=$(echo "$BOT_INFO" | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"]["username"])' 2>/dev/null)
  ok "Бот найден: @$BOT_USERNAME"
else
  err "Токен невалидный. Проверьте у @BotFather."
  exit 1
fi

# ============================================================
# 2. Копирование кода в /opt/
# ============================================================
log "Копирую код в /opt/claude-telegram/"
ensure_dir /opt 755
cp -r "$KIT_DIR/tools/claude-telegram" /opt/

log "Копирую роутер в /opt/claude-telegram-router/"
cp -r "$KIT_DIR/tools/claude-telegram-router" /opt/

# Зависимости
if [ -f /opt/claude-telegram/package.json ]; then
  cd /opt/claude-telegram && npm install --production --silent 2>&1 | tail -3
fi
if [ -f /opt/claude-telegram-router/package.json ]; then
  cd /opt/claude-telegram-router && npm install --production --silent 2>&1 | tail -3
fi

# ============================================================
# 3. Секреты
# ============================================================
save_secrets /root/.secrets/tg-bot.env \
  TELEGRAM_BOT_TOKEN \
  TELEGRAM_CHAT_ID \
  TG_FORUM_MODE

# ============================================================
# 4. Systemd-юнит
# ============================================================
install_systemd_unit "claude-telegram" \
  "$KIT_DIR/systemd/claude-telegram.service.template" \
  "SECRETS_ENV_FILE=/root/.secrets/tg-bot.env" \
  "WORKDIR=/opt/claude-telegram"

systemctl enable --now claude-telegram.service

# Опционально роутер
if [ -f "$KIT_DIR/systemd/tg-router.service.template" ]; then
  install_systemd_unit "tg-router" \
    "$KIT_DIR/systemd/tg-router.service.template" \
    "SECRETS_ENV_FILE=/root/.secrets/tg-bot.env" \
    "WORKDIR=/opt/claude-telegram-router"
  systemctl enable --now tg-router.service 2>/dev/null || true
fi

# ============================================================
# 5. Smoke-test
# ============================================================
sleep 3
if systemctl is-active --quiet claude-telegram; then
  ok "claude-telegram запущен"

  # Тестовое сообщение
  curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" \
    -d "text=🤖 Claude Code Server Kit подключён. Готов к работе." \
    > /dev/null && ok "Тестовое сообщение отправлено в TG"
else
  warn "claude-telegram не запустился. Логи: journalctl -u claude-telegram -n 50"
fi

cat <<EOF

${BOLD}${GREEN}✓ Модуль tg-bot установлен${NC}

Что дальше:
  • Напишите боту @${BOT_USERNAME:-yourbot} любое сообщение — он перешлёт в Claude
  • Логи: journalctl -u claude-telegram -f
  • Перезапуск: sudo systemctl restart claude-telegram
  • Настройка топиков: см. docs/TELEGRAM-SETUP.md

EOF
