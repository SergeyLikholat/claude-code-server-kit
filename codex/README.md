# Codex: та же обвязка, что у Claude Code

Codex — резервная модель в T3. Этот каталог даёт ему правила, память, хуки, скиллы и MCP
из настроек Claude. Источник правды остаётся у Claude, здесь только переходники и сборка.

## Запуск

```bash
bash /root/projects/claude-code-server-kit/codex/sync.sh            # собрать и применить
bash /root/projects/claude-code-server-kit/codex/sync.sh --dry-run  # только показать
```

Cron пересобирает каждую ночь в 03:35 (лог — `codex/sync.log`), так что правки `/root/CLAUDE.md`,
правил и новые скиллы доходят до Codex сами. Новые треды Codex в T3 подхватывают настройки
сразу, уже открытые — после перезапуска треда. Перезапускать службу T3 не нужно.

## Что собирается

| Что | Куда | Откуда |
|---|---|---|
| Правила | `~/.codex/AGENTS.md` | `AGENTS.header.md` + `/root/CLAUDE.md` + `~/.claude/rules/{common,web}` |
| Правила проектов | — | Codex читает `CLAUDE.md` проекта, если нет `AGENTS.md` (`project_doc_fallback_filenames`) |
| Хуки | `~/.codex/hooks.json` | см. ниже; чужие хуки (Orca) сохраняются |
| Скиллы | `~/.agents/skills/<имя>` | ссылки на `~/.claude/skills/<имя>` |
| MCP | `~/.codex/config.toml` | глобальные stdio-серверы из `~/.claude.json` (сейчас `gsheets`) |
| Параметры | `~/.codex/config.toml` | лимит AGENTS.md 128 КБ, веб-поиск, встроенная память Codex выключена |

Хуки:

| Событие | Хук | Зачем |
|---|---|---|
| SessionStart | `~/.claude/scripts/hooks/session-start-memory-index.js` | путеводитель по памяти |
| SessionStart | `hooks/project-memory.js` | авто-память кабинета + общий индекс правил про Сергея |
| UserPromptSubmit | `~/.claude/scripts/hooks/memory-retrieval.js` | релевантная память по запросу |
| PreToolUse | `hooks/codex-adapter.js` → `hooks/protect-claude-config.js` | запрет правки settings.json, .credentials.json, .env, plugins/ |
| PreToolUse | `hooks/codex-adapter.js` → `outbound-text-guard.js` | напоминание про конвейер текстов наружу |
| PostToolUse | `post-bash-command-log.js audit` | журнал команд в `~/.claude/bash-commands.log` |

`codex-adapter.js` переводит `apply_patch` Codex в Write/Edit, которые ждут хуки Claude.

## Память

Общая с Claude. Сессии Codex (`~/.codex/sessions/`) читает ночная выжимка
`~/.claude/scripts/cron/digest-jsonl.js` и раскладывает по проектам с пометкой «Модель: Codex».
Записывать новые факты Codex умеет сам, формат описан в `AGENTS.header.md`.

## Грабли

- **Codex запускает только доверенные хуки.** Хеш каждого хука хранится в `config.toml`
  (`[hooks.state]`). После любой правки `hooks.json` нужен `trust_hooks.py`: `sync.sh` вызывает его сам.
  Хеши отдаёт `codex app-server` → `hooks/list` (клиент — `appserver.py`).
- `config.toml` правится через `config/batchWrite` app-server, а не руками, чтобы не испортить TOML.
- `codex exec` без `</dev/null` ждёт ввода и висит.
- В T3 Codex работает в кодовом режиме (`exec` с JS), но хуки всё равно получают обычные
  `Bash` и `apply_patch` (проверено с `gpt-6-astra`).
- Субагенты Claude (`~/.claude/agents`) не переносятся.

## Новый сервер

Поставить Codex, войти (`codex login --device-auth`), затем запустить `sync.sh`, добавить строку cron
и, если на сервере старая выжимка, скопировать `codex/digest-jsonl.js` в `~/.claude/scripts/cron/` (копия версии с чтением сессий Codex на 2026-11-06).

## Серверы, поставленные kit (сотрудники)

`sync.sh` сам определяет устройство сервера:

| Устройство | Признак | Хуки памяти | Шапка правил |
|---|---|---|---|
| сервер Сергея | есть `~/.claude/scripts/hooks/memory-retrieval.js` | `node ~/.claude/scripts/hooks/*` | `AGENTS.header.md` + `/root/CLAUDE.md` |
| сервер kit | есть `~/llm-memory-kit/run.sh` | `bash ~/llm-memory-kit/run.sh hooks/*` | `AGENTS.header.kit.md`, без личных правил |

Охрана текстов наружу и журнал команд подключаются, только если такие хуки есть на сервере.
Правила разработки берутся из `~/.claude/rules/{common,web}` или `~/.claude/rules/ecc/{common,web}`.

Сессии Codex на серверах kit читает сам `llm-memory-kit` (`core/digest.js`, переменная
`MEMKIT_CODEX_SESSIONS`), копировать `digest-jsonl.js` не нужно.

Порядок: `npm i -g @openai/codex`, `bash codex/sync.sh`, строка cron
`35 3 * * * /bin/bash <kit>/codex/sync.sh >> <kit>/codex/sync.log 2>&1`. Вход в Codex
(`codex login --device-auth`) — только когда он реально нужен: без входа обвязка просто ждёт.

## Проверка памяти на серверах

`tools/memory-audit/audit.sh` — только чтение: для каждого пользователя с `~/llm-memory-kit`
показывает хуки, cron, последнюю выжимку, число тем и сессии вне папки проектов.

```bash
ssh <сервер> 'bash -s' < tools/memory-audit/audit.sh
```
