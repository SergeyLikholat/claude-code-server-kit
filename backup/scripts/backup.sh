#!/bin/bash
# backup.sh — главный orchestrator ночного бэкапа.
# Запускается из systemd backup.timer в 03:00.

set -uo pipefail

SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"
source "$SCRIPT_DIR/restic-env.sh"

INCLUDES_FILE="/opt/backup/includes.txt"
EXCLUDE_FILE="/opt/backup/exclude.txt"
LOG="/var/log/backup-main.log"
START=$(date +%s)
HOST=$(hostname -s)
DAY_OF_WEEK=$(date +%u)

log() { echo "[backup $(date +%H:%M:%S)] $*" | tee -a "$LOG"; }
fail() {
  local stage="$1"
  log "❌ FAIL at: $stage"
  bash "$SCRIPT_DIR/notify.sh" "❌ Backup FAILED — $stage" "См. $LOG (последние строки):
$(tail -20 $LOG)" || true
  exit 1
}

log "================== START $(date) =================="

# 1. Pre-backup
log "Stage 1/5: pre-backup (дампы PG/SQLite, tar volumes)"
bash "$SCRIPT_DIR/pre-backup.sh" >>"$LOG" 2>&1 || fail "pre-backup"

# 2. restic backup
log "Stage 2/5: restic backup → удалённый репозиторий"
restic backup \
  --files-from "$INCLUDES_FILE" \
  --exclude-file "$EXCLUDE_FILE" \
  --tag nightly \
  --host "$HOST" \
  >>"$LOG" 2>&1 || fail "restic backup"

# 3. Retention
log "Stage 3/5: forget + prune (keep 7d/4w/6m)"
restic forget --tag nightly --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune \
  >>"$LOG" 2>&1 || log "⚠ forget/prune вернул ошибку (бэкап уже сохранён)"

# 4. Check
if [ "$DAY_OF_WEEK" = "7" ]; then
  log "Stage 4/5: restic check (метаданные + 10% данных, воскресенье)"
  restic check --read-data-subset=10% >>"$LOG" 2>&1 || log "⚠ deep check вернул ошибку"
else
  log "Stage 4/5: restic check (метаданные, будни)"
  restic check >>"$LOG" 2>&1 || log "⚠ check вернул ошибку"
fi

# 5. Метрики и уведомление
END=$(date +%s)
DUR=$((END - START))
DUR_MIN=$((DUR / 60))
DUR_SEC=$((DUR % 60))

SNAPSHOT_ID=$(restic snapshots --tag nightly --host "$HOST" --json 2>/dev/null \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d[-1]["short_id"]) if d else print("?")' 2>/dev/null \
  || echo "?")

REPO_SIZE=$(rclone size "$(echo $RESTIC_REPOSITORY | sed 's|^rclone:||')" --json 2>/dev/null \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);print(f"{d[\"bytes\"]/(1024**3):.2f} GB ({d[\"count\"]} объектов)")' 2>/dev/null \
  || echo "—")

SNAP_COUNT=$(restic snapshots --tag nightly --json 2>/dev/null \
  | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))' 2>/dev/null || echo "?")

log "==================  DONE in ${DUR_MIN}m ${DUR_SEC}s =================="

bash "$SCRIPT_DIR/notify.sh" "✅ Backup OK" \
"snapshot: \`${SNAPSHOT_ID}\`
репо: ${REPO_SIZE}
снапшотов: ${SNAP_COUNT}
длительность: ${DUR_MIN} мин ${DUR_SEC} сек" \
  || log "⚠ notify не отправился"
