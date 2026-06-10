#!/bin/bash
# Модуль backup: автоматический шифрованный бэкап через restic + rclone
# на выбранный backend (Yandex.Disk / Google Drive / любой rclone remote).
#
# Использование:
#   sudo bash install.sh --module backup                          # дефолт: Yandex.Disk
#   sudo bash install.sh --module backup -- --backend gdrive      # Google Drive
#   sudo bash install.sh --module backup -- --backend custom --remote NAME
set -e
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

BACKEND="yandex"
CUSTOM_REMOTE=""
for arg in "$@"; do
  case "$arg" in
    --backend=*) BACKEND="${arg#*=}" ;;
    --backend)   shift; BACKEND="${1:-yandex}" ;;
    --remote=*)  CUSTOM_REMOTE="${arg#*=}" ;;
    --remote)    shift; CUSTOM_REMOTE="${1:-}" ;;
  esac
done

log "Установка модуля: backup (backend: $BACKEND)"

# ============================================================
# 1. Установка restic + rclone
# ============================================================
apt_install restic rclone

# ============================================================
# 2. Backend-specific: выбираем rclone remote
# ============================================================
RCLONE_REMOTE=""
case "$BACKEND" in
  yandex)
    RCLONE_REMOTE="yadisk"
    ;;
  gdrive)
    RCLONE_REMOTE="gdrive"
    if ! rclone listremotes 2>/dev/null | grep -q "^gdrive:$"; then
      cat <<EOF

▸ Для Google Drive нужно один раз настроить rclone-remote с именем "gdrive".
   Самый простой способ — авторизоваться на машине С браузером:

     1. Установите rclone локально (https://rclone.org/install/)
     2. Локально: rclone authorize "drive"
        → откроется браузер, войдите в Google, нажмите "Разрешить"
        → скопируйте JSON-токен (одна длинная строка)
     3. На сервере: запустите 'rclone config' и создайте remote:
        n) New remote → name: gdrive → storage: drive
        scope: 1 (full access) → root_folder_id/service_account: пусто
        Use auto config: n → вставьте JSON-токен → y (advanced: n) → q (quit)
     4. Перезапустите этот модуль.

EOF
      fatal "rclone remote 'gdrive' не настроен — см. инструкцию выше"
    fi
    ;;
  custom)
    [ -z "$CUSTOM_REMOTE" ] && fatal "С --backend custom нужен --remote NAME"
    RCLONE_REMOTE="$CUSTOM_REMOTE"
    if ! rclone listremotes 2>/dev/null | grep -q "^${RCLONE_REMOTE}:$"; then
      fatal "rclone remote '$RCLONE_REMOTE' не настроен. Запустите 'rclone config'."
    fi
    ;;
  *)
    fatal "Неизвестный backend: $BACKEND (доступно: yandex, gdrive, custom)"
    ;;
esac

# Не-yandex бэкенды используют существующий rclone remote и пропускают OAuth-блок
if [ "$BACKEND" != "yandex" ]; then
  ask "Папка в $BACKEND для бэкапа" "/server-backups/restic-main" BACKUP_TARGET_PATH
  ok "Использую rclone remote: $RCLONE_REMOTE"
  # Прыгаем сразу к restic-инициализации (блок 5+ ниже).
  SKIP_YANDEX_OAUTH=1
fi

if [ "${SKIP_YANDEX_OAUTH:-0}" != "1" ]; then

# ============================================================
# 2y. Yandex OAuth flow (только для backend=yandex)
# ============================================================
ask "Yandex OAuth Client ID (см. docs/BACKUP-SETUP.md)" "" YANDEX_CLIENT_ID
if [ -z "$YANDEX_CLIENT_ID" ]; then
  warn "Client ID не указан — модуль пропущен"
  echo
  echo "Как получить:"
  echo "  1. https://oauth.yandex.com/client/new"
  echo "  2. Название: server-backup-restic"
  echo "  3. Platforms: Web services, redirect URI: https://oauth.yandex.ru/verification_code"
  echo "  4. Data access: cloud_api:disk.* (4 пункта)"
  echo "  5. Запустите снова: YANDEX_CLIENT_ID=... YANDEX_CLIENT_SECRET=... sudo bash install.sh --module backup"
  exit 0
fi

ask_secret "Yandex Client Secret" YANDEX_CLIENT_SECRET
[ -z "$YANDEX_CLIENT_SECRET" ] && { err "Client Secret обязателен"; exit 1; }

ask "Папка на Я.Диске для бэкапа" "/server-backups/restic-main" BACKUP_TARGET_PATH

# OAuth code (одноразовый, через браузер)
cat <<EOF

▸ OAuth flow:
   Откройте в браузере (на любом устройстве):

   ${BOLD}https://oauth.yandex.ru/authorize?response_type=code&client_id=${YANDEX_CLIENT_ID}${NC}

   Войдите в Яндекс → "Разрешить" (предупреждение Untrusted service — нормально)
   Со страницы verification_code скопируйте code (16 символов).

EOF
ask "Yandex authorization code" "" YANDEX_AUTH_CODE
[ -z "$YANDEX_AUTH_CODE" ] && { err "Auth code обязателен"; exit 1; }

# ============================================================
# 3. Обмен code → tokens
# ============================================================
log "Обмениваю код на access+refresh tokens..."
TOKEN_RESPONSE=$(curl -sS -X POST https://oauth.yandex.ru/token \
  -d "grant_type=authorization_code" \
  -d "code=${YANDEX_AUTH_CODE}" \
  -d "client_id=${YANDEX_CLIENT_ID}" \
  -d "client_secret=${YANDEX_CLIENT_SECRET}")

if echo "$TOKEN_RESPONSE" | grep -q '"error"'; then
  err "Ошибка OAuth: $TOKEN_RESPONSE"
  exit 1
fi

# ============================================================
# 4. rclone config
# ============================================================
ensure_dir /root/.config/rclone 700
echo "$TOKEN_RESPONSE" | python3 -c "
import json, sys, datetime, os
r = json.loads(sys.stdin.read())
expiry = datetime.datetime.utcnow() + datetime.timedelta(seconds=r['expires_in'] - 60)
token = json.dumps({
    'access_token': r['access_token'],
    'token_type': r['token_type'],
    'refresh_token': r['refresh_token'],
    'expiry': expiry.strftime('%Y-%m-%dT%H:%M:%S.000000000Z')
}, separators=(',', ':'))
conf = f'''[yadisk]
type = yandex
client_id = ${YANDEX_CLIENT_ID}
client_secret = ${YANDEX_CLIENT_SECRET}
token = {token}
'''
with open('/root/.config/rclone/rclone.conf', 'w') as f:
    f.write(conf)
os.chmod('/root/.config/rclone/rclone.conf', 0o600)
"
ok "rclone.conf создан"

fi  # end SKIP_YANDEX_OAUTH

# Проверка доступа (для любого backend)
if rclone lsd "${RCLONE_REMOTE}:" >/dev/null 2>&1; then
  ok "Backend $BACKEND ($RCLONE_REMOTE) доступен"
else
  err "Не удалось подключиться к ${RCLONE_REMOTE}: (проверьте rclone config)"
  exit 1
fi

# Создать target папку
rclone mkdir "${RCLONE_REMOTE}:${BACKUP_TARGET_PATH#/}" 2>/dev/null || true

# ============================================================
# 5. Restic password
# ============================================================
ensure_dir /root/.secrets 700
if [ -f /root/.secrets/restic-password ]; then
  ok "Restic-пароль уже существует (используем существующий)"
else
  if [ -n "${BACKUP_RESTIC_PASSWORD:-}" ]; then
    echo -n "$BACKUP_RESTIC_PASSWORD" > /root/.secrets/restic-password
  else
    log "Генерирую restic-пароль..."
    openssl rand -base64 32 > /root/.secrets/restic-password
  fi
  chmod 600 /root/.secrets/restic-password

  cat <<EOF

${BOLD}${YELLOW}════════════════════════════════════════════════════════════════${NC}
${BOLD}${YELLOW}  ⚠ ВАЖНО: СОХРАНИТЕ ЭТОТ ПАРОЛЬ ПРЯМО СЕЙЧАС                    ${NC}
${BOLD}${YELLOW}════════════════════════════════════════════════════════════════${NC}

Restic-пароль (показывается ОДИН раз):

   $(cat /root/.secrets/restic-password)

Положите его:
  1. В Bitwarden / 1Password
  2. Распечатайте на бумаге → в физический сейф

Без этого пароля зашифрованный бэкап = непрочитаемая каша.
restic НЕ имеет recovery-механизма (это часть его безопасности).

EOF
  if [ -t 0 ]; then
    read -rp "Сохранили? Введите 'yes' для продолжения: " saved
    [ "$saved" = "yes" ] || { err "Прерывание. Перезапустите после сохранения."; exit 1; }
  fi
fi

# ============================================================
# 6. Развернуть backup-инфраструктуру в /opt/backup
# ============================================================
log "Устанавливаю backup-инфраструктуру в /opt/backup/"
ensure_dir /opt/backup 755
cp -r "$KIT_DIR/backup/"* /opt/backup/

# Подставляем путь и remote в env-скрипт
sed -i \
  -e "s|__BACKUP_TARGET_PATH__|${BACKUP_TARGET_PATH#/}|g" \
  -e "s|__RCLONE_REMOTE__|${RCLONE_REMOTE}|g" \
  /opt/backup/scripts/restic-env.sh
chmod +x /opt/backup/scripts/*.sh

# ============================================================
# 7. Restic init (или skip если уже инициализирован)
# ============================================================
export RESTIC_REPOSITORY="rclone:${RCLONE_REMOTE}:${BACKUP_TARGET_PATH#/}"
export RESTIC_PASSWORD_FILE="/root/.secrets/restic-password"

if restic snapshots >/dev/null 2>&1; then
  ok "Repo уже инициализирован, использую существующий"
else
  log "Инициализирую restic репозиторий..."
  restic init
fi

# ============================================================
# 8. Systemd timer
# ============================================================
install_systemd_unit "backup" \
  "$KIT_DIR/systemd/backup.service.template" \
  "BACKUP_SCRIPT=/opt/backup/scripts/backup.sh"

# Timer
cp "$KIT_DIR/systemd/backup.timer.template" /etc/systemd/system/backup.timer
systemctl daemon-reload
systemctl enable backup.timer

# Stamp чтобы Persistent=true не сработал catch-up на старте
mkdir -p /var/lib/systemd/timers
touch /var/lib/systemd/timers/stamp-backup.timer

systemctl start backup.timer

# ============================================================
# 9. Финал
# ============================================================
cat <<EOF

${BOLD}${GREEN}✓ Модуль backup установлен${NC}

Что готово:
  • restic + rclone настроены
  • Я.Диск подключён (refresh_token живёт год+)
  • Шифрование AES-256 (пароль в /root/.secrets/restic-password)
  • Ежедневный cron в 03:00 (через systemd backup.timer)
  • Retention: 7 daily + 4 weekly + 6 monthly

ВАЖНО:
  ⚠ Сохраните restic-пароль (показан выше) в Bitwarden + бумаге
  ⚠ Сохраните Yandex client_id и client_secret в Bitwarden
  ⚠ Прочитайте /opt/backup/RESTORE.md для disaster recovery

Команды:
  sudo bash /opt/backup/scripts/backup.sh    — запустить вручную
  restic snapshots                            — список снимков
  systemctl status backup.timer               — статус расписания

Следующий запуск: $(systemctl list-timers backup.timer --no-pager 2>/dev/null | sed -n 2p | awk '{print $1, $2, $3}')

EOF
