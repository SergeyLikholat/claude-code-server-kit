#!/bin/bash
# Модуль memory: память Claude между сессиями — ставится из отдельного репозитория
# llm-memory-kit (хуки подстановки памяти, ночные сборщики тем, cron).
#
# Здесь нет своей логики памяти: модуль клонирует llm-memory-kit нужной версии и
# запускает ЕГО install.sh, передав настройки через окружение (MEMKIT_*). Всё, что
# касается памяти, меняется в llm-memory-kit.
#
# Настройки (secrets.env или окружение), все не обязательны:
#   MEMORY_KIT_REPO          откуда клонировать (по умолчанию публичный репозиторий)
#   MEMORY_KIT_REF           ветка или тег (master — основная ветка llm-memory-kit)
#   MEMORY_KIT_DIR           куда (~/llm-memory-kit пользователя среды)
#   MEMORY_KIT_OBSIDIAN_DIR  папка Obsidian-хранилища — включает вики поверх памяти
#   MEMORY_KIT_TZ            часовой пояс ночных задач (часовой пояс сервера)
#   MEMORY_KIT_MODEL         модель ночных сборщиков (sonnet)
set -e
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../lib/secrets.sh"

log "Установка модуля: memory (llm-memory-kit)"

MK_USER="$(kit_user)"
MK_HOME="$(kit_home)"
[ -n "$MK_HOME" ] || fatal "Пользователь $MK_USER не найден"
MK_GROUP="$(id -gn "$MK_USER")"
MEMORY_KIT_REPO="${MEMORY_KIT_REPO:-https://github.com/SergeyLikholat/llm-memory-kit.git}"
MEMORY_KIT_REF="${MEMORY_KIT_REF:-master}"
MEMORY_KIT_DIR="${MEMORY_KIT_DIR:-$MK_HOME/llm-memory-kit}"
MK_TZ="${MEMORY_KIT_TZ:-$(timedatectl show -p Timezone --value 2>/dev/null || echo UTC)}"
MK_CLAUDE_BIN="$(find_claude_bin 2>/dev/null || echo "$MK_HOME/.local/bin/claude")"

apt_install git
ensure_node

# ============================================================
# 1. Исходники llm-memory-kit нужной версии
# ============================================================
if [ -d "$MEMORY_KIT_DIR/.git" ]; then
  log "Обновляю $MEMORY_KIT_DIR до $MEMORY_KIT_REF"
  kit_as_user git -C "$MEMORY_KIT_DIR" fetch -q --tags origin \
    || warn "git fetch не удался — ставлю то, что уже есть"
  kit_as_user git -C "$MEMORY_KIT_DIR" checkout -q "$MEMORY_KIT_REF" \
    || fatal "Нет версии $MEMORY_KIT_REF в $MEMORY_KIT_REPO"
  kit_as_user git -C "$MEMORY_KIT_DIR" pull -q --ff-only 2>/dev/null || true   # тег — pull не нужен
else
  log "Клонирую $MEMORY_KIT_REPO ($MEMORY_KIT_REF) → $MEMORY_KIT_DIR"
  kit_user_dir "$(dirname "$MEMORY_KIT_DIR")"
  kit_as_user git clone -q --branch "$MEMORY_KIT_REF" "$MEMORY_KIT_REPO" "$MEMORY_KIT_DIR" \
    || fatal "Не удалось клонировать $MEMORY_KIT_REPO"
fi
[ -f "$MEMORY_KIT_DIR/install.sh" ] || fatal "В $MEMORY_KIT_DIR нет install.sh — это точно llm-memory-kit?"

# ============================================================
# 2. Установка его собственным install.sh, без вопросов
# ============================================================
# Настройки — в окружении под именами, которые llm-memory-kit пишет в свой config.sh.
MEMKIT_CLAUDE_DIR="$MK_HOME/.claude"
MEMKIT_PROJECTS_DIR="$MK_HOME/projects"
MEMKIT_CLAUDE_BIN="$MK_CLAUDE_BIN"
MEMKIT_TZ="$MK_TZ"
MEMKIT_MODEL="${MEMORY_KIT_MODEL:-sonnet}"
MEMKIT_OBSIDIAN_DIR="${MEMORY_KIT_OBSIDIAN_DIR:-}"
MK_ENV=(MEMKIT_CLAUDE_DIR="$MEMKIT_CLAUDE_DIR" MEMKIT_PROJECTS_DIR="$MEMKIT_PROJECTS_DIR"
        MEMKIT_CLAUDE_BIN="$MEMKIT_CLAUDE_BIN" MEMKIT_TZ="$MEMKIT_TZ" MEMKIT_MODEL="$MEMKIT_MODEL"
        MEMKIT_OBSIDIAN_DIR="$MEMKIT_OBSIDIAN_DIR" MEMKIT_INSTALL_CRON=1 MEMKIT_INSTALL_HOOKS=1
        KIT_NONINTERACTIVE=1)

if grep -q -- '--yes' "$MEMORY_KIT_DIR/install.sh"; then
  # Текущий llm-memory-kit: --yes — без вопросов, значения из MEMKIT_*; сам прописывает
  # хуки в settings.json и ставит расписание. Obsidian — только если задан волт.
  MK_ARGS=(--yes)
  [ -n "$MEMKIT_OBSIDIAN_DIR" ] && MK_ARGS+=(--obsidian "$MEMKIT_OBSIDIAN_DIR")
  kit_as_user env "${MK_ENV[@]}" bash "$MEMORY_KIT_DIR/install.sh" "${MK_ARGS[@]}" \
    || fatal "llm-memory-kit/install.sh завершился с ошибкой"
elif grep -q -- '--non-interactive' "$MEMORY_KIT_DIR/install.sh"; then
  kit_as_user env "${MK_ENV[@]}" bash "$MEMORY_KIT_DIR/install.sh" --non-interactive \
    || fatal "llm-memory-kit/install.sh завершился с ошибкой"
else
  # Старый установщик llm-memory-kit умеет только вопросы. Отвечаем по порядку его
  # вопросов: .claude, проекты, claude, пояс, модель, Obsidian (нет), приватные (нет),
  # первый проект (нет), cron (да). Хуки он печатает текстом — см. проверку ниже.
  warn "llm-memory-kit без --non-interactive — отвечаю на его вопросы по умолчанию"
  printf '%s\n' "$MEMKIT_CLAUDE_DIR" "$MEMKIT_PROJECTS_DIR" "$MEMKIT_CLAUDE_BIN" "$MEMKIT_TZ" \
    "$MEMKIT_MODEL" "n" "" "" "y" \
    | kit_as_user env "${MK_ENV[@]}" bash "$MEMORY_KIT_DIR/install.sh" \
    || fatal "llm-memory-kit/install.sh завершился с ошибкой"
fi

# ============================================================
# 3. Токен Claude для ночных сборщиков (они вызывают claude -p из cron)
# ============================================================
# Обёртки llm-memory-kit читают свой config.sh — добавляем туда подхват claude.env.
MK_CONFIG="$MEMORY_KIT_DIR/config.sh"
if [ -f "$MK_CONFIG" ] && ! grep -q 'claude-code-server-kit: claude token' "$MK_CONFIG"; then
  cat >> "$MK_CONFIG" <<'CFG'

# claude-code-server-kit: claude token — ночным claude -p нужен токен подписки
if [ -r "$HOME/.config/kit/claude.env" ]; then set -a; . "$HOME/.config/kit/claude.env"; set +a; fi
CFG
  chown "$MK_USER:$MK_GROUP" "$MK_CONFIG"
  ok "Сборщики памяти берут токен Claude из ~/.config/kit/claude.env"
fi

# ============================================================
# 4. Проверка: хуки и cron на месте
# ============================================================
if grep -q 'memory-retrieval' "$MEMKIT_CLAUDE_DIR/settings.json" 2>/dev/null; then
  ok "Хуки памяти подключены в $MEMKIT_CLAUDE_DIR/settings.json"
else
  warn "Хуков памяти нет в $MEMKIT_CLAUDE_DIR/settings.json — эта версия llm-memory-kit"
  warn "  печатает их текстом (см. вывод выше). Вставьте блок в \"hooks\" вручную."
fi
if kit_as_user crontab -l 2>/dev/null | grep -q "$MEMORY_KIT_DIR"; then
  ok "Ночные сборщики памяти в crontab пользователя $MK_USER"
else
  warn "В crontab нет задач llm-memory-kit — память не будет собираться ночью"
fi

echo
echo -e "${BOLD}${GREEN}✓ Модуль memory установлен${NC}  ($MEMORY_KIT_DIR, версия $(kit_as_user git -C "$MEMORY_KIT_DIR" rev-parse --short HEAD 2>/dev/null))"
cat <<EOF

  • Память проектов:  $MEMKIT_PROJECTS_DIR/<проект>/memory/
  • Первые темы появятся после ночного прогона.
  • Настройка и устройство — $MEMORY_KIT_DIR/README.md
EOF
