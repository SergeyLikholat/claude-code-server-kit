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

# Установка templated systemd-юнита (foo@.service / foo@.timer).
# Без подстановки — systemd сам разворачивает %i при enable foo@<instance>.
# Использование: install_unit_template "путь/foo@.service.template"
# Имя цели берётся из имени файла без суффикса .template.
install_unit_template() {
  local template="$1"
  [ -f "$template" ] || fatal "Шаблон не найден: $template"
  local base
  base="$(basename "$template")"
  base="${base%.template}"            # foo@.service.template → foo@.service
  cp "$template" "/etc/systemd/system/$base"
  systemctl daemon-reload
  ok "Установлен templated unit: $base"
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

# Найти бинарь claude — сначала PATH, потом стандартные места,
# потом native-binary внутри VS Code-расширения.
# Эхо абсолютный путь или возвращает 1.
find_claude_bin() {
  local cb
  cb="$(command -v claude 2>/dev/null || true)"
  if [ -n "$cb" ] && [ -x "$cb" ]; then echo "$cb"; return 0; fi
  for cand in /usr/local/bin/claude /usr/bin/claude /root/.bun/bin/claude /root/.local/bin/claude; do
    [ -x "$cand" ] && { echo "$cand"; return 0; }
  done
  local ext_dir="/root/.vscode-server/extensions"
  if [ -d "$ext_dir" ]; then
    local newest
    newest="$(ls -1dt "$ext_dir"/anthropic.claude-code-*-linux-x64 2>/dev/null | head -1)"
    if [ -n "$newest" ] && [ -x "$newest/resources/native-binary/claude" ]; then
      echo "$newest/resources/native-binary/claude"
      return 0
    fi
  fi
  return 1
}

# Установить Claude-плагин из marketplace; идемпотентно.
# Использование: install_claude_plugin <plugin_name> <marketplace> [<github_repo>]
# Если <github_repo> указан — сначала добавит marketplace.
install_claude_plugin() {
  local plugin="$1"
  local marketplace="$2"
  local github_repo="${3:-}"

  local claude_bin
  claude_bin="$(find_claude_bin)" || {
    warn "claude бинарь не найден — пропускаю установку плагина $plugin"
    warn "Установите Claude Code (CLI или VS Code расширение) и запустите модуль повторно"
    return 1
  }

  # Marketplace add (если задан репозиторий и не добавлен ранее)
  if [ -n "$github_repo" ]; then
    if ! "$claude_bin" plugin marketplace list 2>/dev/null | grep -q "^${marketplace}\b"; then
      log "Добавляю marketplace: $github_repo"
      "$claude_bin" plugin marketplace add "$github_repo" || warn "Не удалось добавить marketplace $github_repo"
    fi
  fi

  # Проверка: уже установлен?
  if "$claude_bin" plugin list 2>/dev/null | grep -q "^${plugin}@${marketplace}"; then
    ok "Плагин уже установлен: ${plugin}@${marketplace}"
    return 0
  fi

  log "Устанавливаю плагин: ${plugin}@${marketplace}"
  if "$claude_bin" plugin install "${plugin}@${marketplace}"; then
    ok "Плагин установлен: ${plugin}@${marketplace}"
    return 0
  else
    warn "Не удалось установить ${plugin}@${marketplace}"
    return 1
  fi
}

# Гарантировать наличие Node.js + npm
ensure_node() {
  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    return 0
  fi
  log "Устанавливаю Node.js + npm"
  apt_install nodejs npm
}

# Гарантировать наличие Bun (нужен для claude-mem worker)
ensure_bun() {
  if command -v bun >/dev/null 2>&1; then
    return 0
  fi
  ensure_node
  log "Устанавливаю Bun через npm install -g bun"
  npm install -g bun 2>&1 | tail -5
  if ! command -v bun >/dev/null 2>&1; then
    warn "Bun не установлен. Попробуйте вручную: npm install -g bun"
    return 1
  fi
  ok "Bun установлен: $(bun --version 2>&1 | head -1)"
}

# Создать Python venv с пакетами (для PEP 668 на Ubuntu 24.04)
# Использование: create_python_venv <venv_dir> <pkg1> <pkg2> ...
create_python_venv() {
  local venv_dir="$1"
  shift
  local pkgs=("$@")

  apt_install python3-venv python3-pip
  if [ ! -d "$venv_dir" ]; then
    log "Создаю Python venv: $venv_dir"
    python3 -m venv "$venv_dir"
  fi
  log "Устанавливаю в venv: ${pkgs[*]}"
  "$venv_dir/bin/pip" install --quiet --upgrade pip
  "$venv_dir/bin/pip" install --quiet "${pkgs[@]}"
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
export -f check_requirement_or_skip install_systemd_unit install_unit_template
export -f require_root require_ubuntu apt_installed apt_install
export -f ensure_dir save_secrets load_env
export -f find_claude_bin install_claude_plugin ensure_node ensure_bun create_python_venv
export KIT_DIR RED GREEN YELLOW BLUE CYAN BOLD NC
