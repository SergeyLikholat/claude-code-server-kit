#!/usr/bin/env bash
# Какая версия T3 стоит, патченая ли, что работает сейчас.
set -uo pipefail
V=/root/.t3/runtime/versions
A=$(basename "$(dirname "$(readlink -f /root/.local/bin/t3)")")
echo "стоит (ссылка /root/.local/bin/t3): $A"
if [ -f "$V/$A/PATCHED.json" ]; then echo "патченая:"; sed 's/^/  /' "$V/$A/PATCHED.json"; else echo "штатная (без патчей)"; fi
pid=$(systemctl --user show -p MainPID --value t3code.service)
echo "работает: $(readlink -f /proc/$pid/exe 2>/dev/null || echo 'служба не запущена') (pid $pid)"
echo "установлены: $(ls $V | tr '\n' ' ')"
echo "последние переключения:"; { tail -4 /root/.cache/t3-build/switch.log 2>/dev/null || true; } | sed 's/^/  /'
