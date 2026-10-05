#!/usr/bin/env bash
# Поставить собранную версию рядом со штатной и переключиться на неё.
#   install.sh <каталог из /root/.cache/t3-build/out/, например 0.0.42-s6>
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; source "$HERE/lib/switch.sh"
NAME="${1:?укажи имя сборки, например 0.0.42-s6}"
SRC=/root/.cache/t3-build/out/$NAME
DST=/root/.t3/runtime/versions/$NAME
[ -x "$SRC/t3" ] || { echo "нет сборки $SRC — сначала build.sh" >&2; exit 1; }
[ -e "$DST" ] && { echo "$DST уже есть — удали его или собери с другим номером" >&2; exit 1; }
cp -a "$SRC" "$DST"
printf '%s\n' "$NAME" > "$DST/.install-complete"
echo "установлено: $DST"
switch_to "$NAME"
