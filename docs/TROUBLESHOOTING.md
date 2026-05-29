# Troubleshooting — что делать если не работает

> Большинство проблем — типовые. Здесь решения по категориям. Если вашего случая нет — [откройте issue](https://github.com/SergeyLikholat/claude-code-server-kit/issues), помогу.

---

## Установка

### `install.sh: command not found`

Вы не в директории kit'а. Должны быть внутри клона:
```bash
cd /root/claude-code-server-kit
sudo bash install.sh
```

### `permission denied`

Запускайте через `sudo`:
```bash
sudo bash install.sh
```

### `git: command not found`

```bash
sudo apt update && sudo apt install -y git curl
```

### `apt: command not found` или другая ОС

Kit рассчитан на Ubuntu 24.04 LTS (Debian-совместимые системы). Для других дистрибутивов — нужно адаптировать `setup/core/01-prereqs.sh` под `dnf` / `pacman` / `apk`.

PR с поддержкой других дистрибутивов welcome.

### `curl: (60) SSL certificate problem`

```bash
sudo apt install -y ca-certificates
sudo update-ca-certificates
```

### Скрипт зависает на каком-то шаге

`Ctrl+C` чтобы прервать. Посмотрите последние строки — скорее всего ждёт ввода. Запустите снова в интерактивном режиме (без `--non-interactive`).

---

## SSH

### «Permission denied (publickey)» при подключении

Подробно: [SSH-SETUP.md → раздел "Что делать если не работает"](SSH-SETUP.md#что-делать-если-не-работает).

Кратко: проверьте права на сервере:
```bash
chmod 700 ~/.ssh
chmod 600 ~/.ssh/authorized_keys
```

### Я запустил `preflight-ssh.sh` и теперь не могу войти

Скрипт перед отключением пароля **обязан** проверить что ключ работает. Если всё-таки не входит — войдите через **консоль провайдера** (KVM/VNC/Rescue mode):

```bash
sudo nano /etc/ssh/sshd_config
# Найдите: PasswordAuthentication no
# Замените на: PasswordAuthentication yes
sudo systemctl restart sshd
```

Теперь снова можете входить по паролю. Перенастройте ключ и попробуйте ещё раз.

### Хочу нестандартный порт SSH

`preflight-ssh.sh` спрашивает «менять ли порт». Если уже установлен и хотите изменить:

```bash
sudo nano /etc/ssh/sshd_config
# Раскомментируйте: Port 22
# Замените на: Port 2222 (или другое)
sudo systemctl restart sshd
sudo ufw allow 2222/tcp
sudo ufw delete allow 22/tcp
```

⚠️ Сначала откройте новый порт в ufw, потом меняйте sshd — иначе закроете себе доступ.

---

## Claude Code

### `claude: command not found`

CLI не установился или PATH не подхватился. Перелогиньтесь:
```bash
exit
ssh root@ВАШ_IP
which claude
```

Если всё ещё нет:
```bash
sudo bash setup/core/02-claude-cli.sh
```

### Первый запуск `claude` требует авторизации

Это нормально. Откройте указанную ссылку в браузере, войдите в Claude (если ещё не зарегистрированы — нужно создать аккаунт + закинуть денег на API).

### Claude ругается на лимиты / ошибки 429

Превышен квот или баланс закончился:
- https://console.anthropic.com/ → Billing
- Закиньте денег, лимиты обновятся через несколько минут

### Я хочу использовать другую модель

В `~/.claude/settings.json`:
```json
{
  "defaultModel": "claude-sonnet-4-6"
}
```

Список моделей: https://docs.claude.com/en/docs/about-claude/models

---

## Модули

### Модуль установился, но не работает

```bash
# Какие модули установлены
bash install.sh --check

# Статус конкретного systemd-сервиса
sudo systemctl status НАЗВАНИЕ.service

# Логи (последние 100 строк)
sudo journalctl -u НАЗВАНИЕ.service -n 100

# Логи в реальном времени
sudo journalctl -u НАЗВАНИЕ.service -f
```

### Хочу удалить модуль

```bash
sudo bash uninstall.sh --module ИМЯ
```

Удаляет сервисы и код, сохраняет env в `~/.removed-modules-backup/`. Данные не трогает.

---

## Backup

### `restic check вернул ошибку lock`

Был незавершённый запуск. Снимите лок:
```bash
export RESTIC_REPOSITORY="rclone:yadisk:..."
export RESTIC_PASSWORD_FILE="/root/.secrets/restic-password"
restic unlock
restic check
```

### `rclone: unable to get RefreshToken`

OAuth-токен Яндекса протух или сломан. Перенастройте:
```bash
sudo bash setup/modules/backup.sh --reconfigure-oauth
```
Скрипт проведёт через OAuth заново (нужны те же client_id/client_secret).

### Я.Диск качает / заливает медленно

Это нормально для бесплатных аккаунтов — 1-5 МБ/с. Для платных немного быстрее.

При restore запускайте в `tmux`:
```bash
tmux new -s restore
# внутри tmux:
restic restore latest --target /
# Отключиться от tmux не прерывая: Ctrl+b затем d
# Вернуться: tmux attach -t restore
```

### Бэкап ушёл с ошибкой ночью, как узнать что случилось

Лог в `/var/log/backup-main.log` (или через journalctl):
```bash
sudo cat /var/log/backup-main.log | tail -100
sudo journalctl -u backup.service -n 100
```

Если стоит модуль `tg-bot` — ошибки приходят в TG автоматически.

### Хочу запустить бэкап вручную сейчас

```bash
sudo bash /opt/backup/scripts/backup.sh
```

### Хочу увидеть какие снимки есть

```bash
export RESTIC_REPOSITORY="rclone:yadisk:..."
export RESTIC_PASSWORD_FILE="/root/.secrets/restic-password"
restic snapshots --tag nightly
```

### Восстановить вчерашнее состояние

```bash
restic snapshots --tag nightly | head -5    # найдите ID вчерашнего
restic restore SNAPSHOT_ID --target /tmp/restore/  # сначала в /tmp на проверку
# проверьте /tmp/restore/, если ок:
restic restore SNAPSHOT_ID --target /
```

### Полный disaster recovery

См. [`backup/RESTORE.md`](../backup/RESTORE.md).

---

## Telegram-бот

### Бот молчит на сообщения

```bash
sudo systemctl status tg-router
sudo journalctl -u tg-router -n 50
```

Самое частое:
- **«Conflict: terminated by other getUpdates»** — у того же токена есть второй consumer. Стопаните, удалите webhook, запустите снова:
  ```bash
  sudo systemctl stop tg-router
  curl -X POST "https://api.telegram.org/bot$TG_TOKEN/deleteWebhook?drop_pending_updates=true"
  sudo systemctl start tg-router
  ```
- **«Unauthorized»** — неверный токен в `/root/.secrets/tg-bot.env`. Перепроверьте у @BotFather.

### Бот пишет в неправильный чат

В `/root/.secrets/tg-bot.env` проверьте `TELEGRAM_CHAT_ID`. Если поменялся:
```bash
sudo nano /root/.secrets/tg-bot.env
sudo systemctl restart tg-router
```

### Хочу добавить топик для конкретного проекта

См. [TELEGRAM-SETUP.md → раздел про топики](TELEGRAM-SETUP.md#использование-топиков-если-форум-режим).

---

## Parakeet (транскрипция)

### Модель не скачивается

Скорее всего нужен HuggingFace токен:
```bash
sudo bash setup/modules/parakeet.sh --reconfigure
# вставьте HF_TOKEN из https://huggingface.co/settings/tokens
```

### Транскрипция медленная

Parakeet работает на CPU. Для серьёзной нагрузки нужен GPU (но это уже другая инфраструктура). Для голосовых 30-60 сек — приемлемо на любом VPS.

### Качество транскрипции плохое

Для русского лучше **GigaAM** от Сбера:
```bash
sudo bash uninstall.sh --module parakeet
sudo bash install.sh --module parakeet --variant gigaam
```

---

## claude-mem

### Память не работает / не показывает прошлые сессии

```bash
curl http://127.0.0.1:37700/api/health
# Должно быть {"status":"ok",...}
```

Если не отвечает — плагин не запущен. Перезапустите Claude:
```bash
# В вашей сессии Claude:
/exit
# Заново:
claude
```

### Хочу отключить запоминание определённых проектов

В `~/.claude/settings.json`:
```json
{
  "claudeMem": {
    "excludedProjects": ["my-private-project"]
  }
}
```

---

## Helpers

### `nanobanana: command not found`

Не установлен. Установите:
```bash
sudo bash install.sh --module helpers
```

### nanobanana пишет «GEMINI_API_KEY not set»

Добавьте ключ:
```bash
echo "GEMINI_API_KEY=ваш_ключ" >> /root/.nanobanana.env
chmod 600 /root/.nanobanana.env
```

Бесплатный ключ: https://aistudio.google.com/apikey

### openpyxl всё равно даёт сломанный xlsx

Убедитесь что в **ваших скриптах** до любого `from openpyxl import` стоит:
```python
import sys
sys.path.insert(0, "/opt/openpyxl_safe")
import openpyxl_safe  # noqa: F401
```

---

## Общее

### Хочу обновить kit до последней версии

```bash
cd /root/claude-code-server-kit
git pull
sudo bash install.sh --update
```

Это перепроверит установленные модули и обновит их компоненты. Ваши настройки в `~/.claude/` и `~/.secrets/` не тронет.

### Хочу полностью удалить kit с сервера

```bash
cd /root/claude-code-server-kit
sudo bash uninstall.sh --all

# Удалить сам kit
cd /
rm -rf /root/claude-code-server-kit
```

⚠️ Не удалит:
- Ваши данные в `~/.claude/` (история сессий, память)
- Бэкапы на Яндекс.Диске
- Ваш собственный код в `/root/projects/`

Это специально — чтобы не потерять важное случайным сносом.

### Сервер слишком медленный после установки всего

Профилируйте:
```bash
htop                    # что грузит CPU
free -h                 # сколько RAM свободно
docker stats            # сколько ест каждый контейнер
```

Если parakeet съел много RAM — он может выгружать модель в простое:
```bash
# в /opt/parakeet-server/config.json
{
  "unload_after_idle_seconds": 600
}
```

### Я хочу мониторинг (графики, алерты)

Этот kit пока не включает Grafana/Prometheus. Если нужно — поставьте отдельно через `kossakovsky/n8n-install` (там это есть в составе) или вручную.

### У меня что-то совсем странное

1. Соберите контекст:
   ```bash
   bash install.sh --check > /tmp/diagnostic.txt 2>&1
   sudo journalctl --since "1 hour ago" >> /tmp/diagnostic.txt
   ```
2. [Откройте issue](https://github.com/SergeyLikholat/claude-code-server-kit/issues/new) с приложенным `diagnostic.txt`
3. ⚠️ Перед публикацией просмотрите файл и **уберите секреты** если попали

---

## Прежде чем спросить помощи

Чек-лист перед issue:
- [ ] Прочитали этот документ
- [ ] Прочитали соответствующий setup-документ ([SSH](SSH-SETUP.md), [Backup](BACKUP-SETUP.md), [Telegram](TELEGRAM-SETUP.md))
- [ ] Запустили `bash install.sh --check`
- [ ] Посмотрели логи через `journalctl`
- [ ] Поискали ошибку в Google — может это типовая проблема Ubuntu/Docker
- [ ] Если всё равно не получается — открывайте issue с диагностикой
