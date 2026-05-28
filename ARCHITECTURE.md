# Architecture — как устроен kit внутри

> Этот документ для тех кто хочет понять/доработать систему. Если вы пользователь — [README.md](README.md) и [MODULES.md](MODULES.md) хватит.

---

## Слоёная архитектура

```
┌────────────────────────────────────────────────────────────────┐
│  Layer 3: claude-code-server-kit (этот репозиторий)            │
│                                                                │
│   ┌──────────────────────────────────────────────────────┐    │
│   │  Core (обязательно):                                  │    │
│   │  • install.sh orchestrator                            │    │
│   │  • setup/core/ — preflight + claude-cli + ecc-base    │    │
│   │  • claude-config/ — generic settings/hooks/commands   │    │
│   └──────────────────────────────────────────────────────┘    │
│                                                                │
│   ┌──────────────────────────────────────────────────────┐    │
│   │  Modules (опционально):                               │    │
│   │  • tg-bot      → /opt/claude-telegram + systemd       │    │
│   │  • backup      → restic+rclone → Я.Диск               │    │
│   │  • parakeet    → /opt/parakeet-server + модель        │    │
│   │  • claude-mem  → plugin install + worker daemon       │    │
│   │  • helpers     → /opt/{nanobanana,gemini-tts,...}     │    │
│   │  • hooks-extras → ~/.claude/hooks/*                    │    │
│   └──────────────────────────────────────────────────────┘    │
├────────────────────────────────────────────────────────────────┤
│  Layer 2: everything-claude-code (community)                   │
│  https://github.com/affaan-m/everything-claude-code            │
│                                                                │
│  • ~150 skills (python-testing, kotlin-patterns, etc.)         │
│  • ~50 agents (code-reviewer, planner, etc.)                   │
│  • Rules для разных языков                                     │
│  • Slash-команды (/code-review, /docs, etc.)                   │
│  • MCP-конфиги                                                 │
├────────────────────────────────────────────────────────────────┤
│  Layer 1: Claude Code CLI (Anthropic)                          │
│  • Сам движок                                                  │
│  • Аутентификация в Anthropic API                              │
│  • Базовые инструменты (Read/Write/Edit/Bash/etc.)             │
│  • Plugin/MCP протоколы                                        │
└────────────────────────────────────────────────────────────────┘
```

**Принцип:** kit ничего не переизобретает — только склеивает существующее в готовую сборку.

---

## Что ставится куда

```
/
├── opt/                                   # Кастомные tools (модули)
│   ├── claude-telegram/                  # ← tg-bot
│   ├── claude-telegram-router/           # ← tg-bot
│   ├── parakeet-server/                  # ← parakeet
│   ├── nanobanana/                       # ← helpers
│   ├── gemini-tts/                       # ← helpers
│   ├── openpyxl_safe/                    # ← helpers
│   └── tg-md/                            # ← helpers
│
├── etc/systemd/system/                    # Systemd unit-ы (через symlink)
│   ├── claude-telegram.service           # ← tg-bot
│   ├── tg-router.service                 # ← tg-bot
│   ├── parakeet-server.service           # ← parakeet
│   └── backup.{service,timer}            # ← backup
│
├── var/backups/                           # ← backup создаёт здесь
│   ├── pg/                               # PG dumps
│   ├── sqlite/                           # SQLite backups
│   ├── docker-volumes/                   # tar volumes
│   └── meta/                             # crontab, docker ps, etc.
│
└── root/                                  # User space
    ├── .ssh/                             # ← preflight-ssh
    ├── .claude/                          # Claude Code config
    │   ├── settings.json                 # ← core, генерируется из template
    │   ├── hooks/                        # ← core + hooks-extras
    │   ├── commands/                     # ← core
    │   ├── scripts/                      # ← core (lifecycle, cron)
    │   ├── plugins/                      # Claude CLI plugins (auto)
    │   ├── agents/                       # из ECC base
    │   ├── skills/                       # из ECC base
    │   └── rules/                        # из ECC base
    ├── .claude-mem/                      # ← claude-mem (SQLite + Chroma)
    ├── .config/rclone/                   # ← backup (Yandex OAuth)
    ├── .secrets/                         # ← backup, helpers (env-файлы)
    └── claude-code-server-kit/           # этот репо, склонирован
```

---

## install.sh — главный orchestrator

### Режимы запуска

```bash
sudo bash install.sh                        # core (обязательная база)
sudo bash install.sh --module NAME          # один модуль
sudo bash install.sh --module tg-bot,backup # несколько модулей
sudo bash install.sh --all                  # core + все модули
sudo bash install.sh --list                 # показать доступные модули
sudo bash install.sh --check                # проверка что установлено
```

### Поток выполнения

```
install.sh
  │
  ├── parse args (определить режим: core / module / all)
  │
  ├── load .env (если есть; если нет — interactive prompts по ходу)
  │
  ├── (если core или first run)
  │   ├── setup/core/01-prereqs.sh        # apt пакеты
  │   ├── setup/core/02-claude-cli.sh     # Claude Code CLI
  │   ├── setup/core/03-ecc-base.sh       # git clone everything-claude-code
  │   └── setup/core/04-minimal-config.sh # generate ~/.claude/settings.json
  │
  ├── (для каждого --module N):
  │   └── setup/modules/N.sh
  │       ├── check_requirements()         # есть ли нужные ключи?
  │       │   └── soft fail с инструкцией если нет
  │       ├── install_code()               # копировать в /opt
  │       ├── create_systemd_unit()        # из template + переменные
  │       ├── enable_systemd_unit()
  │       ├── update_claude_settings()     # добавить в ~/.claude/settings.json
  │       └── verify()                     # smoke test
  │
  └── summary (что установлено, что не установлено, что дальше)
```

### Soft-fail при отсутствии ключей

Каждый модуль проверяет требования **в начале**, и:
- Если ключи есть в `.env` → использует их
- Если нет в `.env`, но есть TTY → интерактивно спрашивает
- Если нет TTY и нет в `.env` → **пропускает модуль** с понятным сообщением:
  ```
  ⏩ Модуль tg-bot пропущен: не указан TELEGRAM_BOT_TOKEN в .env
     Чтобы установить позже:
       1. Создайте бота через @BotFather
       2. echo "TELEGRAM_BOT_TOKEN=ваш_токен" >> .env
       3. sudo bash install.sh --module tg-bot
  ```

Это критично: **install.sh никогда не падает** из-за отсутствия опциональных ключей.

---

## Конфигурация: .env и settings.json

### .env (на сервере, в директории kit'а)

Все опциональные переменные. Пример:
```bash
# Минимум (для core) — НИЧЕГО не обязательно
USER_NAME="Иван Петров"
USER_EMAIL="ivan@example.com"

# tg-bot (опционально)
TELEGRAM_BOT_TOKEN=""        # от @BotFather
TELEGRAM_CHAT_ID=""          # ID группы куда писать
TELEGRAM_FORUM_MODE=false    # использовать топики

# backup (опционально)
YANDEX_CLIENT_ID=""
YANDEX_CLIENT_SECRET=""
BACKUP_TARGET_PATH="/server-backups/restic-main"

# parakeet (опционально)
HUGGINGFACE_TOKEN=""         # только для скачивания модели
PARAKEET_VARIANT="parakeet"  # или "gigaam"

# helpers (опционально)
GEMINI_API_KEY=""            # для nanobanana и gemini-tts
```

### settings.json template

Шаблон в `claude-config/settings.full.json.template` со всеми возможными настройками для всех модулей. install.sh генерирует финальный `~/.claude/settings.json`:
- Из `settings.minimal.json` если стоит только core
- Из `settings.full.json.template` с подстановкой переменных, если стоят модули
- Активные модули — в комплекте, неактивные — закомментированы (или удалены)

---

## Систем демонов

Все долгоиграющие сервисы — через systemd. Юниты лежат в `systemd/*.template` и подставляются под пользовательские параметры:

```ini
# systemd/claude-telegram.service.template
[Unit]
Description=Claude Code Telegram bot daemon
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/claude-telegram
EnvironmentFile=__SECRETS_ENV_FILE__         ← заменяется на /root/.secrets/tg-bot.env
ExecStart=/usr/bin/node /opt/claude-telegram/daemon.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

При установке модуля скрипт:
1. Берёт template
2. Заменяет `__VAR__` плейсхолдеры на реальные значения
3. Сохраняет в `/etc/systemd/system/`
4. `systemctl daemon-reload && systemctl enable --now`

---

## Связь модулей между собой

Модули **могут** интегрироваться, но не **обязаны**:

- **backup** + **tg-bot** = уведомления о бэкапе приходят в TG
- **parakeet** + **tg-bot** = голосовые сообщения транскрибируются перед отправкой в Claude
- **claude-mem** + любые сессии = автоматическое сохранение контекста
- **hooks-extras** + любые модули = можно повесить хуки на любые события

Если зависимый модуль не установлен — функция просто не активируется, никаких ошибок.

---

## Безопасность

### Что НЕ хранится в репозитории

- Реальные API-ключи
- OAuth токены
- Пароли (включая restic-пароль)
- Личные данные пользователя (имена, email, telegram ID)

Всё это — только в `.env` локально на сервере (не коммитится, в .gitignore) и в `~/.secrets/` (chmod 600).

### Что коммитится

- Код (без секретов)
- Шаблоны (с плейсхолдерами `__VAR__`)
- Документация
- Примеры (`.env.example` с пустыми значениями)

### Pre-commit hook

`.git/hooks/pre-commit` (опционально) сканирует diff на:
- API-ключи (sk-, ghp_, y0_, etc.)
- Base64-строки длиной >40
- IP-адреса в файлах с явными `password` упоминаниями

Если найдено — блокирует коммит.

---

## Тестирование

### Smoke-тесты после установки

```bash
sudo bash install.sh --check
```

Показывает:
- Что установлено / что нет
- Активен ли каждый systemd-юнит
- Когда был последний бэкап
- Сколько ключей в `.env`
- Есть ли проблемы

### Полный тест на чистом VPS

`tests/full-install.sh` — поднимает Docker-контейнер Ubuntu 24.04, прогоняет полную установку, проверяет результат. Используется в CI.

---

## CI/CD (опционально)

Если хотите автоматическую проверку при PR:
```yaml
# .github/workflows/test-install.yml
on: [push, pull_request]
jobs:
  test-install:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: docker run --rm -v $PWD:/kit ubuntu:24.04 bash /kit/tests/full-install.sh
```

---

## Где смотреть код

| Что | Где |
|---|---|
| Скрипты установки | [setup/](setup/) |
| Главный orchestrator | [install.sh](install.sh) |
| SSH-настройка | [preflight-ssh.sh](preflight-ssh.sh) |
| Tools (которые лягут в /opt) | [tools/](tools/) |
| Systemd шаблоны | [systemd/](systemd/) |
| Claude config шаблоны | [claude-config/](claude-config/) |
| Backup-система | [backup/](backup/) |

---

## Хочу что-то изменить под себя

См. [ADAPT.md](docs/ADAPT.md).

## Хочу контрибьютить

См. [CONTRIBUTING.md](CONTRIBUTING.md) (TODO).
