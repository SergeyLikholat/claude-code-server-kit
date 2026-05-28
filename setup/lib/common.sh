# Общая библиотека для всех setup-скриптов
# Source from: source "$(dirname "$0")/../lib/common.sh"

# Цвета
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Корень kit'а
KIT_DIR="${KIT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

# Логирование
log()  { echo -e "${CYAN}[$(date +%H:%M:%S)]${NC} $*"; }
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*" >&2; }
err()  { echo -e "${RED}✗${NC} $*" >&2; }
fatal() { err "$*"; exit 1; }

# Заголовок раздела
section() {
  echo
  echo -e "${BOLD}${BLUE}══════════════════════════════════════════════════════════════${NC}"
  echo -e "${BOLD}${BLUE}  $*${NC}"
  echo -e "${BOLD}${BLUE}══════════════════════════════════════════════════════════════${NC}"
}

# Чтение .env (если существует)
load_env() {
  local env_file="${1:-$KIT_DIR/.env}"
  if [ -f "$env_file" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
    log "Загружен .env: $env_file"
  fi
}

# Запрос значения у пользователя (с дефолтом и возможностью пропуска)
# Использование: ask "Введите имя" "default_value" "VAR_NAME"
ask() {
  local prompt="$1"
  local default="$2"
  local var_name="$3"

  # Если уже установлено в env — использовать
  if [ -n "${!var_name:-}" ]; then
    return 0
  fi

  # Если нет TTY — не интерактивничаем
  if [ ! -t 0 ]; then
    if [ -n "$default" ]; then
      printf -v "$var_name" '%s' "$default"
      return 0
    else
      return 1
    fi
  fi

  local answer
  if [ -n "$default" ]; then
    read -r -p "$(echo -e "${CYAN}?${NC} $prompt [по умолчанию: ${default}]: ")" answer
    answer="${answer:-$default}"
  else
    read -r -p "$(echo -e "${CYAN}?${NC} $prompt: ")" answer
  fi
  printf -v "$var_name" '%s' "$answer"
}

# Запрос секрета (без эхо)
ask_secret() {
  local prompt="$1"
  local var_name="$2"

  if [ -n "${!var_name:-}" ]; then
    return 0
  fi

  if [ ! -t 0 ]; then
    return 1
  fi

  local answer
  read -r -s -p "$(echo -e "${CYAN}?${NC} $prompt: ")" answer
  echo
  printf -v "$var_name" '%s' "$answer"
}

# Подтверждение Y/N
confirm() {
  local prompt="$1"
  local default="${2:-y}"

  if [ ! -t 0 ]; then
    [ "$default" = "y" ]
    return $?
  fi

  local hint="[Y/n]"
  [ "$default" = "n" ] && hint="[y/N]"

  local answer
  read -r -p "$(echo -e "${CYAN}?${NC} $prompt $hint: ")" answer
  answer="${answer:-$default}"
  [[ "$answer" =~ ^[YyДд]$ ]]
}

# Проверка что переменная установлена; если нет — пропустить модуль с понятным сообщением
check_requirement_or_skip() {
  local var_name="$1"
  local instruction="$2"

  if [ -z "${!var_name:-}" ]; then
    warn "Модуль пропущен: не указан ${var_name}"
    echo
    echo "$instruction"
    echo
    return 1
  fi
  return 0
}

# Установка systemd-юнита из шаблона с подстановкой переменных
# Использование: install_systemd_unit "имя" "путь_к_шаблону" KEY1=val1 KEY2=val2 ...
install_systemd_unit() {
  local unit_name="$1"
  local template="$2"
  shift 2

  [ -f "$template" ] || fatal "Шаблон не найден: $template"

  local target="/etc/systemd/system/${unit_name}.service"
  cp "$template" "$target"

  # Подстановка __KEY__ → val
  for kv in "$@"; do
    local key="${kv%%=*}"
    local val="${kv#*=}"
    # экранируем val для sed
    val=$(printf '%s\n' "$val" | sed -e 's/[\/&]/\\&/g')
    sed -i "s/__${key}__/${val}/g" "$target"
  done

  systemctl daemon-reload
  ok "Установлен systemd unit: $unit_name"
}

# Проверка что мы root
require_root() {
  if [ "$EUID" -ne 0 ]; then
    fatal "Запускайте через sudo: sudo bash $0 $*"
  fi
}

# Проверка ОС
require_ubuntu() {
  if [ ! -f /etc/os-release ]; then
    fatal "Не могу определить ОС"
  fi
  # shellcheck disable=SC1091
  source /etc/os-release
  case "$ID" in
    ubuntu|debian) : ;;
    *) warn "Kit тестируется на Ubuntu/Debian. У вас: $ID. Продолжаю на свой страх и риск." ;;
  esac
}

# Проверка установлен ли пакет (apt)
apt_installed() {
  dpkg -l "$1" 2>/dev/null | grep -q '^ii'
}

# Безопасная установка apt-пакетов (только новые, без вопросов)
apt_install() {
  local missing=()
  for pkg in "$@"; do
    apt_installed "$pkg" || missing+=("$pkg")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    log "apt install: ${missing[*]}"
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}"
  fi
}

# Создать директорию с правильными правами
ensure_dir() {
  local dir="$1"
  local mode="${2:-755}"
  mkdir -p "$dir"
  chmod "$mode" "$dir"
}

# Сохранить env-переменные в файл (chmod 600)
save_secrets() {
  local file="$1"
  shift
  ensure_dir "$(dirname "$file")" 700
  : > "$file"
  for var in "$@"; do
    echo "${var}=${!var}" >> "$file"
  done
  chmod 600 "$file"
}

# Экспортировать функции для дочерних скриптов
export -f log ok warn err fatal section ask ask_secret confirm
export -f check_requirement_or_skip install_systemd_unit
export -f require_root require_ubuntu apt_installed apt_install
export -f ensure_dir save_secrets load_env
export KIT_DIR RED GREEN YELLOW BLUE CYAN BOLD NC
