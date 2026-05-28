# Как кастомизировать kit под себя

> Это для тех кто хочет **форкнуть и допилить** под свой проект/команду. Если просто пользуетесь — [README.md](../README.md) и [MODULES.md](../MODULES.md) достаточно.

---

## Сценарий 1: Я хочу подкрутить настройки для своего сервера

Самый простой кейс. Не нужно форкать репозиторий.

После установки:
- `~/.claude/settings.json` — редактируйте напрямую. Все настройки Claude Code.
- `~/.claude/hooks/*` — добавляйте свои хуки.
- `~/.secrets/*.env` — храните свои ключи.
- `/opt/<имя-tool>/.env` — настройки конкретных tools.

После изменений:
```bash
# Если меняли хуки или settings — Claude подхватит автоматически при следующем запуске
# Если меняли systemd-сервисы:
sudo systemctl daemon-reload
sudo systemctl restart НАЗВАНИЕ.service
```

Обновления kit не затрут ваши пользовательские настройки (они в `~/.claude/`, а не в репозитории kit'а).

---

## Сценарий 2: Я хочу добавить свой модуль

### Шаг 1: Создайте setup-скрипт

```bash
# В вашем форке
touch setup/modules/мой-модуль.sh
chmod +x setup/modules/мой-модуль.sh
```

Структура скрипта (template):

```bash
#!/bin/bash
# setup/modules/мой-модуль.sh
set -e

MODULE_NAME="мой-модуль"
source "$(dirname "$0")/../lib/common.sh"   # log, error, ask и т.п.

log "==== Установка модуля: $MODULE_NAME ===="

# 1. Проверка требований
check_requirement_or_skip "MY_API_KEY" \
  "Чтобы использовать $MODULE_NAME, нужен API-ключ от X.
   Получить: https://example.com/api
   Добавить: echo 'MY_API_KEY=...' >> .env"

# 2. Установка кода
log "Копирую код в /opt/мой-модуль/"
cp -r "$KIT_DIR/tools/мой-модуль" /opt/

# 3. Установка зависимостей
cd /opt/мой-модуль
pip install -r requirements.txt   # или npm install / cargo build / etc.

# 4. Создание systemd-юнита
install_systemd_unit "мой-модуль" \
  "$KIT_DIR/systemd/мой-модуль.service.template" \
  --set "SECRETS_ENV_FILE=/root/.secrets/мой-модуль.env"

# 5. Сохранение секретов
mkdir -p /root/.secrets
cat > /root/.secrets/мой-модуль.env <<EOF
MY_API_KEY=$MY_API_KEY
EOF
chmod 600 /root/.secrets/мой-модуль.env

# 6. Активация
systemctl daemon-reload
systemctl enable --now мой-модуль.service

# 7. Smoke-test
sleep 2
if curl -sf http://localhost:8090/health > /dev/null; then
  log "✓ Модуль работает"
else
  warn "Модуль установлен, но не отвечает. Проверьте: journalctl -u мой-модуль -n 50"
fi

log "==== $MODULE_NAME готов ===="
```

### Шаг 2: Создайте systemd-template

```bash
# systemd/мой-модуль.service.template
[Unit]
Description=Мой модуль
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/мой-модуль
EnvironmentFile=__SECRETS_ENV_FILE__
ExecStart=/usr/bin/python3 /opt/мой-модуль/main.py
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

### Шаг 3: Положите код модуля

```bash
mkdir -p tools/мой-модуль
# Скопируйте сюда ваш код (БЕЗ секретов!)
# Добавьте .env.example с пустыми значениями
```

### Шаг 4: Документируйте

Добавьте раздел в `MODULES.md`:
```markdown
## 🆕 мой-модуль — Что делает простыми словами

**Что даёт:** ...
**Когда нужно:** ...
**Что подготовить:** ...
**Установка:** `sudo bash install.sh --module мой-модуль`
```

---

## Сценарий 3: Я хочу свой набор правил для Claude

Например, ваша команда использует определённые соглашения по коду.

### Вариант A: Положить в общий claude-config

Отредактируйте/добавьте файлы в `claude-config/rules/` своего форка. После установки они попадут в `~/.claude/rules/`.

### Вариант B: Свой репозиторий правил поверх ECC

Если ваших правил много и хотите их версионировать отдельно:

```bash
# В вашем форке kit'а, в setup/core/03-ecc-base.sh добавьте:
git clone https://github.com/ваш-username/team-rules /root/.claude/rules/team
```

Claude автоматически подхватит правила из любых подпапок `~/.claude/rules/`.

---

## Сценарий 4: Свой брендинг (для команды/компании)

В корне форка:
1. Измените `README.md` — название, описание, контакты
2. Замените ссылки `SergeyLikholat/claude-code-server-kit` → ваши
3. (Опционально) добавьте логотип в `assets/`
4. Обновите `LICENSE` если меняете лицензию (или оставьте MIT)

---

## Сценарий 5: Свой бэкап-провайдер (не Яндекс)

Backup-модуль использует `rclone`, который поддерживает 70+ облачных хранилищ. Чтобы заменить Яндекс на S3 / B2 / GDrive / etc.:

1. В `setup/modules/backup.sh` замените `yandex` backend на нужный:
   ```bash
   # Было:
   rclone config create remote yandex client_id="$YANDEX_CLIENT_ID" ...
   # Стало (для S3):
   rclone config create remote s3 \
     provider="$S3_PROVIDER" \
     access_key_id="$S3_ACCESS_KEY" \
     secret_access_key="$S3_SECRET_KEY" \
     region="$S3_REGION"
   ```

2. Обновите путь в `BACKUP_TARGET_PATH`:
   ```bash
   # Было: rclone:yandex:DATA_BIG/server-backups/restic-main
   # Стало: rclone:s3:my-bucket/restic-main
   ```

3. Обновите BACKUP-SETUP.md под новый провайдер.

Всё остальное (restic, retention, scheduling, scripts) — без изменений.

---

## Сценарий 6: Своя сборка с готовыми ключами для команды

Если в команде нужно раздать готовый kit с уже заполненным `.env` (общие командные ключи) — **НЕ кладите .env в git**. Вместо этого:

### Вариант A: 1Password CLI / Bitwarden CLI

```bash
# install-team.sh (новый wrapper)
op read "op://Team Vault/Claude Code Kit/env" > .env
sudo bash install.sh --all
```

### Вариант B: Ansible / Terraform

Оборачиваете kit в инфраструктурный код. Ansible vault для секретов.

### Вариант C: Приватный репозиторий

Форкаете в приватный репо команды + добавляете `team.env` с командными ключами. Каждый член команды клонирует приватный форк.

⚠️ **Никогда не делайте репо публичным с заполненным `.env`.**

---

## Принципы кастомизации

### ✅ Делайте

- Добавляйте свои модули в `setup/modules/`
- Расширяйте `claude-config/` своими правилами/хуками
- Меняйте systemd-параметры (Nice, IOSchedulingClass) под свою нагрузку
- Делайте PR с улучшениями обратно в upstream если они общеполезны

### ❌ Не делайте

- Не редактируйте файлы в `~/.claude/agents/`, `~/.claude/skills/` напрямую (они из ECC base, при обновлении затрутся) — добавляйте свои отдельно
- Не коммитьте `.env`, `~/.secrets/*`, OAuth-токены, пароли
- Не убирайте проверки `check_requirement_or_skip` — они защищают пользователей от установки сломанных модулей

---

## Поддержка форков

Если активно поддерживаете свой форк — синхронизируйте с upstream раз в месяц:

```bash
git remote add upstream https://github.com/SergeyLikholat/claude-code-server-kit
git fetch upstream
git merge upstream/main
# Разрешите конфликты, проверьте что ваши кастомизации не сломались
git push origin main
```

---

## Куда копать дальше

- [ARCHITECTURE.md](../ARCHITECTURE.md) — как всё устроено
- [Issues](https://github.com/SergeyLikholat/claude-code-server-kit/issues) — задайте вопрос
- [Discussions](https://github.com/SergeyLikholat/claude-code-server-kit/discussions) — обсуждения
