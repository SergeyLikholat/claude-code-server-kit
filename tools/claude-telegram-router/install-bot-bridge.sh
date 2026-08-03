#!/usr/bin/env bash
# install-bot-bridge.sh — превратить ОБЫЧНЫЙ Telegram-бот (DM, без группы/топиков)
# в «мост к сессиям»: подключение к любым Claude-сессиям и создание новых —
# прямо из личных сообщений боту.
#
# Отличие от install-vscode-live.sh: там мост вешается на форум-ТОПИК группы.
# Здесь группы нет — весь бот в DM становится мостом (general-канал в режиме
# vscode_bridge). Проще: ничего не надо знать про thread_id.
#
# Что делает:
#   1. Обновляет код роутера (bridge.js, commands.js, index.js, dispatch.js,
#      transcribe.js) — на случай если на сервере старая версия без моста.
#      Бэкап timestamped + syntax-check + авто-откат при сбое.
#   2. В routing.json пользователя ставит general.mode = "vscode_bridge".
#   3. Создаёт пустой vscode_bridge.json (стейт моста).
#   4. Рестартует tg-router и проверяет.
#
# МУЛЬТИЮЗЕР: укажи пользователя первым аргументом — патч применится к его боту
#   (tg-router@<user>, ~/<user>/.claude/...). Без аргумента — single-user (root).
#
# Использование:
#   На сервере где склонирован kit:
#     sudo bash tools/claude-telegram-router/install-bot-bridge.sh alice
#     sudo bash tools/claude-telegram-router/install-bot-bridge.sh          # single-user root
#
#   Одной строкой без клонирования (подтянет файлы из репо):
#     curl -sSL https://raw.githubusercontent.com/SergeyLikholat/cc-multiuser-kit/main/tools/claude-telegram-router/install-bot-bridge.sh | sudo bash -s -- alice
#
# Параметры (env, можно переопределить):
#   LIVE_DIR  — код роутера (общий). По умолчанию /opt/claude-telegram-router
#   PROJECT_DIR — корневой каталог проектов для новых сессий (default: home юзера)
set -euo pipefail

GH_RAW_BASE="${GH_RAW_BASE:-https://raw.githubusercontent.com/SergeyLikholat/cc-multiuser-kit/main/tools/claude-telegram-router}"

C_R='\033[0;31m'; C_G='\033[0;32m'; C_Y='\033[0;33m'; C_C='\033[0;36m'; C_N='\033[0m'
log()  { echo -e "${C_C}[$(date +%H:%M:%S)]${C_N} $*"; }
ok()   { echo -e "${C_G}✓${C_N} $*"; }
warn() { echo -e "${C_Y}⚠${C_N}  $*" >&2; }
fail() { echo -e "${C_R}✗${C_N} $*" >&2; exit 1; }

[ "$EUID" -eq 0 ] || fail "Запусти через sudo: sudo bash $0 [username]"

LIVE_DIR_DEF="${LIVE_DIR:-/opt/claude-telegram-router}"

# ── Ручной откат: bash install-bot-bridge.sh --rollback <TS> [username] ─────
if [ "${1:-}" = "--rollback" ]; then
  RB_TS="${2:-}"; RB_USER="${3:-}"
  [ -n "$RB_TS" ] || fail "Usage: $0 --rollback <YYYYMMDD-HHMMSS> [username]"
  if [ -n "$RB_USER" ]; then
    RB_HOME="$(getent passwd "$RB_USER" | cut -d: -f6)"; RB_STATE="$RB_HOME/.claude/channels/telegram"; RB_SVC="tg-router@$RB_USER.service"
  else
    RB_STATE="/root/.claude/channels/telegram"; RB_SVC="tg-router.service"
  fi
  for f in bridge.js commands.js index.js dispatch.js transcribe.js model.js; do
    [ -f "$LIVE_DIR_DEF/$f.bak.$RB_TS" ] && cp "$LIVE_DIR_DEF/$f.bak.$RB_TS" "$LIVE_DIR_DEF/$f"
  done
  [ -f "$RB_STATE/routing.json.bak.$RB_TS" ] && cp "$RB_STATE/routing.json.bak.$RB_TS" "$RB_STATE/routing.json"
  systemctl restart "$RB_SVC"; sleep 2
  systemctl is-active --quiet "$RB_SVC" && ok "Откат к $RB_TS выполнен, $RB_SVC живой" || fail "$RB_SVC не поднялся после отката"
  exit 0
fi

# ── Резолвим пользователя / пути / юнит ────────────────────────────────────
TG_USER="${1:-}"
if [ -n "$TG_USER" ]; then
  id "$TG_USER" >/dev/null 2>&1 || fail "Пользователь $TG_USER не существует (сначала provision-user.sh)"
  USER_HOME="$(getent passwd "$TG_USER" | cut -d: -f6)"
  STATE_DIR="$USER_HOME/.claude/channels/telegram"
  SVC="tg-router@$TG_USER.service"
else
  TG_USER="root"
  USER_HOME="/root"
  STATE_DIR="/root/.claude/channels/telegram"
  SVC="tg-router.service"
fi
LIVE_DIR="${LIVE_DIR:-/opt/claude-telegram-router}"
PROJECT_DIR="${PROJECT_DIR:-$USER_HOME}"
TS="$(date +%Y%m%d-%H%M%S)"

log "Пользователь: $TG_USER | state: $STATE_DIR | сервис: $SVC"

[ -d "$LIVE_DIR" ]  || fail "Не найден $LIVE_DIR — tg-router не установлен (поставь kit/модуль tg-bot)"
[ -d "$STATE_DIR" ] || fail "Не найден $STATE_DIR — у $TG_USER нет настроенного бота"

# ── Источник свежих файлов роутера ─────────────────────────────────────────
SRC_DIR=""
if [ -n "${KIT_DIR:-}" ] && [ -f "$KIT_DIR/tools/claude-telegram-router/bridge.js" ]; then
  SRC_DIR="$KIT_DIR/tools/claude-telegram-router"
elif [ -f "$(dirname "$0")/bridge.js" ]; then
  SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
else
  SRC_DIR="$(mktemp -d)"
  log "Источник: GitHub ($GH_RAW_BASE)"
  for f in bridge.js commands.js index.js dispatch.js transcribe.js model.js; do
    curl -fsSL "$GH_RAW_BASE/$f" -o "$SRC_DIR/$f" || fail "Не скачался $f"
  done
fi
log "Источник кода: $SRC_DIR"

# ── Pre-flight syntax ──────────────────────────────────────────────────────
for f in bridge.js commands.js index.js dispatch.js transcribe.js model.js; do
  [ -f "$SRC_DIR/$f" ] || fail "Нет $SRC_DIR/$f"
  node -c "$SRC_DIR/$f" || fail "Битый JS: $SRC_DIR/$f"
done
ok "Файлы роутера валидны"

# ── Бэкап + раскатка кода ──────────────────────────────────────────────────
log "Бэкап текущего кода (.bak.$TS) и раскатка"
for f in bridge.js commands.js index.js dispatch.js transcribe.js model.js; do
  [ -f "$LIVE_DIR/$f" ] && cp "$LIVE_DIR/$f" "$LIVE_DIR/$f.bak.$TS"
  install -m 0644 "$SRC_DIR/$f" "$LIVE_DIR/$f"
done
chmod -R a+rX "$LIVE_DIR" 2>/dev/null || true
ok "Код роутера обновлён"

# ── Флип routing.json: general.mode = vscode_bridge ────────────────────────
ROUTING="$STATE_DIR/routing.json"
cp "$ROUTING" "$ROUTING.bak.$TS" 2>/dev/null || true
log "Включаю режим моста в general-канале"
python3 - "$ROUTING" "$PROJECT_DIR" <<'PYEOF'
import json, sys, os, uuid
path, project_dir = sys.argv[1], sys.argv[2]
try:
    with open(path) as f:
        r = json.load(f)
except FileNotFoundError:
    r = {}
g = r.setdefault('general', {})
g['mode'] = 'vscode_bridge'
g.setdefault('name', 'General')
g.setdefault('project_dir', project_dir)
g.setdefault('session_id', str(uuid.uuid4()))   # placeholder; реальная сессия — из vscode_bridge.json
r.setdefault('topics', {})
r.setdefault('ux', {})
with open(path, 'w') as f:
    json.dump(r, f, indent=2, ensure_ascii=False)
print("  general.mode = vscode_bridge")
PYEOF
chown "$TG_USER:$TG_USER" "$ROUTING" 2>/dev/null || true
chmod 600 "$ROUTING" 2>/dev/null || true

# ── vscode_bridge.json (стейт моста) ───────────────────────────────────────
BSTATE="$STATE_DIR/vscode_bridge.json"
[ -f "$BSTATE" ] || { echo '{}' > "$BSTATE"; chown "$TG_USER:$TG_USER" "$BSTATE" 2>/dev/null || true; chmod 600 "$BSTATE" 2>/dev/null || true; }

# ── Рестарт + проверка (авто-откат при сбое) ───────────────────────────────
log "Рестарт $SVC"
systemctl restart "$SVC"
sleep 3
if systemctl is-active --quiet "$SVC"; then
  ok "$SVC живой"
  cat <<EOF

${C_G}=== Bot-bridge установлен для $TG_USER ===${C_N}

Теперь в личке с ботом:
  /list            — список доступных Claude-сессий
  /connect <N>     — подключиться к сессии N (или по префиксу session_id)
  /new (➕ кнопка) — создать новую пустую сессию
  /disconnect      — отвязаться
  📥 Свежий ответ  — дотянуть последний ответ долгой сессии

Любое обычное сообщение боту → уходит в подключённую сессию.
Логи:  journalctl -u $SVC -f
Откат: bash $0 --rollback $TS $TG_USER
EOF
else
  warn "$SVC не поднялся — авто-откат"
  for f in bridge.js commands.js index.js dispatch.js transcribe.js model.js; do
    [ -f "$LIVE_DIR/$f.bak.$TS" ] && cp "$LIVE_DIR/$f.bak.$TS" "$LIVE_DIR/$f"
  done
  [ -f "$ROUTING.bak.$TS" ] && cp "$ROUTING.bak.$TS" "$ROUTING"
  systemctl restart "$SVC" || true
  sleep 2
  systemctl is-active --quiet "$SVC" && warn "Откат ок, бот на старом коде" || fail "$SVC не запускается даже после отката"
  journalctl -u "$SVC" -n 30 --no-pager || true
  exit 2
fi
