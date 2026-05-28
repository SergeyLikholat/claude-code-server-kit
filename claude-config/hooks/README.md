# ~/.claude/hooks/ — Хуки для Claude Code

Хуки — это скрипты которые Claude запускает на определённых событиях:
- `PreToolUse` — перед выполнением tool (валидация, блокировка)
- `PostToolUse` — после выполнения tool (форматирование, проверка)
- `SessionStart` — в начале сессии (загрузка контекста)
- `Stop` — в конце сессии (финальные проверки)

## Активация хука

В `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "command": "/root/.claude/hooks/example-on-edit.sh",
        "description": "Что делать после правки файла"
      }
    ]
  }
}
```

## Примеры в этом каталоге

- `example-on-edit.sh` — простейший пример: пишет в лог что был edit
- `example-format-on-save.sh` — запускает prettier/black на отредактированных файлах
- `example-block-large-writes.sh` — блокирует Write больше 800 строк

Полная документация: https://docs.claude.com/en/docs/claude-code/hooks
