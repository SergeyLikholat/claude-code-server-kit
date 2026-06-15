#!/bin/bash
# setup/core/04-minimal-config.sh — базовый ~/.claude/settings.json (без модульных секретов)
set -e
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

# TARGET_HOME — чей home настраиваем. Дефолт = /root (V1, single-user).
# Для V2 provision-user.sh передаёт TARGET_HOME=/home/<user>.
# ECC_DIR — где лежит everything-claude-code: shared /opt/ecc-base (V2) или
# per-user /root/everything-claude-code (V1-дефолт).
TARGET_HOME="${TARGET_HOME:-/root}"
ECC_DIR="${ECC_DIR:-$TARGET_HOME/everything-claude-code}"
CLAUDE_DIR="$TARGET_HOME/.claude"
ensure_dir "$CLAUDE_DIR" 755

SETTINGS="$CLAUDE_DIR/settings.json"
TEMPLATE="$KIT_DIR/claude-config/settings.minimal.json"

if [ -f "$SETTINGS" ]; then
  log "settings.json уже существует, делаю бэкап и обновляю минимальные настройки"
  cp "$SETTINGS" "${SETTINGS}.bak.$(date +%F-%H%M%S)"
else
  log "Создаю $SETTINGS из шаблона"
fi

# Подставляем имя/email пользователя
ask "Ваше имя (для git/claude config)" "$(whoami)" USER_NAME
ask "Ваш email" "${USER_NAME}@$(hostname)" USER_EMAIL

# Применяем шаблон с подстановкой
if [ -f "$TEMPLATE" ]; then
  sed -e "s|__USER_NAME__|${USER_NAME}|g" \
      -e "s|__USER_EMAIL__|${USER_EMAIL}|g" \
      -e "s|__HOME__|${TARGET_HOME}|g" \
      -e "s|__ECC_DIR__|${ECC_DIR}|g" \
      "$TEMPLATE" > "$SETTINGS"
else
  # Fallback: создаём пустой settings.json
  cat > "$SETTINGS" <<'EOF'
{
  "defaultModel": "claude-sonnet-4-6",
  "alwaysThinkingEnabled": true,
  "permissions": {
    "allowedTools": []
  },
  "hooks": {}
}
EOF
fi

# Настраиваем git если ещё не настроен
if [ -z "$(git config --global user.email 2>/dev/null)" ]; then
  git config --global user.name "$USER_NAME"
  git config --global user.email "$USER_EMAIL"
  ok "Git настроен: $USER_NAME <$USER_EMAIL>"
fi

ok "Минимальный settings.json создан: $SETTINGS"

# Базовые папки
ensure_dir "$CLAUDE_DIR/hooks" 755
ensure_dir "$CLAUDE_DIR/scripts" 755
ensure_dir "$CLAUDE_DIR/plans" 755

# Копируем generic hooks из kit'а
if [ -d "$KIT_DIR/claude-config/hooks" ]; then
  cp -rn "$KIT_DIR/claude-config/hooks/"* "$CLAUDE_DIR/hooks/" 2>/dev/null || true
fi

log "Готово. Запустите: claude"
