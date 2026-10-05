#!/usr/bin/env bash
# Общая часть install.sh и rollback.sh.
#
# Как T3 запускается на этом сервере: override юнита
# /root/.config/systemd/user/t3code.service.d/override.conf запускает
# `/root/.local/bin/t3 serve --port 7373 ...` напрямую, минуя штатный загрузчик.
# /root/.local/bin/t3 — ссылка на /root/.t3/runtime/versions/<версия>/t3.
# Поэтому версия переключается этой ссылкой; activeVersion в service-state.json
# держим в том же значении, чтобы не было двух правд.
#
# Перезапуск — отдельной задачей systemd-run, вне группы процессов службы:
# иначе перезапуск убьёт и того, кто его делает (урок 2026-09-22).
set -euo pipefail
LINK=/root/.local/bin/t3
VERSIONS=/root/.t3/runtime/versions
STATE=/root/.t3/runtime/service-state.json
PREV=/root/.t3/runtime/.t3-patch-previous
LOG=/root/.cache/t3-build/switch.log

current_version() { basename "$(dirname "$(readlink -f "$LINK")")"; }

switch_to() {
  local target="$1" current
  current=$(current_version)
  [ -x "$VERSIONS/$target/t3" ] || { echo "нет $VERSIONS/$target/t3" >&2; return 1; }
  if [ "$current" = "$target" ]; then echo "уже стоит $target"; return 0; fi
  echo "$current" > "$PREV"
  ln -sfn "$VERSIONS/$target/t3" "$LINK.new" && mv -Tf "$LINK.new" "$LINK"
  python3 - "$STATE" "$target" <<'PY'
import json, os, sys
path, target = sys.argv[1], sys.argv[2]
state = json.load(open(path)); state["activeVersion"] = target
tmp = path + ".tmp"; open(tmp, "w").write(json.dumps(state, indent=2) + "\n"); os.replace(tmp, path)
PY
  echo "версия: $current → $target (ссылка $LINK обновлена)"
  mkdir -p "$(dirname "$LOG")"
  systemd-run --user --quiet --collect --unit="t3-switch-$(date +%s)" /usr/bin/bash -c "
    exec >>'$LOG' 2>&1
    echo \"=== \$(date '+%F %T') переключение $current → $target\"
    sleep ${T3_SWITCH_DELAY:-3}
    systemctl --user restart t3code.service
    for i in \$(seq 1 60); do
      sleep 2
      pid=\$(systemctl --user show -p MainPID --value t3code.service)
      [ \"\$pid\" -gt 0 ] 2>/dev/null || continue
      exe=\$(readlink -f /proc/\$pid/exe 2>/dev/null || true)
      if [ \"\$exe\" = '$VERSIONS/$target/t3' ] && ss -ltn 2>/dev/null | grep -q ':7373 '; then
        echo \"\$(date '+%T') ok: работает $target (pid \$pid), порт 7373 слушается\"; exit 0
      fi
    done
    echo \"\$(date '+%T') ОШИБКА: $target не поднялась за 2 минуты — откат: rollback.sh $current\""
  echo "перезапуск запланирован через ${T3_SWITCH_DELAY:-3} с; журнал: $LOG"
  echo "активные сессии T3 оборвутся — это ожидаемо, треды и история на месте"
}
