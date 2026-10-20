#!/bin/bash
# Модуль pdf-ocr: скилл распознавания PDF через подписку Claude Code (без внешних API).
# Ставит poppler-utils и кладёт скилл в ~/.claude/skills/pdf-ocr пользователя KIT_USER.
# settings.json и прочие настройки не трогает — модуль можно повторять для обновления скилла.
set -e
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../lib/secrets.sh"

log "Установка модуля: pdf-ocr"

apt_install poppler-utils python3

SRC="$KIT_DIR/claude-config/skills/pdf-ocr"
U="$(kit_user)"
DST="$(kit_home)/.claude/skills/pdf-ocr"

[ -f "$SRC/SKILL.md" ] || { err "Нет $SRC/SKILL.md — kit неполный"; exit 1; }

if [ -d "$DST" ] && ! diff -rq "$SRC" "$DST" >/dev/null 2>&1; then
  # Копия — вне ~/.claude/skills, иначе Claude Code увидит второй скилл с тем же именем
  BAK="$(kit_ensure_config_dir)/backup/pdf-ocr.$(date +%F-%H%M%S)"
  kit_user_dir "$(dirname "$BAK")" 700
  cp -r "$DST" "$BAK"
  chown -R "$U:$(id -gn "$U")" "$BAK"
  log "Прежняя версия скилла сохранена: $BAK"
fi
mkdir -p "$DST"
cp -r "$SRC/." "$DST/"
find "$DST" -name __pycache__ -type d -prune -exec rm -rf {} +
chmod +x "$DST/scripts/"*.py
chown -R "$U:$(id -gn "$U")" "$DST"
ok "  → $DST"

# Проверка: скрипт запускается и видит poppler
if kit_as_user python3 "$DST/scripts/prepare.py" --help >/dev/null 2>&1 && command -v pdftoppm >/dev/null; then
  ok "  prepare.py и poppler на месте"
else
  err "prepare.py не запускается — проверьте python3 и poppler-utils"
  exit 1
fi

cat <<EOF

${BOLD}${GREEN}✓ Модуль pdf-ocr установлен${NC}

  Как пользоваться: в Claude Code написать «распознай pdf <путь>» или «переведи скан в Excel».
  Скилл берёт текст из PDF, где он есть, а сканы читает глазами модели — лимиты подписки,
  никаких ключей. В конце всегда пишет, какие страницы сверить с оригиналом.

  Обновить скилл после git pull: sudo bash install.sh --module pdf-ocr
EOF
