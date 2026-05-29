#!/usr/bin/env bash
# Send a Telegram message via the Claude bot.
# Usage:
#   notify.sh <chat_id> <message>                     # DM or general topic
#   notify.sh <chat_id> --thread <thread_id> <message>  # forum topic
#
# The bot token is read from /root/.claude/channels/telegram/.env (TELEGRAM_BOT_TOKEN).
# Never echo the token. All output goes to stderr unless explicitly stdout.

set -euo pipefail

ENV_FILE="/root/.claude/channels/telegram/.env"
[[ -r "$ENV_FILE" ]] || { echo "notify.sh: missing $ENV_FILE" >&2; exit 1; }
# shellcheck disable=SC1090
source "$ENV_FILE"
: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN not set in $ENV_FILE}"

if [[ $# -lt 2 ]]; then
  echo "usage: notify.sh <chat_id> [--thread <thread_id>] <message>" >&2
  exit 2
fi

CHAT_ID="$1"; shift
THREAD_ID=""
if [[ "${1:-}" == "--thread" ]]; then
  shift
  THREAD_ID="${1:?--thread requires an id}"; shift
fi
MESSAGE="$*"
[[ -n "$MESSAGE" ]] || { echo "notify.sh: empty message" >&2; exit 2; }

API="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage"

ARGS=(--silent --show-error --fail
      --data-urlencode "chat_id=${CHAT_ID}"
      --data-urlencode "text=${MESSAGE}"
      --data-urlencode "disable_notification=false")
[[ -n "$THREAD_ID" ]] && ARGS+=(--data-urlencode "message_thread_id=${THREAD_ID}")

# Suppress URL from any error output to avoid token leaks in logs.
if ! response="$(curl "${ARGS[@]}" "$API" 2>&1)"; then
  echo "notify.sh: telegram api call failed" >&2
  exit 3
fi
echo "$response"
