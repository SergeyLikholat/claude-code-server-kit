# V2 Multi-User — несколько пользователей на одном сервере

V2 позволяет нескольким пользователям работать на одном сервере, разделяя ресурсы (подписка Claude, тулы), но с изолированными «мирами»: свои проекты, настройки, `CLAUDE.md`, правила и память. Админ-директории защищены правами ОС.

## Модель

```
admin (root или sudo-юзер)   /root (700)        — секреты, restic, rclone, мастер-credential
userA                        /home/userA (700)  — свой мир, группы ccusers+sharedproj
userB                        /home/userB (700)  — свой мир, группы ccusers+sharedproj

Общее (shared):
  /usr/local/bin/claude          — Claude CLI (один на всех)
  /opt/ecc-base                  — everything-claude-code (read-only)
  /opt/claude-telegram-router    — код роутера (инстансы per-user)
  /opt/context-mgr               — код context-mgr (конфиг per-user)
  /srv/shared/projects (2775)    — общие проекты (группа sharedproj)
  parakeet (опц.)                — транскрипция голоса

Per-user (изолировано в ~/):
  ~/.claude/{settings.json, CLAUDE.md, rules, projects, channels/telegram}
  ~/.claude/.credentials.json    — копия общей подписки (600)
  ~/projects                     — личные проекты
  ~/obsidian                     — vault (тематическая память)
  ~/_infra/context-mgr           — per-user context-mgr (config.json)
```

### Изоляция (важно)
- **Между пользователем и админом — настоящая (OS-уровень).** `/root` и `/home/admin` под `chmod 700`; пользователи НЕ в sudoers и НЕ в группе admin. Даже через `Bash`-инструмент Claude пользователь не прочитает админ-секреты — ядро откажет.
- **Между пользователями — естественная** (разные Unix-аккаунты, home 700). Общее — только `/srv/shared/projects`.
- **Ключевой принцип:** воркер Claude работает под Unix-аккаунтом пользователя с `Bash` + `--permission-mode dontAsk`. Пользователь — «root на своей территории», но не за её пределами. Защита держится на правах ОС, не на промпте.

## Установка

```bash
# 1. Общая инфра (один раз, под root)
sudo bash install.sh --shared-infra
#    (опц. с транскрипцией голоса:)
#    sudo bash setup/shared-infra.sh --with-parakeet

# 2. Авторизовать общую подписку Claude (один раз)
claude          # пройти OAuth под root → создастся /root/.claude/.credentials.json

# 3. Завести пользователей
sudo bash install.sh --provision-user alice
sudo bash install.sh --provision-user bob
#    (каждому нужен свой Telegram bot token — спросит интерактивно)

# 4. Пароли для SSH/VS Code
sudo passwd alice
sudo passwd bob

# 5. Защитить админа
sudo bash install.sh --harden-admin
#    (если админ — отдельный юзер: --harden-admin --admin-user adminname)
```

После ре-авторизации общей подписки обнови копии у пользователей:
```bash
sudo bash setup/provision-user.sh alice --sync-creds
```

## Доступ пользователя

- **Telegram:** свой бот (отдельный токен). Роутер `tg-router@alice` отвечает в bridged-режиме (без telegram-mcp плагина — демон сам забирает ответ из JSONL и шлёт).
- **VS Code/SSH:** логин под своим аккаунтом (`ssh alice@server`), работает в своём `~/`.

## Память

Без `claude-mem`. Вся долгосрочная память — per-user:
- `context-mgr` (`~/_infra/context-mgr/`) каждые 5 мин мониторит размер сессий, при росте сжимает в дайджест (Sonnet), при переполнении делает hard-reset с сохранением памяти.
- Дайджесты + хронология тем → `~/obsidian/` (Obsidian-граф). Claude читает vault как тематическую память (правило в `CLAUDE.md`).
- Контекст между пользователями НЕ пересекается (разные vault, разные сессии).

## Общая подписка

Один Anthropic-аккаунт обслуживает все «миры» — это один и тот же человек, работающий из нескольких ролей/аккаунтов (например, для сравнения подходов или ролевой проработки). Технические нюансы:
- **Лимиты подписки — общие** на все миры (при одновременной работе нескольких ботов/сессий они суммируются; возможны 429 при пиковой нагрузке).
- OAuth-токен рефрешится в каждой копии `~/.claude/.credentials.json` независимо — при ре-авторизации мастера обнови копии: `provision-user.sh <name> --sync-creds`.

Если в какой-то момент захочется развести миры на отдельные биллинги — можно выдать каждому свой API-ключ (положить в `~/.claude`), но по умолчанию используется один общий credential.

## Verification

```bash
# Изоляция админа
sudo -u alice cat /root/.secrets/* 2>&1 | grep -q "Permission denied" && echo OK
sudo -u alice ls /root 2>&1 | grep -q "Permission denied" && echo OK
sudo -u alice sudo -n true 2>&1 | grep -qi "not allowed\|password" && echo "not sudoer OK"

# Боты (разные токены/процессы/runtime)
systemctl is-active tg-router@alice tg-router@bob
ls -d /run/claude-telegram-alice /run/claude-telegram-bob

# Нет telegram-mcp плагина — ответ через bridged auto-pull
sudo -u alice claude plugin list 2>/dev/null | grep -q telegram && echo "FAIL" || echo "no plugin OK"

# claude доступен не-root
sudo -u alice claude --version

# Раздельная память
sudo -u alice test -d ~alice/obsidian && sudo -u bob test -d ~bob/obsidian && echo OK
systemctl is-active ctx-mgr-monitor@alice.timer ctx-mgr-monitor@bob.timer
test ! -d ~alice/.claude-mem && echo "no claude-mem OK"

# Shared ECC read-only
sudo -u alice test -r /opt/ecc-base && sudo -u alice touch /opt/ecc-base/x 2>&1 | grep -q "Permission denied" && echo "RO OK"

# Shared проекты setgid
sudo -u alice touch /srv/shared/projects/t && stat -c '%G' /srv/shared/projects/t   # sharedproj

# Credential 600 per-user
stat -c '%a %U' ~alice/.claude/.credentials.json   # 600 alice

# Полная проверка изоляции одной командой
sudo bash install.sh --harden-admin   # переrun идемпотентен, печатает матрицу
```

## Откат / удаление пользователя

```bash
systemctl disable --now tg-router@alice ctx-mgr-monitor@alice.timer ctx-mgr-daily@alice.timer
sudo userdel -r alice          # -r удалит home (ОСТОРОЖНО: vault + проекты)
```
