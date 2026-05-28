#!/bin/bash
# Example PreToolUse hook: блокирует Write если контент превышает 800 строк.
# Активируется в settings.json для matcher "Write".
#
# stdin: JSON с tool_input
# Exit code 2 = блокировка с сообщением для Claude

INPUT=$(cat)
CONTENT=$(echo "$INPUT" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("tool_input",{}).get("content",""))' 2>/dev/null)
LINES=$(echo "$CONTENT" | wc -l)

MAX_LINES=800
if [ "$LINES" -gt "$MAX_LINES" ]; then
  echo "[Hook] BLOCKED: файл превышает $MAX_LINES строк ($LINES). Разбейте на модули." >&2
  exit 2
fi

# Пропускаем
echo "$INPUT"
exit 0
