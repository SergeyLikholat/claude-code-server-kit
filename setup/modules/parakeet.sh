#!/bin/bash
# Модуль parakeet: голосовая транскрипция через Parakeet-TDT 0.6B v3 (int8 ONNX).
#
# Использует библиотеку onnx-asr (CPU inference, ~600 МБ модель).
# Модель грузится в FastAPI-процесс один раз при старте, переиспользуется
# для всех запросов — это много быстрее, чем subprocess fork на каждый POST.
set -e
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

log "Установка модуля: parakeet (голосовая транскрипция)"

INSTALL_DIR="${PARAKEET_INSTALL_DIR:-/opt/parakeet}"
SERVER_DIR="${PARAKEET_SERVER_DIR:-/opt/parakeet-server}"
SERVICE_PORT="${PARAKEET_PORT:-8002}"
MODEL_REPO="${PARAKEET_MODEL_REPO:-istupakov/parakeet-tdt-0.6b-v3-onnx}"

# 1. Системные зависимости
apt_install python3-pip python3-venv ffmpeg

# 2. Каталоги
ensure_dir "$INSTALL_DIR" 755
ensure_dir "$SERVER_DIR" 755

# 3. Копируем код
install -m 0755 "$KIT_DIR/tools/parakeet/transcribe.py" "$INSTALL_DIR/transcribe.py"
install -m 0644 "$KIT_DIR/tools/parakeet-server/server.py" "$SERVER_DIR/server.py"

# 4. Venv с зависимостями (общий для CLI и сервера)
log "Создаю Python venv с onnx-asr + fastapi (2-5 минут)"
create_python_venv "$SERVER_DIR/venv" \
  huggingface_hub \
  onnxruntime \
  onnx-asr \
  numpy \
  soundfile \
  fastapi \
  "uvicorn[standard]" \
  python-multipart

# 5. HuggingFace token (опционально, нужен только для приватных моделей)
ask "HuggingFace token (опционально, Enter чтобы пропустить)" "" HUGGINGFACE_TOKEN
if [ -n "$HUGGINGFACE_TOKEN" ]; then
  export HF_TOKEN="$HUGGINGFACE_TOKEN"
fi

# 6. Скачать ONNX-вариант модели в $INSTALL_DIR (~600 МБ).
# istupakov/parakeet-tdt-0.6b-v3-onnx содержит готовый int8 ONNX-экспорт
# модели от NVIDIA, совместимый с onnx-asr.
if [ ! -f "$INSTALL_DIR/encoder-model.int8.onnx" ]; then
  log "Скачиваю модель $MODEL_REPO (~600 МБ)"
  "$SERVER_DIR/venv/bin/python3" - <<EOF
from huggingface_hub import snapshot_download
import os
snapshot_download(
    repo_id="$MODEL_REPO",
    local_dir="$INSTALL_DIR",
    token=os.environ.get("HF_TOKEN") or None,
)
EOF
else
  log "Модель уже скачана: $INSTALL_DIR"
fi

# 7. Systemd unit
install_systemd_unit "parakeet-server" \
  "$KIT_DIR/systemd/parakeet-server.service.template" \
  "WORKDIR=$SERVER_DIR" \
  "MODEL_DIR=$INSTALL_DIR" \
  "PORT=$SERVICE_PORT"

systemctl enable parakeet-server.service
systemctl restart parakeet-server.service
sleep 5

# 8. Health check
if curl -sS "http://127.0.0.1:$SERVICE_PORT/health" 2>/dev/null | grep -q '"status":"ok"'; then
  ok "Транскрипция работает на 127.0.0.1:$SERVICE_PORT"
else
  warn "Сервис ещё не отвечает (может грузить модель). Подождите 10-20 сек и проверьте:"
  warn "  curl http://127.0.0.1:$SERVICE_PORT/health"
  warn "  journalctl -u parakeet-server -n 50"
fi

# 9. Авто-прописать PARAKEET_URL в env tg-router, если он установлен
TG_ENV="/root/.claude/channels/telegram/.env"
if [ -f "$TG_ENV" ] && ! grep -q "^PARAKEET_URL=" "$TG_ENV"; then
  echo "PARAKEET_URL=http://127.0.0.1:$SERVICE_PORT/transcribe" >> "$TG_ENV"
  systemctl restart tg-router.service 2>/dev/null || true
  ok "tg-router подключён к parakeet"
fi

cat <<EOF

${BOLD}${GREEN}✓ Модуль parakeet установлен${NC}

Endpoints:
  GET  http://127.0.0.1:$SERVICE_PORT/health
  POST http://127.0.0.1:$SERVICE_PORT/transcribe (multipart, поле "audio")

CLI тест:
  curl -X POST -F audio=@test.ogg http://127.0.0.1:$SERVICE_PORT/transcribe

Интеграция с tg-bot:
  В .env роутера прописана PARAKEET_URL — голосовые автоматически
  расшифровываются и передаются Claude как текст.

Логи:
  journalctl -u parakeet-server -f

EOF
