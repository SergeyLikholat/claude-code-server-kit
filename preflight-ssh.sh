#!/bin/bash
# preflight-ssh.sh — настройка безопасного входа на сервер по SSH-ключам.
#
# ЗАПУСКАТЬ НА СЕРВЕРЕ, после того как УЖЕ скопировали публичный ключ в ~/.ssh/authorized_keys.
# Скрипт проверит что вход по ключу работает, и только тогда отключит вход по паролю.
#
# Использование:
#   curl -fsSL https://raw.githubusercontent.com/SergeyLikholat/claude-code-server-kit/main/preflight-ssh.sh | bash
#   ИЛИ
#   sudo bash preflight-ssh.sh

set -e

# Цвета
GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
err()  { echo -e "${RED}✗${NC} $*" >&2; }
ask()  { echo -en "${CYAN}?${NC} $*"; }

if [ "$EUID" -ne 0 ]; then
  err "Запускайте через sudo: sudo bash $0"
  exit 1
fi

cat <<EOF

${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}
${BOLD}║  SSH Preflight — настройка безопасности сервера              ║${NC}
${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}

Этот скрипт сделает ваш сервер безопаснее:
  1. Проверит что вы УЖЕ настроили вход по SSH-ключам
  2. Отключит вход по паролю (опасный способ)
  3. Опционально поменяет порт SSH на нестандартный
  4. Опционально установит fail2ban (блокирует ботов которые перебирают пароли)

⚠️  ВАЖНО: НЕ запускайте этот скрипт пока не убедитесь что вход по ключу работает!
   Иначе можете потерять доступ к серверу. Способ восстановления —
   только через консоль провайдера (KVM/Rescue mode).

EOF

ask "Готовы продолжить? (Подтверждение что вход по ключу уже работает) [y/N]: "
read -r confirm
[[ "$confirm" =~ ^[YyДд]$ ]] || { echo "Отмена."; exit 0; }

# ============================================================
# 1. Проверка что есть authorized_keys
# ============================================================
echo
echo "▸ Проверка наличия SSH-ключей..."

AUTH_KEYS="/root/.ssh/authorized_keys"
if [ ! -f "$AUTH_KEYS" ] || [ ! -s "$AUTH_KEYS" ]; then
  err "Файл $AUTH_KEYS не существует или пустой."
  echo
  echo "Сначала добавьте ваш публичный SSH-ключ:"
  echo "  1. На своём компьютере: ssh-keygen -t ed25519 (если ключа нет)"
  echo "  2. Скопируйте на сервер: ssh-copy-id root@$(hostname -I | awk '{print $1}')"
  echo "  3. Проверьте что заходит БЕЗ пароля"
  echo "  4. Только потом запускайте этот скрипт"
  echo
  echo "Подробная инструкция: https://github.com/SergeyLikholat/claude-code-server-kit/blob/main/docs/SSH-SETUP.md"
  exit 1
fi

KEY_COUNT=$(grep -cE '^(ssh-rsa|ssh-ed25519|ecdsa-sha2|ssh-dss)' "$AUTH_KEYS" || echo 0)
ok "Найдено ключей в authorized_keys: $KEY_COUNT"

if [ "$KEY_COUNT" -lt 1 ]; then
  err "В authorized_keys нет валидных ключей"
  exit 1
fi

# Права
chmod 700 /root/.ssh
chmod 600 "$AUTH_KEYS"
ok "Права на ~/.ssh выставлены правильно"

# ============================================================
# 2. ПРЕДУПРЕЖДЕНИЕ перед отключением пароля
# ============================================================
echo
echo "▸ Подтверждение перед опасным шагом..."
echo
warn "Сейчас будет отключён вход по паролю."
warn "Если ключ НЕ работает — вы потеряете доступ к серверу."
echo
echo "Откройте НОВУЮ вкладку терминала и попробуйте подключиться по SSH БЕЗ пароля."
echo "Если зашло без запроса пароля — ключ работает, продолжайте."
echo "Если запросило пароль — НЕ продолжайте, иначе закроете себе доступ."
echo
ask "Ключ работает без пароля? [yes/no]: "
read -r works
if [ "$works" != "yes" ]; then
  echo "Отмена. Настройте ключи и попробуйте снова."
  exit 0
fi

# ============================================================
# 3. Отключение PasswordAuthentication
# ============================================================
echo
echo "▸ Отключаю вход по паролю в /etc/ssh/sshd_config..."

SSHD_CONFIG="/etc/ssh/sshd_config"
cp "$SSHD_CONFIG" "${SSHD_CONFIG}.backup.$(date +%F-%H%M%S)"

# Обновляем настройки (создаём drop-in вместо правки основного файла — надёжнее)
mkdir -p /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/99-claude-code-kit-hardening.conf <<EOF
# Установлено claude-code-server-kit/preflight-ssh.sh $(date)
PasswordAuthentication no
PermitEmptyPasswords no
ChallengeResponseAuthentication no
KbdInteractiveAuthentication no
UsePAM yes
PubkeyAuthentication yes
PermitRootLogin prohibit-password
EOF

# Проверка конфига
if ! sshd -t 2>/dev/null; then
  err "Ошибка в конфиге sshd! Откатываю изменения."
  rm /etc/ssh/sshd_config.d/99-claude-code-kit-hardening.conf
  exit 1
fi

systemctl reload sshd 2>/dev/null || systemctl reload ssh 2>/dev/null
ok "Вход по паролю отключён. Только ключи."

# ============================================================
# 4. Опционально: смена порта SSH
# ============================================================
echo
echo "▸ Смена порта SSH (опционально)..."
echo
echo "По умолчанию SSH работает на порту 22. Боты в интернете постоянно сканируют 22."
echo "Смена на нестандартный порт (например 2222) уменьшает количество попыток взлома."
echo
ask "Поменять порт SSH? [y/N]: "
read -r change_port
if [[ "$change_port" =~ ^[YyДд]$ ]]; then
  ask "Новый порт (1024-65535, по умолчанию 2222): "
  read -r new_port
  new_port="${new_port:-2222}"

  if ! [[ "$new_port" =~ ^[0-9]+$ ]] || [ "$new_port" -lt 1024 ] || [ "$new_port" -gt 65535 ]; then
    err "Неверный порт. Пропускаю смену."
  else
    # Сначала открыть новый порт
    if command -v ufw >/dev/null; then
      ufw allow "$new_port/tcp" 2>&1 | tail -1
    fi

    echo "Port $new_port" >> /etc/ssh/sshd_config.d/99-claude-code-kit-hardening.conf

    if sshd -t 2>/dev/null; then
      systemctl restart sshd 2>/dev/null || systemctl restart ssh 2>/dev/null
      ok "SSH теперь на порту $new_port"
      echo
      warn "ВАЖНО: переподключитесь к серверу с указанием нового порта:"
      echo "      ssh -p $new_port root@$(hostname -I | awk '{print $1}')"
      echo
      echo "После проверки что новый порт работает, можно закрыть старый 22:"
      echo "      ufw delete allow 22/tcp"
    else
      err "Ошибка в конфиге. Откатываю."
      sed -i "/^Port $new_port/d" /etc/ssh/sshd_config.d/99-claude-code-kit-hardening.conf
    fi
  fi
fi

# ============================================================
# 5. Firewall (ufw)
# ============================================================
echo
echo "▸ Firewall..."
if command -v ufw >/dev/null; then
  if ufw status | grep -q "Status: active"; then
    ok "ufw уже активен"
  else
    ask "Включить ufw firewall? (откроет 22, 80, 443) [Y/n]: "
    read -r enable_ufw
    if [[ ! "$enable_ufw" =~ ^[Nn]$ ]]; then
      ufw allow OpenSSH 2>&1 | tail -1
      ufw allow 80/tcp 2>&1 | tail -1
      ufw allow 443/tcp 2>&1 | tail -1
      ufw --force enable
      ok "ufw активен"
    fi
  fi
else
  warn "ufw не установлен, ставлю..."
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ufw
  ufw allow OpenSSH
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw --force enable
  ok "ufw установлен и активен"
fi

# ============================================================
# 6. Опционально: fail2ban
# ============================================================
echo
echo "▸ Fail2ban (защита от перебора паролей)..."
ask "Установить fail2ban? Он будет блокировать IP с которых пытаются взломать [Y/n]: "
read -r install_f2b
if [[ ! "$install_f2b" =~ ^[Nn]$ ]]; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq fail2ban
  # Базовая конфигурация для SSH
  cat > /etc/fail2ban/jail.d/sshd.local <<EOF
[sshd]
enabled = true
maxretry = 3
bantime = 3600
findtime = 600
EOF
  systemctl enable --now fail2ban
  ok "fail2ban установлен. Проверка: fail2ban-client status sshd"
fi

# ============================================================
# Итог
# ============================================================
cat <<EOF

${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}
${BOLD}║  ✓ SSH preflight завершён                                    ║${NC}
${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}

Что сделано:
  ✓ Вход по паролю отключён (только ключи)
  ✓ Firewall активен (открыты 22, 80, 443)
EOF

[ "$change_port" = "y" ] && echo "  ✓ SSH перенесён на порт $new_port"
[[ ! "$install_f2b" =~ ^[Nn]$ ]] && echo "  ✓ fail2ban защищает от перебора"

cat <<EOF

${BOLD}Дальше:${NC}
  Установка Claude Code инфраструктуры:
    cd /root
    git clone https://github.com/SergeyLikholat/claude-code-server-kit
    cd claude-code-server-kit
    sudo bash install.sh

⚠️  Если что-то сломалось и не можете войти — используйте консоль провайдера
    (KVM/VNC/Rescue mode), восстановите /etc/ssh/sshd_config из бэкапа:
    ls /etc/ssh/sshd_config.backup.*

EOF
