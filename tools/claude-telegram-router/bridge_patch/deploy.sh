#!/usr/bin/env bash
# Deploy VS Code Live bridge to live daemon.
# Atomic: backup originals, copy patches in, restart service, verify.
# On failure: auto-rollback from backups.

set -euo pipefail

PATCH_DIR=/opt/claude-telegram-router/bridge_patch
LIVE_DIR=/opt/claude-telegram-router
STATE_DIR=/root/.claude/channels/telegram
TS=$(date +%Y%m%d-%H%M%S)
SVC=tg-router.service

echo "=== VS Code Live bridge deploy [$TS] ==="

# Pre-flight: ensure all patch files exist + syntax OK
for f in bridge.js commands.js index.js routing.json vscode_bridge.json; do
  [ -f "$PATCH_DIR/$f" ] || { echo "ERR: missing $PATCH_DIR/$f"; exit 1; }
done
node -c "$PATCH_DIR/bridge.js"   || { echo "ERR: bridge.js bad syntax"; exit 1; }
node -c "$PATCH_DIR/commands.js" || { echo "ERR: commands.js bad syntax"; exit 1; }
node -c "$PATCH_DIR/index.js"    || { echo "ERR: index.js bad syntax"; exit 1; }
python3 -c "import json; json.load(open('$PATCH_DIR/routing.json'))" \
  || { echo "ERR: routing.json bad JSON"; exit 1; }
python3 -c "import json; json.load(open('$PATCH_DIR/vscode_bridge.json'))" \
  || { echo "ERR: vscode_bridge.json bad JSON"; exit 1; }
echo "[ok] all patch files validated"

# Backup originals
echo "[..] backing up originals"
cp "$LIVE_DIR/commands.js"  "$LIVE_DIR/commands.js.bak.$TS"
cp "$LIVE_DIR/index.js"     "$LIVE_DIR/index.js.bak.$TS"
cp "$STATE_DIR/routing.json" "$STATE_DIR/routing.json.bak.$TS"
echo "[ok] backups: *.bak.$TS"

# Apply
echo "[..] applying patch files"
cp "$PATCH_DIR/bridge.js"          "$LIVE_DIR/bridge.js"
cp "$PATCH_DIR/commands.js"        "$LIVE_DIR/commands.js"
cp "$PATCH_DIR/index.js"           "$LIVE_DIR/index.js"
cp "$PATCH_DIR/routing.json"       "$STATE_DIR/routing.json"
# state file: only create if doesn't exist (preserve any user-made state)
[ -f "$STATE_DIR/vscode_bridge.json" ] || cp "$PATCH_DIR/vscode_bridge.json" "$STATE_DIR/vscode_bridge.json"
echo "[ok] files in place"

# Restart
echo "[..] restarting $SVC"
systemctl restart "$SVC"
sleep 3

# Verify
if systemctl is-active --quiet "$SVC"; then
  echo "[ok] $SVC active after restart"
  echo ""
  echo "=== DEPLOY SUCCESS ==="
  echo "Backups: $LIVE_DIR/*.bak.$TS, $STATE_DIR/routing.json.bak.$TS"
  echo "Rollback: bash $PATCH_DIR/rollback.sh $TS"
  exit 0
else
  echo "[ERR] $SVC failed to start — auto-rollback"
  cp "$LIVE_DIR/commands.js.bak.$TS"  "$LIVE_DIR/commands.js"
  cp "$LIVE_DIR/index.js.bak.$TS"     "$LIVE_DIR/index.js"
  cp "$STATE_DIR/routing.json.bak.$TS" "$STATE_DIR/routing.json"
  rm -f "$LIVE_DIR/bridge.js"
  systemctl restart "$SVC"
  sleep 3
  if systemctl is-active --quiet "$SVC"; then
    echo "[ok] rollback successful — $SVC running on old code"
  else
    echo "[CRIT] $SVC still not running after rollback — manual intervention needed"
  fi
  echo "=== DEPLOY FAILED ==="
  journalctl -u "$SVC" -n 30 --no-pager
  exit 2
fi
