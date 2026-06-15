#!/bin/bash
# setup/provision-user.sh <username> — провижининг одного пользователя V2.
#
# Создаёт изолированный «мир» пользователя на общей инфраструктуре:
#   - Unix-аккаунт <username> (home 700, группы ccusers + sharedproj)
#   - ~/.claude/{settings.json, CLAUDE.md, agents, skills, rules, ...}
#   - ~/projects, ~/obsidian (vault), ~/_infra/context-mgr
#   - копию общего Anthropic credential (~/.claude/.credentials.json, 600)
#   - tg-router@<username> (свой bot token, свой state)
#   - context-mgr per-user (мониторинг + ночные дайджесты в свой vault)
#
# ПРЕДУСЛОВИЕ: сначала запущен shared-infra.sh (группы, /opt/ecc-base,
# /opt/claude-telegram-router, /opt/context-mgr, мастер-credential).
#
# Идемпотентность: повторный запуск безопасен (cp -n, проверки [ -f ]).
#
# Использование:
#   sudo bash setup/provision-user.sh alice
#   sudo bash setup/provision-user.sh alice --sync-creds   # только пересинк credential
set -e
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

require_root

USERNAME="${1:-}"
[ -z "$USERNAME" ] && fatal "Использование: sudo bash setup/provision-user.sh <username> [--sync-creds]"
case "$USERNAME" in
  root|admin|-*) fatal "Недопустимое имя пользователя: $USERNAME" ;;
esac
SYNC_ONLY=false
[ "${2:-}" = "--sync-creds" ] && SYNC_ONLY=true

HOME_DIR="/home/$USERNAME"
CLAUDE_DIR="$HOME_DIR/.claude"
MASTER_CRED="${MASTER_CRED:-/root/.claude/.credentials.json}"

# ============================================================
# Подкоманда: только пересинхронизировать credential
# ============================================================
sync_creds() {
  [ -f "$MASTER_CRED" ] || fatal "Мастер-credential не найден: $MASTER_CRED (авторизуйтесь: claude)"
  ensure_dir "$CLAUDE_DIR" 700
  cp "$MASTER_CRED" "$CLAUDE_DIR/.credentials.json"
  chown "$USERNAME:$USERNAME" "$CLAUDE_DIR/.credentials.json"
  chmod 600 "$CLAUDE_DIR/.credentials.json"
  ok "Credential синхронизирован для $USERNAME"
}

if [ "$SYNC_ONLY" = "true" ]; then
  id "$USERNAME" >/dev/null 2>&1 || fatal "Пользователь $USERNAME не существует"
  sync_creds
  exit 0
fi

section "Провижининг пользователя: $USERNAME"

# ============================================================
# 1. Unix-аккаунт
# ============================================================
getent group ccusers   >/dev/null || fatal "Нет группы ccusers — сначала: sudo bash setup/shared-infra.sh"
getent group sharedproj >/dev/null || fatal "Нет группы sharedproj — сначала: sudo bash setup/shared-infra.sh"

if id "$USERNAME" >/dev/null 2>&1; then
  log "Пользователь $USERNAME уже существует"
  usermod -aG ccusers,sharedproj "$USERNAME"
else
  useradd -m -s /bin/bash -G ccusers,sharedproj "$USERNAME"
  ok "Создан пользователь $USERNAME"
fi
chmod 700 "$HOME_DIR"          # изоляция от других пользователей
ok "$HOME_DIR (700)"

# ============================================================
# 2. Скелет каталогов
# ============================================================
run_as() { sudo -u "$USERNAME" "$@"; }

ensure_dir "$CLAUDE_DIR" 700
for sub in agents skills rules commands hooks plans scripts channels/telegram; do
  ensure_dir "$CLAUDE_DIR/$sub" 700
done
ensure_dir "$HOME_DIR/projects" 700
ensure_dir "$HOME_DIR/obsidian" 700
ensure_dir "$HOME_DIR/_infra/context-mgr" 700
chown -R "$USERNAME:$USERNAME" "$HOME_DIR/.claude" "$HOME_DIR/projects" "$HOME_DIR/obsidian" "$HOME_DIR/_infra"
ok "Скелет каталогов создан"

# ============================================================
# 3. settings.json (subpaths → shared /opt/ecc-base + личный ~/.claude)
# ============================================================
ECC_DIR="${ECC_DIR:-/opt/ecc-base}"
SETTINGS="$CLAUDE_DIR/settings.json"
if [ ! -f "$SETTINGS" ]; then
  sed -e "s|__USER_NAME__|${USERNAME}|g" \
      -e "s|__USER_EMAIL__|${USERNAME}@$(hostname)|g" \
      -e "s|__HOME__|${HOME_DIR}|g" \
      -e "s|__ECC_DIR__|${ECC_DIR}|g" \
      "$KIT_DIR/claude-config/settings.minimal.json" > "$SETTINGS"
  chown "$USERNAME:$USERNAME" "$SETTINGS"; chmod 600 "$SETTINGS"
  ok "settings.json создан (ECC: $ECC_DIR)"
else
  log "settings.json уже есть — не трогаю"
fi

# ============================================================
# 4. CLAUDE.md из шаблона
# ============================================================
if [ ! -f "$CLAUDE_DIR/CLAUDE.md" ]; then
  sed -e "s|__USER_NAME__|${USERNAME}|g" -e "s|__HOME__|${HOME_DIR}|g" \
      "$KIT_DIR/claude-config/CLAUDE.md.template" > "$CLAUDE_DIR/CLAUDE.md"
  chown "$USERNAME:$USERNAME" "$CLAUDE_DIR/CLAUDE.md"; chmod 600 "$CLAUDE_DIR/CLAUDE.md"
  ok "CLAUDE.md создан"
else
  log "CLAUDE.md уже есть — не трогаю"
fi

# ============================================================
# 5. Credential (общая подписка)
# ============================================================
if [ -f "$MASTER_CRED" ]; then
  sync_creds
else
  warn "Мастер-credential не найден ($MASTER_CRED). Авторизуйтесь под root (claude),"
  warn "затем: sudo bash setup/provision-user.sh $USERNAME --sync-creds"
fi

# ============================================================
# 6. tg-router@<user> (требует свой bot token)
# ============================================================
ENV_FILE="$CLAUDE_DIR/channels/telegram/.env"
if [ ! -f "$ENV_FILE" ]; then
  ask "Telegram Bot Token для $USERNAME (от @BotFather, ПУСТО — пропустить tg-router)" "" USER_BOT_TOKEN
  if [ -n "$USER_BOT_TOKEN" ]; then
    cat > "$ENV_FILE" <<EOF
TELEGRAM_BOT_TOKEN=$USER_BOT_TOKEN
TELEGRAM_FORCE_POLLING=0
# PARAKEET_URL=http://127.0.0.1:8002/transcribe  # раскомментируйте если установлен parakeet
EOF
    chown "$USERNAME:$USERNAME" "$ENV_FILE"; chmod 600 "$ENV_FILE"
    ok "tg-router .env создан"
  fi
fi

# дефолтный routing.json (без него index.js падает на первом сообщении)
ROUTING="$CLAUDE_DIR/channels/telegram/routing.json"
if [ ! -f "$ROUTING" ]; then
  sid="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || python3 -c 'import uuid;print(uuid.uuid4())')"
  cat > "$ROUTING" <<EOF
{
  "general": { "name": "General", "project_dir": "$HOME_DIR", "session_id": "$sid" },
  "topics": {},
  "ux": { "owner": "$USERNAME" }
}
EOF
  chown "$USERNAME:$USERNAME" "$ROUTING"; chmod 600 "$ROUTING"
  echo '{}' > "$CLAUDE_DIR/channels/telegram/vscode_bridge.json"
  chown "$USERNAME:$USERNAME" "$CLAUDE_DIR/channels/telegram/vscode_bridge.json"
  ok "routing.json создан"
fi

if [ -f "$ENV_FILE" ]; then
  install_unit_template "$KIT_DIR/systemd/tg-router@.service.template"
  systemctl enable "tg-router@$USERNAME.service"
  systemctl restart "tg-router@$USERNAME.service"
  sleep 2
  if systemctl is-active --quiet "tg-router@$USERNAME.service"; then
    ok "tg-router@$USERNAME запущен"
  else
    warn "tg-router@$USERNAME не поднялся. Логи: journalctl -u tg-router@$USERNAME -n 50"
  fi
else
  log "tg-router пропущен (нет токена) — можно добавить позже"
fi

# ============================================================
# 7. context-mgr per-user (память через obsidian-vault)
# ============================================================
CTX_SRC="/opt/context-mgr"; [ -d "$CTX_SRC" ] || CTX_SRC="$KIT_DIR/tools/context-mgr"
CTX_DST="$HOME_DIR/_infra/context-mgr"
cp -n "$CTX_SRC"/*.js "$CTX_DST/" 2>/dev/null || true
cp -n "$CTX_SRC"/aliases.json "$CTX_DST/" 2>/dev/null || true
ensure_dir "$CTX_DST/logs" 700
if [ ! -f "$CTX_DST/config.json" ]; then
  sed -e "s|__HOME__|${HOME_DIR}|g" -e "s|__USER__|${USERNAME}|g" \
      "$CTX_SRC/config.json.template" > "$CTX_DST/config.json"
fi
chown -R "$USERNAME:$USERNAME" "$CTX_DST"
chmod -R go-rwx "$CTX_DST"

install_unit_template "$KIT_DIR/systemd/ctx-mgr-monitor@.service.template"
install_unit_template "$KIT_DIR/systemd/ctx-mgr-monitor@.timer.template"
install_unit_template "$KIT_DIR/systemd/ctx-mgr-daily@.service.template"
install_unit_template "$KIT_DIR/systemd/ctx-mgr-daily@.timer.template"
systemctl enable --now "ctx-mgr-monitor@$USERNAME.timer" 2>/dev/null || warn "ctx-mgr-monitor timer не включился"
systemctl enable --now "ctx-mgr-daily@$USERNAME.timer" 2>/dev/null || warn "ctx-mgr-daily timer не включился"
ok "context-mgr per-user настроен (vault: $HOME_DIR/obsidian)"

cat <<EOF

${BOLD}${GREEN}✓ Пользователь $USERNAME provisioned${NC}

Мир пользователя:
  • Home:     $HOME_DIR (700, изолирован)
  • Claude:   $CLAUDE_DIR (settings/CLAUDE.md/rules/память)
  • Проекты:  $HOME_DIR/projects (личные) + /srv/shared/projects (общие)
  • Vault:    $HOME_DIR/obsidian (тематическая память)
  • TG-бот:   tg-router@$USERNAME $([ -f "$ENV_FILE" ] && echo "(активен)" || echo "(токен не задан)")

Доступ:
  • VS Code/SSH: пользователь логинится под своим аккаунтом $USERNAME
  • Telegram: свой бот (отдельный токен)

Не забудьте:
  • Задать пароль для SSH/VS Code: sudo passwd $USERNAME
  • Защитить админа: sudo bash setup/harden-admin.sh
EOF
