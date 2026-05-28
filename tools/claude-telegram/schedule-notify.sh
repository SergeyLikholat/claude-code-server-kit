#!/usr/bin/env bash
# Schedule a one-shot Telegram notification via systemd-run (--on-active=...).
#
# Usage:
#   schedule-notify.sh <delay> <chat_id> [--thread <thread_id>] <message...>
#
#   <delay>     systemd time spec, e.g. 5min, 2h, 90min, 1h30min, 2h15m.
#               See systemd.time(7).
#   <chat_id>   Telegram chat id (e.g. -1001234567890).
#   --thread    Optional forum topic id.
#   <message>   Free-form text. Quote it or rely on shell collapsing.
#
# Example:
#   schedule-notify.sh 5min -1001234567890 --thread 4 "Записать препараты"
#
# The reminder runs as a transient systemd unit named hc-reminder-<timestamp>-<rand>
# and survives this shell exiting / claude session ending. It does NOT survive
# a host reboot. For multi-day reminders use a real systemd timer instead.

set -euo pipefail

if [[ $# -lt 3 ]]; then
  cat >&2 <<'USAGE'
usage: schedule-notify.sh <delay> <chat_id> [--thread <thread_id>] <message...>
example: schedule-notify.sh 5min -1001234567890 --thread 4 "Записать препараты"
USAGE
  exit 2
fi

DELAY="$1"; shift
CHAT_ID="$1"; shift

THREAD_ARGS=()
if [[ "${1:-}" == "--thread" ]]; then
  shift
  THREAD_ID="${1:?--thread requires an id}"; shift
  THREAD_ARGS=(--thread "$THREAD_ID")
fi

MESSAGE="$*"
[[ -n "$MESSAGE" ]] || { echo "schedule-notify.sh: empty message" >&2; exit 2; }

UNIT="hc-reminder-$(date +%s)-$RANDOM"

systemd-run \
  --quiet \
  --on-active="$DELAY" \
  --unit="$UNIT" \
  --description="Claude Telegram reminder: $MESSAGE" \
  /opt/claude-telegram/notify.sh "$CHAT_ID" "${THREAD_ARGS[@]}" "$MESSAGE"

echo "scheduled: unit=$UNIT delay=$DELAY chat=$CHAT_ID${THREAD_ARGS:+ thread=${THREAD_ARGS[1]}}"
echo "fires at:  $(date -d "+$DELAY" '+%Y-%m-%d %H:%M:%S')"
echo "cancel:    systemctl stop $UNIT.timer ${UNIT}.service"
echo "list:      systemctl list-timers 'hc-reminder-*'"
