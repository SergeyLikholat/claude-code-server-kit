#!/usr/bin/env bash
# Вернуться на предыдущую версию (или указанную).
#   rollback.sh            — на ту, что была до последнего переключения
#   rollback.sh 0.0.42     — на конкретную
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; source "$HERE/lib/switch.sh"
TARGET="${1:-$(cat /root/.t3/runtime/.t3-patch-previous 2>/dev/null || true)}"
[ -n "$TARGET" ] || { echo "не знаю, на что откатывать — укажи версию" >&2; exit 1; }
[ -f "/root/.t3/runtime/versions/$TARGET/.install-complete" ] || { echo "нет установленной $TARGET" >&2; exit 1; }
switch_to "$TARGET"
