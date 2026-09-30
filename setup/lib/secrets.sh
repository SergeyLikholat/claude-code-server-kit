# setup/lib/secrets.sh — ключи одним файлом.
#
# Подключается из install.sh ПОСЛЕ common.sh. Делает четыре вещи:
#   1. kit_load_secrets FILE      — читает secrets.env как данные (не исполняет) и экспортирует
#                                   известные ключи, чтобы модули не задавали вопросов;
#   2. kit_validate_secrets MODE  — проверяет каждый заполненный ключ вживую, ошибки по-русски;
#   3. kit_persist_secrets        — сохраняет ключи в ~/.config/kit/secrets.env (600);
#   4. kit_install_claude_env     — доставляет токен Claude в shell, cron и службу T3.
#
# Ни одна функция не печатает значения ключей и не передаёт их в argv внешних программ
# (curl получает URL и заголовки через конфиг на stdin: в `ps` токенов не видно).

# Все ключи, которые понимает kit. Остальные строки файла — предупреждение и пропуск
# (защита от опечаток вроде CLAUDE_OAUTH_TOKEN).
KIT_SECRET_KEYS=(
  CLAUDE_CODE_OAUTH_TOKEN USER_NAME USER_EMAIL
  T3_DOMAIN ACME_EMAIL T3_TARBALL T3_TARBALL_SHA256 T3_APK T3_PORT
  TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID
  GEMINI_API_KEY
  RCLONE_YANDEX_TOKEN RESTIC_PASSWORD BACKUP_TARGET_PATH
  KIT_WITH_PARAKEET HF_TOKEN
  MEMORY_KIT_REPO MEMORY_KIT_REF MEMORY_KIT_OBSIDIAN_DIR
)

KIT_CLAUDE_TOKEN_RE='^sk-ant-oat01-[A-Za-z0-9_-]{20,}$'
KIT_HTTP_TIMEOUT="${KIT_HTTP_TIMEOUT:-20}"
KIT_CLAUDE_PROBE_TIMEOUT="${KIT_CLAUDE_PROBE_TIMEOUT:-90}"

# ────────────────────────────────────────────────────────────────────────────
# Пользователь, для которого ставится среда (агент, T3, cron). По умолчанию root —
# как на рабочем сервере (развилка 4 плана). Переопределить: KIT_USER=ivan.
# ────────────────────────────────────────────────────────────────────────────
kit_user() { echo "${KIT_USER:-${T3_USER:-root}}"; }
kit_home() {
  local u; u="$(kit_user)"
  getent passwd "$u" | cut -d: -f6
}
kit_config_dir() { echo "$(kit_home)/.config/kit"; }

# Создать каталог владельцем пользователя среды — ТОЛЬКО если его нет. `install -d` на
# существующем каталоге сбрасывает права (~/.config 700 → 755), поэтому не для чужих папок.
kit_user_dir() {
  local d="$1" m="${2:-755}" u
  [ -d "$d" ] && return 0
  u="$(kit_user)"
  install -d -m "$m" -o "$u" -g "$(id -gn "$u")" "$d"
}

# ~/.config/kit (700) владельцем пользователя среды; печатает путь
kit_ensure_config_dir() {
  local u dir
  u="$(kit_user)"; dir="$(kit_config_dir)"
  kit_user_dir "$(kit_home)/.config" 700
  install -d -m 700 -o "$u" -g "$(id -gn "$u")" "$dir"
  echo "$dir"
}

# Выполнить команду от имени пользователя среды — с его HOME и его systemd --user
# (XDG_RUNTIME_DIR/DBUS нужны для `systemctl --user` из-под root).
kit_as_user() {
  local u h id
  u="$(kit_user)"; h="$(kit_home)"; id="$(id -u "$u")"
  runuser -u "$u" -- env HOME="$h" USER="$u" LOGNAME="$u" \
    XDG_RUNTIME_DIR="/run/user/$id" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$id/bus" \
    T3CODE_HOME="$h/.t3" \
    PATH="$h/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/bin" \
    "$@"
}

_kit_is_known_key() {
  local k="$1" known
  for known in "${KIT_SECRET_KEYS[@]}"; do [ "$known" = "$k" ] && return 0; done
  return 1
}

# ────────────────────────────────────────────────────────────────────────────
# 1. Чтение файла ключей
# ────────────────────────────────────────────────────────────────────────────
# Формат: КЛЮЧ=значение; значение можно взять в '...' или "..." (снимаются как есть,
# без подстановок). Комментарии — строки с # и хвост « # …» у значения без кавычек.
# Пустое значение не перетирает уже заданное в окружении.
kit_load_secrets() {
  local file="$1" line key val lineno=0 loaded=0 bad=0
  [ -n "$file" ] || { err "Не указан файл ключей"; return 1; }
  [ -f "$file" ] || { err "Файл ключей не найден: $file"; return 1; }
  [ -r "$file" ] || { err "Нет прав на чтение файла ключей: $file"; return 1; }

  if [ -n "$(find "$file" -maxdepth 0 -perm /o+r 2>/dev/null)" ]; then
    warn "Файл $file читают все пользователи сервера. Лучше: chmod 600 $file"
  fi

  while IFS= read -r line || [ -n "$line" ]; do
    lineno=$((lineno + 1))
    line="${line%$'\r'}"                               # файл из Windows (CRLF)
    line="${line#"${line%%[![:space:]]*}"}"            # пробелы слева
    [ -z "$line" ] && continue
    [ "${line:0:1}" = "#" ] && continue
    line="${line#export }"

    if [[ ! "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      err "$file, строка $lineno: ожидается КЛЮЧ=значение"
      bad=$((bad + 1)); continue
    fi
    key="${BASH_REMATCH[1]}"; val="${BASH_REMATCH[2]}"

    if [[ "$val" =~ ^\'(.*)\'[[:space:]]*$ ]]; then
      val="${BASH_REMATCH[1]}"
    elif [[ "$val" =~ ^\"(.*)\"[[:space:]]*$ ]]; then
      val="${BASH_REMATCH[1]}"
    else
      val="${val%%[[:space:]]#*}"                      # хвостовой комментарий
      val="${val%"${val##*[![:space:]]}"}"             # пробелы справа
    fi

    if ! _kit_is_known_key "$key"; then
      warn "$file, строка $lineno: неизвестный ключ $key — пропущен (опечатка?)"
      continue
    fi
    [ -z "$val" ] && continue

    printf -v "$key" '%s' "$val"
    # shellcheck disable=SC2163  # экспорт переменной по имени — намеренно
    export "$key"
    loaded=$((loaded + 1))
  done < "$file"

  [ "$bad" -eq 0 ] || { err "В файле ключей $bad строк(и) с ошибкой формата — исправьте и запустите снова"; return 1; }

  # Имена, под которыми значения ждут существующие модули
  [ -n "${HF_TOKEN:-}" ] && export HUGGINGFACE_TOKEN="$HF_TOKEN"
  [ -n "${RESTIC_PASSWORD:-}" ] && export BACKUP_RESTIC_PASSWORD="$RESTIC_PASSWORD"
  export KIT_SECRETS_FILE="$file"

  log "Ключи: загружено $loaded из $file"
  return 0
}

# ────────────────────────────────────────────────────────────────────────────
# HTTP без секретов в argv: URL и заголовки уходят в curl конфигом через stdin.
# Результат: KIT_HTTP_CODE (000 — нет связи), KIT_HTTP_BODY (до 4 КБ).
# ────────────────────────────────────────────────────────────────────────────
_kit_http() {
  local url="$1"; shift
  local body cfg h
  body="$(mktemp)"
  cfg="$(printf 'url = "%s"\n' "$url"; for h in "$@"; do printf 'header = "%s"\n' "$h"; done)"
  KIT_HTTP_CODE="$(printf '%s\n' "$cfg" | curl -sS -m "$KIT_HTTP_TIMEOUT" -o "$body" -w '%{http_code}' -K - 2>/dev/null)" || true
  [ -n "$KIT_HTTP_CODE" ] || KIT_HTTP_CODE="000"
  KIT_HTTP_BODY="$(head -c 4000 "$body" 2>/dev/null)"
  rm -f "$body"
}

# Достать поле из JSON-ответа: _kit_json '["error"]["message"]'
_kit_json() {
  printf '%s' "$KIT_HTTP_BODY" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    v = eval("d" + sys.argv[1])
    print(v if not isinstance(v, (dict, list)) else json.dumps(v, ensure_ascii=False))
except Exception:
    pass' "$1" 2>/dev/null
}

_kit_no_network() {
  err "$1: нет связи с $2 (проверьте интернет, DNS и исходящий фаервол сервера)."
  printf '   Проверить руками: curl -sS -m 10 -o /dev/null https://%s\n' "$2" >&2
}

# ────────────────────────────────────────────────────────────────────────────
# 2. Проверки. Каждая: 0 — ключ рабочий, 1 — нет (сообщение уже напечатано).
# ────────────────────────────────────────────────────────────────────────────

# Claude. Почему так:
#   `claude auth status` токен НЕ проверяет — на любой строке отвечает loggedIn:true
#   (проверено на CLI 2.1.283). Поэтому первый шаг — GET /v1/models с токеном: запрос
#   бесплатный, лимиты подписки не тратит, отвечает за доли секунды и различает
#   «токен неверный/отозван/истёк» (401 authentication_error). Если API ответил
#   чем-то другим (403, 429, 5xx) — судить нельзя, тогда боевой вызов kit_check_claude_token_cli.
kit_check_claude_token() {
  local t="${CLAUDE_CODE_OAUTH_TOKEN:-}" msg
  # 1 — API не дал ответа; install.sh (--full) доделает проверку после установки CLI
  export KIT_CLAUDE_CHECK_PENDING=0
  if [ -z "$t" ]; then
    err "CLAUDE_CODE_OAUTH_TOKEN не задан — без него Claude на сервере не заработает."
    echo "   Где взять: на компьютере с Claude Code выполнить  claude setup-token" >&2
    echo "   (вход на claude.ai по ссылке), вставить sk-ant-oat01-... в secrets.env." >&2
    return 1
  fi
  if [[ "$t" == sk-ant-api* ]]; then
    err "CLAUDE_CODE_OAUTH_TOKEN: это ключ API (sk-ant-api…, оплата по токенам), а нужен"
    echo "   токен подписки из  claude setup-token  — он начинается с sk-ant-oat01-" >&2
    return 1
  fi
  if [[ ! "$t" =~ $KIT_CLAUDE_TOKEN_RE ]]; then
    err "CLAUDE_CODE_OAUTH_TOKEN не похож на токен подписки: ожидается sk-ant-oat01-… одной строкой,"
    echo "   без пробелов и кавычек внутри. Частая причина — токен скопирован не целиком" >&2
    echo "   (в терминале он переносится на две строки)." >&2
    return 1
  fi

  _kit_http "https://api.anthropic.com/v1/models?limit=1" \
    "Authorization: Bearer $t" "anthropic-version: 2023-06-01" "anthropic-beta: oauth-2025-04-20"
  case "$KIT_HTTP_CODE" in
    200)
      ok "Claude: токен подписки принят (${#t} символов)"
      return 0 ;;
    401)
      msg="$(_kit_json '["error"]["message"]')"
      if printf '%s' "$msg" | grep -qi 'expir'; then
        err "Claude: срок действия токена истёк. Выполните  claude setup-token  заново и замените значение."
      else
        err "Claude: Anthropic отклонил токен${msg:+ («$msg»)}."
        echo "   Токен неверный или отозван. Получите новый:  claude setup-token" >&2
      fi
      return 1 ;;
    000)
      _kit_no_network "Claude" "api.anthropic.com"
      return 1 ;;
    *)
      KIT_CLAUDE_CHECK_PENDING=1
      if find_claude_bin >/dev/null 2>&1; then
        warn "Claude: API ответил кодом $KIT_HTTP_CODE — проверяю токен пробным запросом через claude"
        kit_check_claude_token_cli
        return $?
      fi
      warn "Claude: API ответил кодом $KIT_HTTP_CODE, формат токена верный. Пробный запрос сделаю после установки CLI."
      return 0 ;;
  esac
}

# Боевая проверка: один короткий `claude -p` моделью haiku во ВРЕМЕННОЙ папке настроек
# (хуки, память и плагины пользователя не запускаются, его ~/.claude не трогается).
# Тратит один маленький запрос из лимита подписки — поэтому только как запасной путь.
kit_check_claude_token_cli() {
  local cb tmp out rc
  cb="$(find_claude_bin)" || { err "Claude: CLI не найден — пробный запрос невозможен"; return 1; }
  tmp="$(mktemp -d)"
  mkdir -p "$tmp/.claude" && echo '{}' > "$tmp/.claude/.claude.json"
  out="$(cd "$tmp" && HOME="$tmp" CLAUDE_CONFIG_DIR="$tmp/.claude" \
         CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" \
         timeout "$KIT_CLAUDE_PROBE_TIMEOUT" "$cb" -p "Ответь одним словом: ok" \
         --model haiku --max-turns 1 </dev/null 2>&1)"
  rc=$?
  rm -rf "$tmp"
  if [ "$rc" -eq 0 ] && [ -n "$out" ]; then
    ok "Claude: пробный запрос прошёл, подписка работает"
    KIT_CLAUDE_CHECK_PENDING=0
    return 0
  fi
  if [ "$rc" -eq 124 ]; then
    err "Claude: пробный запрос не ответил за ${KIT_CLAUDE_PROBE_TIMEOUT} с (сеть или перегрузка Anthropic). Повторите позже."
  elif printf '%s' "$out" | grep -qiE '401|invalid|expired|authenticat'; then
    err "Claude: токен не принят — $(printf '%s' "$out" | head -1)"
    echo "   Получите новый:  claude setup-token" >&2
  elif printf '%s' "$out" | grep -qiE '429|rate|limit|usage'; then
    err "Claude: токен верный, но лимит подписки сейчас исчерпан — $(printf '%s' "$out" | head -1)"
  else
    err "Claude: пробный запрос не прошёл (код $rc): $(printf '%s' "$out" | head -2 | tr '\n' ' ')"
  fi
  return 1
}

kit_check_telegram() {
  local t="${TELEGRAM_BOT_TOKEN:-}" chat="${TELEGRAM_CHAT_ID:-}" name msg
  if [[ ! "$t" =~ ^[0-9]{5,}:[A-Za-z0-9_-]{30,}$ ]]; then
    err "TELEGRAM_BOT_TOKEN: формат не тот. Ожидается 123456789:AAH… — как выдал @BotFather, целиком."
    return 1
  fi
  _kit_http "https://api.telegram.org/bot$t/getMe"
  case "$KIT_HTTP_CODE" in
    200) name="$(_kit_json '["result"]["username"]')"; ok "Telegram: бот @$name отвечает" ;;
    401|404)
      err "Telegram: токен не принят (бот удалён или токен перевыпущен). Возьмите актуальный в @BotFather → /token."
      return 1 ;;
    000) _kit_no_network "Telegram" "api.telegram.org"; return 1 ;;
    *) err "Telegram: неожиданный ответ $KIT_HTTP_CODE — $(_kit_json '["description"]')"; return 1 ;;
  esac

  [ -z "$chat" ] && return 0
  if [[ ! "$chat" =~ ^-?[0-9]+$ ]]; then
    err "TELEGRAM_CHAT_ID: нужен числовой ID (у групп начинается с -100), а не имя или @ссылка."
    return 1
  fi
  _kit_http "https://api.telegram.org/bot$t/getChat?chat_id=$chat"
  case "$KIT_HTTP_CODE" in
    200) ok "Telegram: бот видит чат «$(_kit_json '["result"].get("title") or d["result"].get("first_name","")')»" ;;
    400|403)
      msg="$(_kit_json '["description"]')"
      err "Telegram: бот не видит чат $chat${msg:+ ($msg)}."
      echo "   Добавьте бота в группу (или напишите ему /start в личке) и проверьте ID." >&2
      return 1 ;;
    *) err "Telegram: проверка чата — ответ $KIT_HTTP_CODE"; return 1 ;;
  esac
}

kit_check_gemini() {
  local k="${GEMINI_API_KEY:-}" msg
  [[ "$k" =~ ^[A-Za-z0-9_-]{30,}$ ]] || {
    err "GEMINI_API_KEY: формат не тот (ключ AI Studio обычно начинается с AIza, одной строкой)."
    return 1; }
  _kit_http "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1" "x-goog-api-key: $k"
  msg="$(_kit_json '["error"]["message"]')"
  case "$KIT_HTTP_CODE" in
    200) ok "Gemini: ключ принят" ;;
    400|401) err "Gemini: ключ не принят${msg:+ («$msg»)}. Создайте новый: https://aistudio.google.com/apikey"; return 1 ;;
    403)
      err "Gemini: доступ запрещён${msg:+ («$msg»)}."
      echo "   Либо в проекте Google выключен Generative Language API, либо Gemini недоступен" >&2
      echo "   из страны, где стоит сервер (например, с российских IP)." >&2
      return 1 ;;
    000) _kit_no_network "Gemini" "generativelanguage.googleapis.com"; return 1 ;;
    *) err "Gemini: неожиданный ответ $KIT_HTTP_CODE${msg:+ — $msg}"; return 1 ;;
  esac
}

# Я.Диск: токен rclone (JSON из `rclone authorize "yandex"`). Если rclone уже есть —
# `rclone lsd` на временном конфиге (как будет работать бэкап); иначе — тот же токен
# в REST API Диска. Временный конфиг удаляется; рабочий rclone.conf не трогается.
kit_check_yandex() {
  local j="${RCLONE_YANDEX_TOKEN:-}" access tmp out rc
  access="$(printf '%s' "$j" | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])' 2>/dev/null)"
  if [ -z "$access" ] || [[ ! "$access" =~ ^[A-Za-z0-9._-]+$ ]]; then
    err "RCLONE_YANDEX_TOKEN: это не JSON с access_token. Вставьте строку {\"access_token\":…} из вывода"
    echo "   rclone authorize \"yandex\"  целиком, в одинарных кавычках: RCLONE_YANDEX_TOKEN='{…}'" >&2
    return 1
  fi
  if command -v rclone >/dev/null 2>&1; then
    tmp="$(mktemp)"; chmod 600 "$tmp"
    printf '[kitcheck]\ntype = yandex\ntoken = %s\n' "$j" > "$tmp"
    out="$(timeout 60 rclone lsd kitcheck: --config "$tmp" --retries 1 --low-level-retries 1 2>&1)"; rc=$?
    rm -f "$tmp"
    if [ "$rc" -eq 0 ]; then ok "Я.Диск: доступ есть (rclone lsd)"; return 0; fi
    err "Я.Диск: rclone не получил список папок — $(printf '%s' "$out" | grep -iE 'error|fail' | tail -1)"
    echo "   Токен истёк или отозван. Получите новый:  rclone authorize \"yandex\"" >&2
    return 1
  fi
  _kit_http "https://cloud-api.yandex.net/v1/disk/" "Authorization: OAuth $access"
  case "$KIT_HTTP_CODE" in
    200) ok "Я.Диск: доступ есть (REST API)" ;;
    401|403) err "Я.Диск: токен не принят. Получите новый:  rclone authorize \"yandex\""; return 1 ;;
    000) _kit_no_network "Я.Диск" "cloud-api.yandex.net"; return 1 ;;
    *) err "Я.Диск: неожиданный ответ $KIT_HTTP_CODE"; return 1 ;;
  esac
}

kit_check_restic_password() {
  local p="${RESTIC_PASSWORD:-}"
  if [ "${#p}" -lt 12 ]; then
    err "RESTIC_PASSWORD короче 12 символов. Придумайте длиннее или оставьте пустым — сгенерируется сам."
    return 1
  fi
  ok "Бэкап: пароль шифрования задан (${#p} символов)"
}

kit_check_hf() {
  [[ "${HF_TOKEN:-}" =~ ^hf_[A-Za-z0-9]{20,}$ ]] || {
    err "HF_TOKEN: формат не тот — токен Hugging Face начинается с hf_, одной строкой."
    return 1; }
  _kit_http "https://huggingface.co/api/whoami-v2" "Authorization: Bearer ${HF_TOKEN:-}"
  case "$KIT_HTTP_CODE" in
    200) ok "Hugging Face: токен принят ($(_kit_json '["name"]'))" ;;
    401) err "HF_TOKEN не принят Hugging Face. Создайте токен типа read: https://huggingface.co/settings/tokens"; return 1 ;;
    000) _kit_no_network "Hugging Face" "huggingface.co"; return 1 ;;
    *) err "Hugging Face: неожиданный ответ $KIT_HTTP_CODE"; return 1 ;;
  esac
}

# Настройки T3 — не секреты, но без них модуль не встанет, поэтому проверяем заранее.
kit_check_t3_settings() {
  local d="${T3_DOMAIN:-}" e="${ACME_EMAIL:-}" src="${T3_TARBALL:-}" ips local_ips fail=0
  if [[ ! "$d" =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$ ]]; then
    err "T3_DOMAIN: «$d» — не доменное имя. Нужно вида t3.example.ru, без https:// и слэшей."
    fail=1
  else
    ips="$(getent ahostsv4 "$d" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')"
    if [ -z "$ips" ]; then
      err "T3_DOMAIN: $d не находится в DNS. Создайте A-запись на IP этого сервера и подождите 5–30 минут."
      echo "   Без неё Caddy не получит сертификат. Пропустить проверку: KIT_SKIP_DNS_CHECK=1" >&2
      [ "${KIT_SKIP_DNS_CHECK:-0}" = "1" ] || fail=1
    else
      local_ips=" $(hostname -I 2>/dev/null | xargs) "
      local ip match=0
      for ip in $ips; do [[ "$local_ips" == *" $ip "* ]] && match=1; done
      if [ "$match" = 1 ]; then
        ok "T3: $d → $ips(адрес этого сервера)"
      else
        warn "T3: $d → $ips— среди адресов сервера (${local_ips:1:-1}) его нет."
        warn "    Если у провайдера внешний IP через NAT — это нормально; иначе поправьте A-запись."
      fi
    fi
  fi
  if [[ ! "$e" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; then
    err "ACME_EMAIL: нужна почта (на неё Let's Encrypt пишет, если сертификат не продлился)."
    fail=1
  fi
  if [ -z "$src" ]; then
    err "T3_TARBALL: не указан архив сборки T3 (путь или https-ссылка). Собирается t3-patches/package.sh."
    fail=1
  elif [[ "$src" =~ ^https?:// ]]; then
    if ! curl -sSfIL -m "$KIT_HTTP_TIMEOUT" -o /dev/null "$src" 2>/dev/null; then
      err "T3_TARBALL: ссылка $src не открывается (нет файла или нет доступа)."
      fail=1
    fi
  elif [ ! -r "$src" ]; then
    err "T3_TARBALL: файла $src нет на сервере. Загрузите архив (scp) или дайте https-ссылку."
    fail=1
  fi
  if [ -n "${T3_PORT:-}" ] && [[ ! "$T3_PORT" =~ ^[0-9]{2,5}$ ]]; then
    err "T3_PORT: нужен номер порта, например 7373"; fail=1
  fi
  [ "$fail" = 0 ] && ok "T3: домен, почта и архив сборки на месте"
  return "$fail"
}

# Прогон всех проверок. MODE=full — токен Claude обязателен; apply — без настроек T3
# (он уже установлен); partial — только то, что заполнено. KIT_SKIP_VALIDATION=1 — без живых проверок (офлайн).
kit_validate_secrets() {
  local mode="${1:-partial}" fails=0
  section "Проверка ключей"
  if [ "${KIT_SKIP_VALIDATION:-0}" = "1" ]; then
    warn "KIT_SKIP_VALIDATION=1 — живые проверки пропущены, ошибки всплывут при установке"
    return 0
  fi
  if [ "$mode" = "full" ] || [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
    kit_check_claude_token || fails=$((fails + 1))
  fi
  # Домен и архив T3 нужны только при установке; при замене ключей (apply) T3 уже стоит
  if [ "$mode" != "apply" ] && [ -n "${T3_DOMAIN:-}${T3_TARBALL:-}" ]; then
    kit_check_t3_settings || fails=$((fails + 1))
  fi
  [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && { kit_check_telegram || fails=$((fails + 1)); }
  [ -n "${GEMINI_API_KEY:-}" ] && { kit_check_gemini || fails=$((fails + 1)); }
  [ -n "${RCLONE_YANDEX_TOKEN:-}" ] && { kit_check_yandex || fails=$((fails + 1)); }
  [ -n "${RESTIC_PASSWORD:-}" ] && { kit_check_restic_password || fails=$((fails + 1)); }
  [ -n "${HF_TOKEN:-}" ] && { kit_check_hf || fails=$((fails + 1)); }

  if [ "$fails" -gt 0 ]; then
    echo
    err "Не прошло проверок: $fails. Исправьте значения в файле ключей и запустите установку снова."
    echo "   На сервере ничего не менялось." >&2
    return 1
  fi
  ok "Все заполненные ключи рабочие"
}

# ────────────────────────────────────────────────────────────────────────────
# 3. Сохранение ключей на сервере: ~/.config/kit/secrets.env (700/600, владелец — KIT_USER).
# Пишется всё, что сейчас задано, — повторный запуск дополняет, а не затирает.
# ────────────────────────────────────────────────────────────────────────────
# Значение пишется как '…' без экранирования: kit_load_secrets берёт всё между первой и
# последней кавычкой буквально, так что JSON и кавычки внутри переживают круг «записал — прочёл».
# Файл — данные для kit_load_secrets, а не скрипт для `source`.

kit_persist_secrets() {
  local u dir file tmp k
  u="$(kit_user)"; dir="$(kit_ensure_config_dir)"; file="$dir/secrets.env"
  tmp="$(mktemp "$dir/.secrets.XXXXXX")"
  {
    echo "# Ключи claude-code-server-kit. Записано install.sh $(date '+%F %T')."
    echo "# Правка: изменить значение и выполнить  sudo bash install.sh --apply-secrets"
    for k in "${KIT_SECRET_KEYS[@]}"; do
      [ -n "${!k:-}" ] && printf "%s='%s'\n" "$k" "${!k}"
    done
  } > "$tmp"
  chmod 600 "$tmp"; chown "$u:$(id -gn "$u")" "$tmp"
  mv -f "$tmp" "$file"
  ok "Ключи сохранены: $file (права 600)"
}

# ────────────────────────────────────────────────────────────────────────────
# 4. Токен Claude — туда, где запускается claude:
#   • ~/.config/kit/claude.env      — одна строка CLAUDE_CODE_OAUTH_TOKEN=… (600).
#                                    Формат годится и для systemd EnvironmentFile, и для `. file`.
#   • служба T3                     — EnvironmentFile=-%h/.config/kit/claude.env в юните (модуль t3);
#   • интерактивный shell           — блок в ~/.bashrc, который читает этот файл;
#   • cron                          — обёртка /usr/local/bin/kit-env: `kit-env команда …`;
#                                    сборщики llm-memory-kit подхватывают файл через свой config.sh.
# В файл уходит только токен Claude: агенту и T3 ни к чему токены Telegram и бэкапа.
# ────────────────────────────────────────────────────────────────────────────
kit_install_claude_env() {
  local u home dir file tmp rc_file
  u="$(kit_user)"; home="$(kit_home)"; dir="$(kit_config_dir)"; file="$dir/claude.env"
  if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
    warn "Токен Claude не задан — claude.env не создан. Вход вручную: claude auth login"
    return 0
  fi
  [[ "$CLAUDE_CODE_OAUTH_TOKEN" =~ $KIT_CLAUDE_TOKEN_RE ]] || { err "Токен Claude в неверном формате — claude.env не записан"; return 1; }

  kit_ensure_config_dir >/dev/null
  tmp="$(mktemp "$dir/.claude-env.XXXXXX")"
  printf '# Токен подписки Claude (claude setup-token). Читают: служба T3, ~/.bashrc, kit-env (cron).\nCLAUDE_CODE_OAUTH_TOKEN=%s\n' \
    "$CLAUDE_CODE_OAUTH_TOKEN" > "$tmp"
  chmod 600 "$tmp"; chown "$u:$(id -gn "$u")" "$tmp"
  mv -f "$tmp" "$file"
  ok "Токен Claude: $file"

  # Интерактивный shell (и терминал внутри T3)
  rc_file="$home/.bashrc"
  if ! grep -q '>>> claude-code-server-kit: claude token >>>' "$rc_file" 2>/dev/null; then
    cat >> "$rc_file" <<'RC'

# >>> claude-code-server-kit: claude token >>>
if [ -r "$HOME/.config/kit/claude.env" ]; then set -a; . "$HOME/.config/kit/claude.env"; set +a; fi
# <<< claude-code-server-kit: claude token <<<
RC
    chown "$u:$(id -gn "$u")" "$rc_file"
    ok "Токен Claude: подключён в $rc_file"
  fi

  # cron и любые фоновые скрипты: kit-env <команда>
  local bin="${KIT_BIN_DIR:-/usr/local/bin}"
  cat > "$bin/kit-env" <<'WRAP'
#!/bin/sh
# kit-env — запустить команду с токеном Claude из ~/.config/kit/claude.env.
# Для cron, где ~/.bashrc не читается:  0 3 * * * kit-env claude -p "…"
f="${KIT_CLAUDE_ENV:-$HOME/.config/kit/claude.env}"
if [ -r "$f" ]; then set -a; . "$f"; set +a; fi
exec "$@"
WRAP
  chmod 755 "$bin/kit-env"
  ok "Токен Claude: обёртка для cron — $bin/kit-env"
}

# Убрать переданный файл ключей (копия уже в ~/.config/kit/secrets.env)
kit_cleanup_secrets_source() {
  local src="${KIT_SECRETS_FILE:-}" kept
  [ -n "$src" ] && [ -f "$src" ] || return 0
  kept="$(kit_config_dir)/secrets.env"
  [ "$(readlink -f "$src")" = "$(readlink -f "$kept")" ] && return 0
  if [ "${KIT_DELETE_SECRETS:-0}" = "1" ]; then
    shred -u "$src" 2>/dev/null || rm -f "$src"
    ok "Файл ключей $src удалён (копия — $kept)"
  else
    warn "Файл ключей $src остался на диске. Копия уже в $kept — удалите исходник:"
    warn "    shred -u $src"
  fi
}
