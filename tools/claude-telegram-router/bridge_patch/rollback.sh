#!/usr/bin/env bash
# Manual rollback to a specific backup timestamp.
# Usage: bash rollback.sh <TIMESTAMP>
# Find timestamps: ls /opt/claude-telegram-router/*.bak.*

set -euo pipefail

TS="${1:-}"
if [ -z "$TS" ]; then
  echo "Usage: $0 <YYYYMMDD-HHMMSS>"
  echo ""
  echo "Available backups:"
  ls /opt/claude-telegram-router/*.bak.* 2>/dev/null | sed 's/.*\.bak\.//' | sort -u
  exit 1
fi

LIVE_DIR=/opt/claude-telegram-router
STATE_DIR=/root/.claude/channels/telegram
SVC=tg-router.service

for f in commands.js index.js; do
  [ -f "$LIVE_DIR/$f.bak.$TS" ] || { echo "ERR: $LIVE_DIR/$f.bak.$TS not found"; exit 1; }
done
[ -f "$STATE_DIR/routing.json.bak.$TS" ] || { echo "ERR: routing.json.bak.$TS not found"; exit 1; }

echo "Restoring backups from $TS"
cp "$LIVE_DIR/commands.js.bak.$TS"   "$LIVE_DIR/commands.js"
cp "$LIVE_DIR/index.js.bak.$TS"      "$LIVE_DIR/index.js"
cp "$STATE_DIR/routing.json.bak.$TS" "$STATE_DIR/routing.json"
rm -f "$LIVE_DIR/bridge.js"

systemctl restart "$SVC"
sleep 3

if systemctl is-active --quiet "$SVC"; then
  echo "[ok] $SVC running after rollback"
else
  echo "[CRIT] $SVC failed after rollback"
  journalctl -u "$SVC" -n 30 --no-pager
fi
