#!/usr/bin/env bash
# Show status of the persistent claude-telegram session.
SESSION=claude-telegram
if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "SESSION: running"
  # Show window info
  tmux list-windows -t "$SESSION" 2>/dev/null
  echo ""
  echo "Processes inside tmux:"
  # Find the tmux server and its children
  pgrep -af "claude --channels plugin:telegram" || echo "(none)"
  echo ""
  echo "Bun telegram:"
  pgrep -af "bun.*telegram.*server.ts" || echo "(none)"
  echo ""
  echo "Polling lock/pid:"
  cat /root/.claude/channels/telegram/polling.lock 2>/dev/null && echo " ^ polling.lock"
  cat /root/.claude/channels/telegram/bot.pid 2>/dev/null && echo " ^ bot.pid"
  echo ""
  echo "Attach with: tmux attach -t $SESSION  (Ctrl-b d to detach)"
else
  echo "SESSION: stopped"
  exit 1
fi
