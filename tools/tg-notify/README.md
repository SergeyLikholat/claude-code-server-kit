# tg-notify — утилиты для отправки уведомлений в Telegram

Standalone shell-скрипты для отправки сообщений в TG из cron, systemd-юнитов, других скриптов.

**Требует:** установленный модуль `tg-bot` (использует тот же `TELEGRAM_BOT_TOKEN` из `/root/.claude/channels/telegram/.env`).

Если `tg-bot` уже установлен — эти утилиты ставятся вместе с ним в `/opt/tg-notify/`.

## notify.sh — отправить одно сообщение

```bash
# В обычный чат / DM
/opt/tg-notify/notify.sh -1001234567890 "Привет, бэкап завершён"

# В конкретный топик форум-группы
/opt/tg-notify/notify.sh -1001234567890 --thread 4 "🔔 Напоминание: креатин"
```

## schedule-notify.sh — отправить через N минут/часов

Использует `systemd-run --on-active=...`. Не требует at/atd.

```bash
# Через 5 минут
/opt/tg-notify/schedule-notify.sh 5min -1001234567890 "Через 5 минут"

# Через 2 часа в топик
/opt/tg-notify/schedule-notify.sh 2h -1001234567890 --thread 4 "Сходить на прогулку"

# Сложные интервалы
/opt/tg-notify/schedule-notify.sh 1h30min -1001234567890 "Полтора часа"
```

## Типичные сценарии

### Cron-напоминания

```cron
# Витамин D3 каждый день в 9:20
20 9 * * * /opt/tg-notify/notify.sh -1001234567890 --thread 4 "🔔 Витамин D3 с жирной едой"

# Магний за час до сна
0 22 * * * /opt/tg-notify/notify.sh -1001234567890 --thread 4 "🔔 Магний бисглицинат за 60 мин до сна"
```

### Уведомления из других скриптов

```bash
# В backup-скрипте:
if /opt/backup/scripts/backup.sh; then
  /opt/tg-notify/notify.sh "$ADMIN_CHAT" "✅ Backup OK"
else
  /opt/tg-notify/notify.sh "$ADMIN_CHAT" "❌ Backup упал"
fi
```

### Отложенные напоминания (через systemd-run)

```bash
# Закинуть «выпить воду» через 15 минут
/opt/tg-notify/schedule-notify.sh 15min -1001234567890 "💧 Выпить стакан воды"
```

## Как узнать chat_id

См. [docs/TELEGRAM-SETUP.md → Шаг 3](../../docs/TELEGRAM-SETUP.md#шаг-3-узнайте-chat_id-вашей-группы).
