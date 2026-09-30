#!/bin/bash
# Модуль t3: T3 Code — окно к Claude Code из браузера и Android-приложения.
#
# Ставит готовую сборку с нашими патчами (архив t3-patches/package.sh, на сервере ничего
# не компилируется), службу systemd пользователя с linger на 127.0.0.1:<порт>, Caddy с
# автоматическим TLS на домене, печатает ссылку-приглашение с QR-кодом и где взять APK.
#
# Нужно (из secrets.env или окружения):
#   T3_DOMAIN     домен, A-запись которого смотрит на этот сервер
#   ACME_EMAIL    почта для Let's Encrypt
#   T3_TARBALL    путь или https-ссылка на архив сборки
# Не обязательно: T3_TARBALL_SHA256, T3_APK, T3_PORT (7373), T3_PAIR_TTL (1h),
#   KIT_USER (root), T3_WORKDIR (домашняя папка), T3_BIND_HOST (127.0.0.1),
#   T3_CADDY_MODE (auto|system|docker|other|skip), T3_WITH_LIBREOFFICE=1 (просмотр .doc).
#
#   sudo bash install.sh --module t3 --secrets secrets.env
set -e
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../lib/secrets.sh"

log "Установка модуля: t3"

T3_USER="$(kit_user)"
T3_HOME_DIR="$(kit_home)"
[ -n "$T3_HOME_DIR" ] || fatal "Пользователь $T3_USER не найден"
T3_UID="$(id -u "$T3_USER")"
T3_GROUP="$(id -gn "$T3_USER")"
T3_PORT="${T3_PORT:-7373}"
T3_BIND_HOST="${T3_BIND_HOST:-127.0.0.1}"
T3_WORKDIR="${T3_WORKDIR:-$T3_HOME_DIR}"
T3_UNIT="t3code.service"
T3_PAIR_TTL="${T3_PAIR_TTL:-1h}"
KIT_CFG="$(kit_config_dir)"
STATE_DIR=/var/lib/claude-code-server-kit
APK_DIR=/srv/kit-t3-apk
APK_NAME=T3-Code.apk
SITE_DIR=/etc/caddy/sites-kit
CADDYFILE=/etc/caddy/Caddyfile

# ============================================================
# 0. Что нужно для установки
# ============================================================
ask "Домен для T3 (A-запись на этот сервер), например t3.example.ru" "" T3_DOMAIN || true
ask "Почта для Let's Encrypt" "" ACME_EMAIL || true
ask "Архив сборки T3 (путь или https-ссылка)" "" T3_TARBALL || true
if [ -z "${T3_DOMAIN:-}" ] || [ -z "${ACME_EMAIL:-}" ] || [ -z "${T3_TARBALL:-}" ]; then
  warn "Модуль t3 пропущен: нужны T3_DOMAIN, ACME_EMAIL и T3_TARBALL"
  echo "  Заполните их в secrets.env (см. secrets.example.env) и запустите:"
  echo "    sudo bash install.sh --module t3 --secrets secrets.env"
  exit "$KIT_RC_SKIPPED"
fi
if [ "${KIT_VALIDATED:-0}" != "1" ]; then
  kit_check_t3_settings || exit 1
fi

port_answers() {  # $1 — URL; 0, если отвечает хоть каким-то HTTP-кодом
  local code
  code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$1" 2>/dev/null || true)"
  [ -n "$code" ] && [ "$code" != "000" ]
}

# ============================================================
# 1. Пакеты: qrencode — QR ссылки, ffmpeg — патч 0016 (ужимает картинки для Claude)
# ============================================================
apt_install curl ca-certificates tar qrencode ffmpeg
if [ "${T3_WITH_LIBREOFFICE:-0}" = "1" ]; then
  log "LibreOffice для просмотра .doc/.rtf/.odt (патч 0005), ~500 МБ"
  apt_install libreoffice-writer-nogui libreoffice-calc-nogui
fi

# ============================================================
# 2. t3-update и его настройки
# ============================================================
install -m 755 "$KIT_DIR/tools/t3-update/t3-update" /usr/local/bin/t3-update
ok "t3-update → /usr/local/bin/t3-update"

kit_ensure_config_dir >/dev/null
cat > "$KIT_CFG/t3.env" <<EOF
# Настройки T3 (модуль t3). Читают t3-update и install.sh.
T3_PORT=$T3_PORT
T3_UNIT=$T3_UNIT
T3_DOMAIN=$T3_DOMAIN
EOF
chown "$T3_USER:$T3_GROUP" "$KIT_CFG/t3.env"; chmod 600 "$KIT_CFG/t3.env"

# ============================================================
# 3. Сборка T3 — рядом с прошлыми версиями, ссылка ~/.local/bin/t3
# ============================================================
log "Ставлю сборку T3 из $T3_TARBALL"
SHA_ARGS=()
[ -n "${T3_TARBALL_SHA256:-}" ] && SHA_ARGS=(--sha256 "$T3_TARBALL_SHA256")
# Локальный архив должен быть доступен пользователю среды на чтение
kit_as_user t3-update install "$T3_TARBALL" "${SHA_ARGS[@]}" --no-restart \
  || fatal "Сборка T3 не установилась — см. сообщение выше"
T3_VERSION="$(basename "$(dirname "$(readlink -f "$T3_HOME_DIR/.local/bin/t3")")")"
ok "T3 $T3_VERSION"

# ============================================================
# 4. Токен Claude для службы
# ============================================================
if [ ! -f "$KIT_CFG/claude.env" ]; then
  if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
    kit_install_claude_env
  else
    warn "Нет $KIT_CFG/claude.env — Claude в T3 не ответит, пока нет входа."
    warn "  Либо токен: CLAUDE_CODE_OAUTH_TOKEN в secrets.env → sudo bash install.sh --apply-secrets"
    warn "  Либо вход: claude auth login (под пользователем $T3_USER)"
  fi
fi

# ============================================================
# 5. Служба systemd пользователя + linger (живёт без входа по SSH)
# ============================================================
UNIT_DIR="$T3_HOME_DIR/.config/systemd/user"
kit_user_dir "$T3_HOME_DIR/.config" 700
kit_user_dir "$T3_HOME_DIR/.config/systemd"
kit_user_dir "$UNIT_DIR"
if [ -f "$UNIT_DIR/$T3_UNIT" ] && ! grep -q 'claude-code-server-kit' "$UNIT_DIR/$T3_UNIT"; then
  cp "$UNIT_DIR/$T3_UNIT" "$UNIT_DIR/$T3_UNIT.bak.$(date +%F-%H%M%S)"
  warn "Была своя служба $T3_UNIT — сохранена копия рядом (.bak.*)"
fi
SANDBOX_LINE=""
if [ "$T3_UID" = "0" ]; then
  # Claude Code под root отказывается от --dangerously-skip-permissions (режим «Полный
  # доступ» в T3, он же режим новых тредов) без IS_SANDBOX=1 — треды падают за полсекунды.
  SANDBOX_LINE="Environment=IS_SANDBOX=1"
fi
cat > "$UNIT_DIR/$T3_UNIT" <<EOF
# claude-code-server-kit: T3 Code. Создано setup/modules/t3.sh — повторная установка перезапишет.
[Unit]
Description=T3 Code server (claude-code-server-kit)
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=%h
Environment=T3CODE_HOME=%h/.t3
Environment=PATH=%h/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/bin
$SANDBOX_LINE
# Токен подписки Claude (CLAUDE_CODE_OAUTH_TOKEN). «-» — служба стартует и без файла.
EnvironmentFile=-%h/.config/kit/claude.env
# Только 127.0.0.1: наружу T3 выходит через Caddy с TLS. Вход — по ссылке-приглашению.
ExecStart=%h/.local/bin/t3 serve --host $T3_BIND_HOST --port $T3_PORT --no-browser $T3_WORKDIR
KillMode=mixed
OOMPolicy=continue
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
chown "$T3_USER:$T3_GROUP" "$UNIT_DIR/$T3_UNIT"

loginctl enable-linger "$T3_USER"
systemctl start "user@$T3_UID.service" 2>/dev/null || true
for _ in $(seq 1 20); do [ -S "/run/user/$T3_UID/bus" ] && break; sleep 1; done
[ -S "/run/user/$T3_UID/bus" ] || fatal "Не поднялся systemd --user для $T3_USER (нет /run/user/$T3_UID/bus)"

kit_as_user systemctl --user daemon-reload
kit_as_user systemctl --user enable "$T3_UNIT" >/dev/null
kit_as_user systemctl --user restart "$T3_UNIT"

log "Жду, пока T3 ответит на $T3_BIND_HOST:$T3_PORT…"
T3_UP=0
for _ in $(seq 1 45); do
  sleep 2
  if port_answers "http://127.0.0.1:$T3_PORT/"; then T3_UP=1; break; fi
done
if [ "$T3_UP" != 1 ]; then
  err "T3 не ответил за 90 с. Последние строки журнала:"
  kit_as_user journalctl --user -u "$T3_UNIT" -n 30 --no-pager || true
  exit 1
fi
ok "Служба $T3_UNIT работает (включена, переживает перезагрузку)"

# ============================================================
# 6. APK для Android — раздаётся тем же Caddy по https://<домен>/t3-apk/
# ============================================================
APK_URL=""
if [ -n "${T3_APK:-}" ]; then
  install -d -m 755 "$APK_DIR"
  if [[ "$T3_APK" =~ ^https?:// ]]; then
    if curl -fL --retry 3 -o "$APK_DIR/$APK_NAME.part" "$T3_APK"; then
      mv -f "$APK_DIR/$APK_NAME.part" "$APK_DIR/$APK_NAME"
    else
      rm -f "$APK_DIR/$APK_NAME.part"
      warn "APK не скачался с $T3_APK — приложение возьмите у администратора"
    fi
  elif [ -r "$T3_APK" ]; then
    install -m 644 "$T3_APK" "$APK_DIR/$APK_NAME"
  else
    warn "T3_APK: нет файла $T3_APK"
  fi
  [ -f "$APK_DIR/$APK_NAME" ] && chmod 644 "$APK_DIR/$APK_NAME" && APK_URL="https://$T3_DOMAIN/t3-apk/$APK_NAME"
fi

# ============================================================
# 7. Caddy: TLS на домене + прокси с WebSocket на 127.0.0.1:<порт>
# ============================================================
site_block() {  # $1 — адрес upstream
  echo "# claude-code-server-kit: T3 Code. Создано setup/modules/t3.sh — повторная установка перезапишет."
  echo "$T3_DOMAIN {"
  echo "	tls $ACME_EMAIL"
  if [ -n "$APK_URL" ]; then
    echo "	handle_path /t3-apk/* {"
    echo "		root * $APK_DIR"
    echo "		file_server"
    echo "	}"
  fi
  echo "	handle {"
  echo "		# WebSocket проксируется автоматически. Авторизация — своя у T3 (приглашение),"
  echo "		# basic_auth не ставить: приложение его не проходит."
  echo "		reverse_proxy $1"
  echo "	}"
  echo "}"
}

caddy_mode() {
  local m="${T3_CADDY_MODE:-auto}"
  [ "$m" != "auto" ] && { echo "$m"; return; }
  if systemctl list-unit-files caddy.service --no-legend 2>/dev/null | grep -q '^caddy.service'; then echo system; return; fi
  if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Image}} {{.Names}}' 2>/dev/null | grep -qi caddy; then echo docker; return; fi
  if ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE ':(80|443)$'; then echo other; return; fi
  echo none
}

install_caddy_apt() {
  log "Ставлю Caddy из официального репозитория (cloudsmith)"
  apt_install debian-keyring debian-archive-keyring apt-transport-https gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  apt_install caddy
  FRESH_CADDY=1
}

configure_system_caddy() {
  local backup="" other
  other="$(grep -rlE "(^|[[:space:],])$T3_DOMAIN([[:space:],{:]|$)" /etc/caddy 2>/dev/null | grep -v "^$SITE_DIR/t3.caddy$" || true)"
  if [ -n "$other" ]; then
    err "Домен $T3_DOMAIN уже описан в $other — не трогаю чужую настройку."
    echo "   Уберите его оттуда или проксируйте сами на 127.0.0.1:$T3_PORT." >&2
    return 1
  fi
  install -d -m 755 "$SITE_DIR"
  if [ -f "$CADDYFILE" ]; then
    backup="$CADDYFILE.bak.kit-$(date +%F-%H%M%S)"
    cp "$CADDYFILE" "$backup"
  fi
  if [ "${FRESH_CADDY:-0}" = 1 ] && grep -q '/usr/share/caddy' "$CADDYFILE" 2>/dev/null; then
    # Свежий Caddy со страницей-заглушкой на :80 — заменяем целиком
    printf '# claude-code-server-kit: сайты — в %s/*.caddy\nimport %s/*.caddy\n' "$SITE_DIR" "$SITE_DIR" > "$CADDYFILE"
  elif ! grep -qF "import $SITE_DIR/*.caddy" "$CADDYFILE" 2>/dev/null; then
    printf '\n# claude-code-server-kit\nimport %s/*.caddy\n' "$SITE_DIR" >> "$CADDYFILE"
  fi
  site_block "127.0.0.1:$T3_PORT" > "$SITE_DIR/t3.caddy"

  if ! caddy validate --config "$CADDYFILE" --adapter caddyfile >/tmp/kit-caddy-validate.log 2>&1; then
    err "Caddy не принял настройку — возвращаю как было:"
    tail -5 /tmp/kit-caddy-validate.log >&2
    rm -f "$SITE_DIR/t3.caddy"
    [ -n "$backup" ] && cp "$backup" "$CADDYFILE"
    return 1
  fi
  systemctl enable caddy >/dev/null 2>&1 || true
  if systemctl is-active --quiet caddy; then systemctl reload caddy; else systemctl restart caddy; fi
  ok "Caddy: $T3_DOMAIN → 127.0.0.1:$T3_PORT ($SITE_DIR/t3.caddy)"
  if ufw status 2>/dev/null | grep -q 'Status: active'; then
    ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
    ok "UFW: открыты 80 и 443 (для сертификата и https)"
  fi
}

CADDY_STATUS="ok"
MODE="$(caddy_mode)"
case "$MODE" in
  none)
    install_caddy_apt
    configure_system_caddy || CADDY_STATUS="failed" ;;
  system)
    log "Найден Caddy (systemd) — добавляю сайт к нему"
    command -v caddy >/dev/null 2>&1 || fatal "служба caddy есть, а команды caddy нет"
    configure_system_caddy || CADDY_STATUS="failed" ;;
  docker)
    CADDY_STATUS="manual"
    warn "Caddy работает в Docker — его настройку модуль не трогает. Добавьте сайт сами:"
    echo
    site_block "host.docker.internal:$T3_PORT" | sed 's/^/    /'
    echo
    echo "  Контейнер не видит 127.0.0.1 хоста: поставьте T3_BIND_HOST=0.0.0.0, закройте порт"
    echo "  $T3_PORT снаружи фаерволом (открыт только docker-сетям) и повторите модуль."
    echo "  Контейнеру нужен extra_hosts: [\"host.docker.internal:host-gateway\"]." ;;
  other)
    CADDY_STATUS="manual"
    warn "Порты 80/443 заняты не Caddy (nginx? apache?). Проксируйте $T3_DOMAIN сами на"
    warn "  http://127.0.0.1:$T3_PORT с поддержкой WebSocket (nginx: proxy_http_version 1.1;"
    warn "  proxy_set_header Upgrade \$http_upgrade; proxy_set_header Connection \"upgrade\")." ;;
  skip)
    CADDY_STATUS="manual"
    log "T3_CADDY_MODE=skip — прокси настраиваете сами" ;;
  *) fatal "T3_CADDY_MODE: неизвестное значение $MODE (auto|system|docker|other|skip)" ;;
esac

HTTPS_OK=0
if [ "$CADDY_STATUS" = "ok" ]; then
  log "Жду сертификат и https://$T3_DOMAIN (до 3 минут)…"
  for _ in $(seq 1 60); do
    if port_answers "https://$T3_DOMAIN/"; then HTTPS_OK=1; break; fi
    sleep 3
  done
  if [ "$HTTPS_OK" = 1 ]; then
    ok "https://$T3_DOMAIN открывается"
  else
    warn "https://$T3_DOMAIN пока не открывается. Частые причины: A-запись ещё не обновилась,"
    warn "  закрыты 80/443 у провайдера. Журнал: journalctl -u caddy -n 50"
  fi
fi

# ============================================================
# 8. Ссылка-приглашение + QR
# ============================================================
PAIR_OUT="$(kit_as_user t3 auth pairing create --base-url "https://$T3_DOMAIN" --ttl "$T3_PAIR_TTL" --label kit-install 2>&1 || true)"
PAIR_LINK="$(printf '%s\n' "$PAIR_OUT" | grep -oE 'https://[^[:space:]]+/pair#token=[^[:space:]]+' | head -1 || true)"

install -d -m 755 "$STATE_DIR"
SUMMARY="$STATE_DIR/t3-summary.txt"
: > "$SUMMARY"; chmod 600 "$SUMMARY"
{
  echo "T3_VERSION=$T3_VERSION"
  echo "T3_URL=https://$T3_DOMAIN"
  echo "T3_CADDY=$CADDY_STATUS"
  echo "T3_HTTPS_OK=$HTTPS_OK"
  echo "T3_PAIR_LINK=$PAIR_LINK"
  echo "T3_PAIR_TTL=$T3_PAIR_TTL"
  echo "T3_APK_URL=$APK_URL"
} >> "$SUMMARY"

echo
echo -e "${BOLD}${GREEN}✓ Модуль t3 установлен${NC}  (версия $T3_VERSION, служба $T3_UNIT под $T3_USER)"
echo
if [ -n "$PAIR_LINK" ]; then
  echo "Ссылка-приглашение (действует $T3_PAIR_TTL, одноразовая):"
  echo
  echo -e "   ${BOLD}$PAIR_LINK${NC}"
  echo
  command -v qrencode >/dev/null 2>&1 && qrencode -t ANSIUTF8 "$PAIR_LINK"
else
  warn "Ссылку-приглашение получить не удалось. Вывод t3:"
  printf '%s\n' "$PAIR_OUT" | tail -5
fi
cat <<EOF

Открыть на компьютере — в браузере по ссылке выше. На телефоне:
EOF
if [ -n "$APK_URL" ]; then
  echo "  Android: скачать приложение  $APK_URL"
  command -v qrencode >/dev/null 2>&1 && qrencode -t ANSIUTF8 "$APK_URL"
  echo "  установить, в приложении «Добавить сервер» → вставить ссылку-приглашение."
else
  echo "  Android: APK не задан (T3_APK). Возьмите у администратора или откройте ссылку в браузере телефона."
fi
cat <<EOF
  iPhone: только браузер — ссылка-приглашение, затем «На экран Домой».

Новая ссылка (например, для второго устройства):
  sudo -u $T3_USER -i t3 auth pairing create --base-url https://$T3_DOMAIN --ttl 1h
Обновить T3 новой сборкой:   t3-update <архив или ссылка>   (откат: t3-update rollback)
Состояние:                   t3-update status
EOF
