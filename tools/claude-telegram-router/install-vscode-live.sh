#!/usr/bin/env bash
# Доустановка / обновление VS Code Live bridge на УЖЕ работающий tg-router.
#
# Фичи VS Code Live:
#   • /list /connect /disconnect — подключиться к любой VS Code сессии из TG
#   • ➕ Новая сессия — создать чистую сессию прямо из Telegram (кнопка)
#   • bridged-режим — Claude пишет обычный ответ, демон сам забирает его из
#     JSONL и шлёт в TG (без MCP reply); ответ конвертится Markdown→TG HTML
#   • floating control panel + 📥 Свежий ответ (pull) под каждым ответом
#   • новые TG-сессии автоматически появляются в VS Code Sidebar
#
# Что делает:
#   1. Бэкапит index.js / commands.js / dispatch.js / routing.json (timestamped).
#   2. Кладёт новые bridge.js + transcribe.js + патченные index/commands/dispatch
#      рядом со старыми (атомарно).
#   3. Добавляет в routing.json топик "VS Code Live" с mode=vscode_bridge
#      на указанном thread_id (если ещё не добавлен).
#   4. Создаёт пустой vscode_bridge.json для bridge-стейта.
#   5. Рестартует tg-router.service и проверяет что он живой;
#      при сбое — авто-откат к бэкапам.
#
# Использование:
#   На машине где склонирован репо:
#     bash tools/claude-telegram-router/install-vscode-live.sh
#
#   На чистой машине (где есть только tg-router):
#     curl -sSL https://raw.githubusercontent.com/SergeyLikholat/cc-multiuser-kit/main/tools/claude-telegram-router/install-vscode-live.sh | bash
#   (скрипт сам подтянет нужные исходники из main ветки репо)
#
# Параметры:
#   VSCODE_LIVE_THREAD_ID=42        — id форум-топика TG для VS Code Live
#   LIVE_DIR=/opt/claude-telegram-router  — где живёт роутер (можно поменять)
#   STATE_DIR=/root/.claude/channels/telegram
#   SVC=tg-router.service
#   KIT_DIR — путь к локальному клону репо (если не задан — скрипт
#             выкачает нужные файлы из github raw)
#
# Без VSCODE_LIVE_THREAD_ID скрипт спросит интерактивно.
# Если ввод не TTY и нет переменной — топик в routing.json не добавится,
# но код будет установлен (топик можно дописать руками потом).

set -euo pipefail

LIVE_DIR="${LIVE_DIR:-/opt/claude-telegram-router}"
STATE_DIR="${STATE_DIR:-/root/.claude/channels/telegram}"
SVC="${SVC:-tg-router.service}"
TS="$(date +%Y%m%d-%H%M%S)"

GH_RAW_BASE="${GH_RAW_BASE:-https://raw.githubusercontent.com/SergeyLikholat/cc-multiuser-kit/main/tools/claude-telegram-router}"

# Цвета
C_R='\033[0;31m'; C_G='\033[0;32m'; C_Y='\033[0;33m'; C_C='\033[0;36m'; C_N='\033[0m'
log()  { echo -e "${C_C}[$(date +%H:%M:%S)]${C_N} $*"; }
ok()   { echo -e "${C_G}✓${C_N} $*"; }
warn() { echo -e "${C_Y}⚠${C_N}  $*" >&2; }
fail() { echo -e "${C_R}✗${C_N} $*" >&2; exit 1; }

require_root() { [ "$EUID" -eq 0 ] || fail "Запусти через sudo: sudo bash $0"; }

require_root

[ -d "$LIVE_DIR" ]  || fail "Не найден $LIVE_DIR — tg-router не установлен"
[ -d "$STATE_DIR" ] || fail "Не найден $STATE_DIR — tg-router без state-каталога"
[ -f "$LIVE_DIR/index.js" ]    || fail "Нет $LIVE_DIR/index.js"
[ -f "$LIVE_DIR/commands.js" ] || fail "Нет $LIVE_DIR/commands.js"
[ -f "$LIVE_DIR/dispatch.js" ] || fail "Нет $LIVE_DIR/dispatch.js"
[ -f "$STATE_DIR/routing.json" ] || fail "Нет $STATE_DIR/routing.json"

# Резолвим источник файлов: либо локальный клон репо, либо github raw
SRC_DIR=""
if [ -n "${KIT_DIR:-}" ] && [ -f "$KIT_DIR/tools/claude-telegram-router/bridge.js" ]; then
  SRC_DIR="$KIT_DIR/tools/claude-telegram-router"
  log "Источник: локальный клон $SRC_DIR"
elif [ -f "$(dirname "$0")/bridge.js" ]; then
  SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
  log "Источник: $(dirname "$0") (запущен из клона репо)"
else
  SRC_DIR="$(mktemp -d)"
  log "Источник: GitHub ($GH_RAW_BASE)"
  for f in bridge.js commands.js index.js dispatch.js transcribe.js; do
    log "  Качаю $f"
    curl -fsSL "$GH_RAW_BASE/$f" -o "$SRC_DIR/$f" || fail "Не скачался $f"
  done
fi

# Pre-flight: syntax check всех новых файлов
log "Проверяю синтаксис новых файлов"
for f in bridge.js commands.js index.js dispatch.js transcribe.js; do
  [ -f "$SRC_DIR/$f" ] || fail "Не найден $SRC_DIR/$f"
  node -c "$SRC_DIR/$f" || fail "Битый JS: $SRC_DIR/$f"
done
ok "Все файлы валидны"

# Бэкап
log "Бэкаплю текущие файлы (.bak.$TS)"
cp "$LIVE_DIR/index.js"        "$LIVE_DIR/index.js.bak.$TS"
cp "$LIVE_DIR/commands.js"     "$LIVE_DIR/commands.js.bak.$TS"
cp "$LIVE_DIR/dispatch.js"     "$LIVE_DIR/dispatch.js.bak.$TS"
cp "$STATE_DIR/routing.json"   "$STATE_DIR/routing.json.bak.$TS"
[ -f "$LIVE_DIR/bridge.js" ]    && cp "$LIVE_DIR/bridge.js"    "$LIVE_DIR/bridge.js.bak.$TS"
[ -f "$LIVE_DIR/transcribe.js" ] && cp "$LIVE_DIR/transcribe.js" "$LIVE_DIR/transcribe.js.bak.$TS"
ok "Бэкапы: *.bak.$TS"

# Накатываем новые файлы
log "Раскатываю новые версии файлов"
install -m 0644 "$SRC_DIR/bridge.js"     "$LIVE_DIR/bridge.js"
install -m 0644 "$SRC_DIR/commands.js"   "$LIVE_DIR/commands.js"
install -m 0644 "$SRC_DIR/index.js"      "$LIVE_DIR/index.js"
install -m 0644 "$SRC_DIR/dispatch.js"   "$LIVE_DIR/dispatch.js"
install -m 0644 "$SRC_DIR/transcribe.js" "$LIVE_DIR/transcribe.js"
ok "Файлы на месте"

# Добавляем топик VS Code Live в routing.json (если есть thread_id)
THREAD_ID="${VSCODE_LIVE_THREAD_ID:-}"
if [ -z "$THREAD_ID" ] && [ -t 0 ]; then
  echo
  echo "VS Code Live — это форум-топик в TG, через который можно подключаться"
  echo "к любой открытой VS Code сессии (команды /list, /connect, /disconnect)."
  read -r -p "Thread ID форум-топика TG для VS Code Live (Enter — пропустить): " THREAD_ID
fi

if [ -n "$THREAD_ID" ]; then
  log "Добавляю топик VS Code Live (thread_id=$THREAD_ID) в routing.json"
  python3 - "$STATE_DIR/routing.json" "$THREAD_ID" <<'PYEOF'
import json, sys
path, tid = sys.argv[1], sys.argv[2]
with open(path) as f:
    r = json.load(f)
r.setdefault('topics', {})
if tid in r['topics']:
    print(f"  топик {tid} уже есть — не трогаю", flush=True)
else:
    r['topics'][tid] = {
        "name": "VS Code Live",
        "mode": "vscode_bridge",
        "project_dir": "/root",
        "session_id": "_BRIDGE_PLACEHOLDER_",
    }
    with open(path, 'w') as f:
        json.dump(r, f, indent=2, ensure_ascii=False)
    print(f"  добавлен топик {tid} → VS Code Live", flush=True)
PYEOF
else
  warn "Thread ID не задан — топик в routing.json не добавлен."
  warn "Допиши вручную в $STATE_DIR/routing.json в раздел \"topics\":"
  cat <<'EOF'
  "ВАШ_THREAD_ID": {
    "name": "VS Code Live",
    "mode": "vscode_bridge",
    "project_dir": "/root",
    "session_id": "_BRIDGE_PLACEHOLDER_"
  }
EOF
fi

# Bridge state file
[ -f "$STATE_DIR/vscode_bridge.json" ] || {
  echo '{}' > "$STATE_DIR/vscode_bridge.json"
  chmod 600 "$STATE_DIR/vscode_bridge.json"
  log "Создан пустой $STATE_DIR/vscode_bridge.json"
}

# Рестарт + проверка
log "Рестартую $SVC"
systemctl restart "$SVC"
sleep 3

if systemctl is-active --quiet "$SVC"; then
  ok "$SVC живой после рестарта"
  echo
  echo -e "${C_G}=== VS Code Live установлен ===${C_N}"
  echo "Логи:     journalctl -u $SVC -f"
  echo "Откат:    bash $LIVE_DIR/rollback-vscode-live.sh $TS"
  echo
  # Положим маленький rollback-скрипт прямо рядом
  cat > "$LIVE_DIR/rollback-vscode-live.sh" <<RBEOF
#!/usr/bin/env bash
set -e
TS="\${1:-}"
[ -z "\$TS" ] && { echo "Usage: \$0 <YYYYMMDD-HHMMSS>"; ls $LIVE_DIR/*.bak.* | sed 's/.*\.bak\.//' | sort -u; exit 1; }
cp "$LIVE_DIR/index.js.bak.\$TS"      "$LIVE_DIR/index.js"
cp "$LIVE_DIR/commands.js.bak.\$TS"   "$LIVE_DIR/commands.js"
cp "$LIVE_DIR/dispatch.js.bak.\$TS"   "$LIVE_DIR/dispatch.js"
cp "$STATE_DIR/routing.json.bak.\$TS" "$STATE_DIR/routing.json"
[ -f "$LIVE_DIR/bridge.js.bak.\$TS" ] && cp "$LIVE_DIR/bridge.js.bak.\$TS" "$LIVE_DIR/bridge.js" || rm -f "$LIVE_DIR/bridge.js"
[ -f "$LIVE_DIR/transcribe.js.bak.\$TS" ] && cp "$LIVE_DIR/transcribe.js.bak.\$TS" "$LIVE_DIR/transcribe.js" || rm -f "$LIVE_DIR/transcribe.js"
systemctl restart $SVC
sleep 2
systemctl is-active --quiet $SVC && echo "[ok] $SVC жив после отката" || echo "[CRIT] $SVC не поднялся"
RBEOF
  chmod +x "$LIVE_DIR/rollback-vscode-live.sh"
else
  warn "$SVC не поднялся — авто-откат"
  cp "$LIVE_DIR/index.js.bak.$TS"      "$LIVE_DIR/index.js"
  cp "$LIVE_DIR/commands.js.bak.$TS"   "$LIVE_DIR/commands.js"
  cp "$LIVE_DIR/dispatch.js.bak.$TS"   "$LIVE_DIR/dispatch.js"
  cp "$STATE_DIR/routing.json.bak.$TS" "$STATE_DIR/routing.json"
  rm -f "$LIVE_DIR/bridge.js"
  systemctl restart "$SVC"
  sleep 2
  if systemctl is-active --quiet "$SVC"; then
    warn "Откат прошёл, $SVC работает на старом коде"
  else
    fail "$SVC всё ещё не запускается — нужна ручная диагностика"
  fi
  echo
  journalctl -u "$SVC" -n 30 --no-pager
  exit 2
fi
