#!/bin/bash
# Модуль parakeet: голосовая транскрипция через Parakeet-TDT (или GigaAM)
set -e
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

log "Установка модуля: parakeet (голосовая транскрипция)"

VARIANT="${PARAKEET_VARIANT:-parakeet}"

case "$VARIANT" in
  parakeet)
    MODEL_NAME="nvidia/parakeet-tdt-0.6b-v3"
    INSTALL_DIR="/opt/parakeet"
    SERVICE_PORT=8089
    ;;
  gigaam)
    MODEL_NAME="salute-developers/GigaAM"
    INSTALL_DIR="/opt/gigaam"
    SERVICE_PORT=8089
    ;;
  *)
    err "Неизвестный variant: $VARIANT (доступно: parakeet, gigaam)"
    exit 1
    ;;
esac

log "Variant: $VARIANT, модель: $MODEL_NAME"

# Зависимости системы
apt_install python3-pip ffmpeg

# Python venv для модели
ensure_dir "$INSTALL_DIR" 755
if [ ! -d "$INSTALL_DIR/venv" ]; then
  python3 -m venv "$INSTALL_DIR/venv"
fi
# shellcheck disable=SC1091
source "$INSTALL_DIR/venv/bin/activate"

log "Устанавливаю Python-зависимости (это займёт 2-5 минут)..."
pip install --quiet --upgrade pip wheel
pip install --quiet huggingface_hub onnxruntime numpy soundfile

# HuggingFace download (нужен токен опционально, для приватных моделей)
ask "HuggingFace token (опционально, нажмите Enter для пропуска)" "" HUGGINGFACE_TOKEN
if [ -n "$HUGGINGFACE_TOKEN" ]; then
  export HF_TOKEN="$HUGGINGFACE_TOKEN"
fi

log "Скачиваю модель $MODEL_NAME (~600 МБ)..."
python3 -c "
from huggingface_hub import snapshot_download
snapshot_download(repo_id='$MODEL_NAME', local_dir='$INSTALL_DIR/model', token='${HUGGINGFACE_TOKEN:-}' or None)
" || warn "Скачивание модели не удалось — установите токен HF и запустите снова"

# Копируем код HTTP-сервера
cp -r "$KIT_DIR/tools/parakeet-server/"* "$INSTALL_DIR/" 2>/dev/null || true

# Systemd unit
install_systemd_unit "parakeet-server" \
  "$KIT_DIR/systemd/parakeet-server.service.template" \
  "WORKDIR=$INSTALL_DIR" \
  "PORT=$SERVICE_PORT"

systemctl enable --now parakeet-server.service 2>/dev/null || warn "Сервис не запустился"

sleep 2
if curl -sS "http://localhost:$SERVICE_PORT/health" >/dev/null 2>&1; then
  ok "Транскрипция работает на порту $SERVICE_PORT"
else
  warn "Сервис ещё не отвечает. Логи: journalctl -u parakeet-server -n 50"
fi

cat <<EOF

${BOLD}${GREEN}✓ Модуль parakeet установлен${NC}

Использование:
  curl -X POST -F file=@audio.ogg http://localhost:$SERVICE_PORT/transcribe

Интеграция с tg-bot:
  Если установлен модуль tg-bot — голосовые в TG автоматически
  будут проходить через этот сервис.

EOF
