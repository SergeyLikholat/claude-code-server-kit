#!/bin/bash
# notify.sh — отправка уведомления в Telegram (если модуль tg-bot установлен).
# Если TG не настроен — просто пишет в stdout и возвращает 0.

TITLE="$1"
BODY="$2"

# Читаем настройки TG из секретов модуля tg-bot
TG_ENV="/root/.secrets/tg-bot.env"
if [ -f "$TG_ENV" ]; then
  # shellcheck disable=SC1090
  source "$TG_ENV"
fi

MSG="${TITLE}

${BODY}"

if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_CHAT_ID" ]; then
  curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=${MSG}" \
    > /dev/null && exit 0
fi

# Fallback — просто в stdout
echo "===== NOTIFY ====="
echo "$MSG"
