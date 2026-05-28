#!/bin/bash
# Модуль helpers: набор полезных мелочей (nanobanana, gemini-tts, openpyxl_safe, tg-md)
set -e
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

log "Установка модуля: helpers"

apt_install python3-pip
ensure_dir /opt 755

# ============================================================
# openpyxl_safe — без ключей
# ============================================================
log "▸ openpyxl_safe (XLSX bugfix patch)"
cp -r "$KIT_DIR/tools/openpyxl_safe" /opt/
ok "  → /opt/openpyxl_safe/ (используйте: import sys; sys.path.insert(0,'/opt/openpyxl_safe'); import openpyxl_safe)"

# ============================================================
# tg-md — без ключей
# ============================================================
log "▸ tg-md (TG MarkdownV2 formatter)"
cp -r "$KIT_DIR/tools/tg-md" /opt/
chmod +x /opt/tg-md/*.py 2>/dev/null || true
ok "  → /opt/tg-md/format.py"

# ============================================================
# nanobanana и gemini-tts — нужен Gemini API key (опционально)
# ============================================================
SKIP_GEMINI="${SKIP_GEMINI:-false}"
if [ "$SKIP_GEMINI" != "true" ]; then
  ask "Gemini API key для nanobanana (генерация картинок) и gemini-tts" "" GEMINI_API_KEY

  if [ -n "$GEMINI_API_KEY" ]; then
    # nanobanana
    log "▸ nanobanana (генерация изображений через Gemini)"
    cp -r "$KIT_DIR/tools/nanobanana" /opt/
    pip install --quiet google-genai 2>&1 | tail -2
    echo "GEMINI_API_KEY=$GEMINI_API_KEY" > /root/.nanobanana.env
    chmod 600 /root/.nanobanana.env
    ok "  → /opt/nanobanana/generate.py"

    # gemini-tts
    log "▸ gemini-tts (озвучка текста)"
    cp -r "$KIT_DIR/tools/gemini-tts" /opt/
    echo "GEMINI_API_KEY=$GEMINI_API_KEY" > /root/.gemini-tts.env
    chmod 600 /root/.gemini-tts.env
    ok "  → /opt/gemini-tts/tts.py"
  else
    warn "Gemini API key не указан — nanobanana и gemini-tts пропущены"
    echo "  Чтобы установить позже:"
    echo "    Получите ключ: https://aistudio.google.com/apikey"
    echo "    GEMINI_API_KEY=ваш_ключ sudo bash install.sh --module helpers"
  fi
fi

cat <<EOF

${BOLD}${GREEN}✓ Модуль helpers установлен${NC}

Установлено:
  ✓ openpyxl_safe  — патч для генерации XLSX без багов
  ✓ tg-md          — конвертер MarkdownV2 для Telegram
EOF
[ -d /opt/nanobanana ] && echo "  ✓ nanobanana    — генерация картинок"
[ -d /opt/gemini-tts ] && echo "  ✓ gemini-tts    — озвучка текста"

cat <<EOF

Использование:
  • openpyxl_safe: import sys; sys.path.insert(0,'/opt/openpyxl_safe'); import openpyxl_safe
  • tg-md: python3 /opt/tg-md/format.py "текст с [B]форматированием[/B]"
EOF
[ -d /opt/nanobanana ] && echo "  • nanobanana: python3 /opt/nanobanana/generate.py \"описание картинки\""
[ -d /opt/gemini-tts ] && echo "  • gemini-tts: python3 /opt/gemini-tts/tts.py \"текст для озвучки\""
echo
