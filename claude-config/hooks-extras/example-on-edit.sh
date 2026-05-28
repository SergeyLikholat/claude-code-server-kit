#!/bin/bash
# Example PostToolUse hook: пишет в лог что был отредактирован файл.
# Активируется в ~/.claude/settings.json:
#   "hooks": { "PostToolUse": [ { "matcher": "Write|Edit", "command": "/root/.claude/hooks/example-on-edit.sh" } ] }
#
# stdin: JSON с tool_input от Claude Code

LOG=/var/log/claude-edits.log
mkdir -p "$(dirname "$LOG")"

# Прочитать stdin (там tool_input от Claude)
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("tool_input",{}).get("file_path",""))' 2>/dev/null)

echo "[$(date)] edited: $FILE_PATH" >> "$LOG"
