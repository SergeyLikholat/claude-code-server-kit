#!/bin/bash
# quickstart.sh — установка claude-code-server-kit одной командой.
#
# Использование:
#   curl -fsSL https://raw.githubusercontent.com/SergeyLikholat/claude-code-server-kit/main/quickstart.sh | sudo bash
#
# Что делает:
#   1. Клонирует репо в /root/claude-code-server-kit
#   2. Запускает install.sh (core)
#   3. Интерактивно спрашивает про SSH-hardening
#   4. Интерактивно спрашивает про опциональные модули

set -e

# Цвета
GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
err()  { echo -e "${RED}✗${NC} $*" >&2; }
ask()  { echo -en "${CYAN}?${NC} $*"; }

if [ "$EUID" -ne 0 ]; then
  err "Запускайте через sudo:"
  echo "  curl -fsSL https://raw.githubusercontent.com/SergeyLikholat/claude-code-server-kit/main/quickstart.sh | sudo bash"
  exit 1
fi

cat <<'EOF'

╔══════════════════════════════════════════════════════════════════╗
║                                                                  ║
║   🚀  Claude Code Server Kit — Quickstart                        ║
║                                                                  ║
║   Это установит готовую серверную сборку Claude Code за ~15 мин ║
║   Никаких API-ключей на этом этапе не требуется.                ║
║                                                                  ║
╚══════════════════════════════════════════════════════════════════╝

Что будет сделано:
  1. apt update + базовые пакеты (~2 мин)
  2. Node.js 20.x (~1 мин)
  3. Claude Code CLI (~1 мин)
  4. База агентов и скиллов (~150 готовых, ~2 мин)
  5. Минимальный ~/.claude/settings.json
  6. (опционально) SSH-hardening
  7. (опционально) дополнительные модули

EOF

ask "Готовы продолжить? [y/N]: "
read -r confirm
[[ "$confirm" =~ ^[YyДд]$ ]] || { echo "Отмена."; exit 0; }

# ============================================================
# 1. Клонируем kit
# ============================================================
echo
echo "▸ Клонирую claude-code-server-kit..."
KIT_DIR=/root/claude-code-server-kit
if [ -d "$KIT_DIR/.git" ]; then
  cd "$KIT_DIR" && git pull --ff-only
  ok "Уже склонирован, обновлён"
else
  apt-get install -y -qq git 2>/dev/null
  git clone --depth 1 https://github.com/SergeyLikholat/claude-code-server-kit "$KIT_DIR"
  ok "Склонирован в $KIT_DIR"
fi

# ============================================================
# 2. Core install
# ============================================================
echo
echo "▸ Запускаю установку core..."
cd "$KIT_DIR"
bash install.sh

# ============================================================
# 3. Опционально: SSH hardening
# ============================================================
echo
echo "════════════════════════════════════════════════════════════════"
echo "  Опционально: настройка SSH-ключей и отключение пароля"
echo "════════════════════════════════════════════════════════════════"
echo
echo "Сейчас вы скорее всего зашли по паролю. Это небезопасно — боты в"
echo "интернете перебирают пароли 24/7. Настройка ключей решает эту проблему."
echo
echo "Подробная инструкция (если ещё не настраивали ключи на ноуте):"
echo "  https://github.com/SergeyLikholat/claude-code-server-kit/blob/main/docs/SSH-SETUP.md"
echo
ask "Настроить SSH-hardening сейчас? (потребуется готовый ключ на ноуте) [y/N]: "
read -r setup_ssh
if [[ "$setup_ssh" =~ ^[YyДд]$ ]]; then
  bash "$KIT_DIR/preflight-ssh.sh"
fi

# ============================================================
# 4. Опционально: модули
# ============================================================
echo
echo "════════════════════════════════════════════════════════════════"
echo "  Опциональные модули"
echo "════════════════════════════════════════════════════════════════"
echo
bash "$KIT_DIR/install.sh" --list
echo

INSTALL_MODULES=()

echo "${BOLD}Хотите установить какие-то модули прямо сейчас?${NC}"
echo "(можно сделать позже одной командой: sudo bash install.sh --module ИМЯ)"
echo

declare -A MODULE_PROMPTS=(
  ["tg-bot"]="Telegram-бот для управления Claude с телефона (нужен токен от @BotFather)"
  ["backup"]="Бэкап на Я.Диск (нужен OAuth-app в Яндексе)"
  ["claude-mem"]="Память между сессиями (ничего не нужно)"
  ["helpers"]="Полезные мелочи: openpyxl_safe, tg-md (бесплатно). Опционально nanobanana+gemini-tts (нужен Gemini key)"
  ["parakeet"]="Транскрипция голосовых сообщений (нужен HuggingFace токен)"
  ["hooks-extras"]="Дополнительные хуки автоматизации"
)

for m in claude-mem helpers tg-bot backup parakeet hooks-extras; do
  ask "  Установить '${m}' (${MODULE_PROMPTS[$m]})? [y/N]: "
  read -r ans
  [[ "$ans" =~ ^[YyДд]$ ]] && INSTALL_MODULES+=("$m")
done

for m in "${INSTALL_MODULES[@]}"; do
  echo
  echo "▸ Устанавливаю модуль: $m"
  bash "$KIT_DIR/install.sh" --module "$m" || warn "Модуль $m вернул ошибку — продолжаю с остальными"
done

# ============================================================
# 5. Финал
# ============================================================
cat <<EOF

${BOLD}${GREEN}╔══════════════════════════════════════════════════════════════════╗${NC}
${BOLD}${GREEN}║                                                                  ║${NC}
${BOLD}${GREEN}║   ✓  Установка завершена!                                        ║${NC}
${BOLD}${GREEN}║                                                                  ║${NC}
${BOLD}${GREEN}╚══════════════════════════════════════════════════════════════════╝${NC}

${BOLD}Дальше:${NC}

  1. Авторизуйтесь в Claude:
     ${BOLD}claude${NC}
     (откроется OAuth-ссылка — пройдите в браузере, нужен аккаунт на console.anthropic.com)

  2. Начните пользоваться:
     ${BOLD}claude${NC}
     "Привет! Расскажи что умеешь."

  3. Добавить ещё модули потом:
     ${BOLD}sudo bash $KIT_DIR/install.sh --list${NC}
     ${BOLD}sudo bash $KIT_DIR/install.sh --module ИМЯ${NC}

  4. Проверить что установлено:
     ${BOLD}sudo bash $KIT_DIR/install.sh --check${NC}

${BOLD}Документация:${NC}
  • https://github.com/SergeyLikholat/claude-code-server-kit
  • QUICKSTART.md   — этот путь
  • MODULES.md      — что какой модуль делает
  • TROUBLESHOOTING.md  — если что-то не работает

${BOLD}⚠ ВАЖНО — сохраните в Bitwarden / 1Password:${NC}
  • IP-адрес и логин сервера
  • SSH-ключ (приватный) если настраивали
  • Restic-пароль если ставили модуль backup ⚠⚠⚠ КРИТИЧНО!
  • Yandex client_id+secret если ставили модуль backup

EOF
