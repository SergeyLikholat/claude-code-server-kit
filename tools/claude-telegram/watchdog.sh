#!/usr/bin/env bash
# Keeps a detached tmux session with `claude --channels plugin:telegram@...`
# alive forever. If claude crashes and the tmux session ends, this watchdog
# respawns it. Runs under systemd with Restart=always for defense-in-depth.
set -uo pipefail

SESSION=claude-telegram
WORKDIR=/root
CLAUDE_ARGS='--channels plugin:telegram@claude-plugins-official --allowedTools Bash Read Write Edit Glob Grep Agent WebFetch WebSearch mcp__plugin_telegram_telegram__reply mcp__plugin_telegram_telegram__react mcp__plugin_telegram_telegram__edit_message mcp__plugin_telegram_telegram__download_attachment mcp__yougile__yougile_list_projects mcp__yougile__yougile_list_boards mcp__yougile__yougile_list_columns mcp__yougile__yougile_list_tasks mcp__yougile__yougile_get_task mcp__yougile__yougile_create_task mcp__yougile__yougile_update_task mcp__yougile__yougile_list_contacts mcp__yougile__yougile_create_contact mcp__yougile__yougile_list_comments mcp__yougile__yougile_add_comment mcp__yougile__yougile_list_stickers mcp__plugin_context7_context7__resolve-library-id mcp__plugin_context7_context7__query-docs'

export PATH="/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export HOME=/root

log() { printf '%s claude-telegram: %s\n' "$(date -Is)" "$*" >&2; }

# Resolve the claude binary. There is no /usr/bin/claude on this host —
# the only working binary ships inside the VS Code extension. The version
# is part of the path, so glob and pick the newest install at each spawn
# so we survive extension updates.
resolve_claude_bin() {
  local candidate
  for candidate in \
    /usr/local/bin/claude \
    /usr/bin/claude \
    /root/.bun/bin/claude \
    /root/.local/bin/claude
  do
    [[ -x "$candidate" ]] && { echo "$candidate"; return 0; }
  done
  candidate=$(ls -1dt /root/.vscode-server/extensions/anthropic.claude-code-*-linux-x64/resources/native-binary/claude 2>/dev/null | head -1)
  [[ -n "$candidate" && -x "$candidate" ]] && { echo "$candidate"; return 0; }
  return 1
}

log "watchdog started (pid $$)"

while true; do
  if ! tmux has-session -t "$SESSION" 2>/dev/null; then
    log "session missing — resolving claude binary"
    if ! CLAUDE_BIN=$(resolve_claude_bin); then
      log "no claude binary found, retrying in 30s"
      sleep 30
      continue
    fi
    log "using claude binary: $CLAUDE_BIN"
    CLAUDE_CMD="exec $CLAUDE_BIN $CLAUDE_ARGS"
    if tmux -u new-session -d -s "$SESSION" -x 200 -y 50 -c "$WORKDIR" "$CLAUDE_CMD"; then
      log "session started"
    else
      log "tmux new-session failed, retrying in 30s"
    fi
  fi
  sleep 30
done
