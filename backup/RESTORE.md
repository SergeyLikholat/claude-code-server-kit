# 🚨 RESTORE — восстановление из бэкапа

> Для модуля `backup` из [claude-code-server-kit](https://github.com/SergeyLikholat/cc-multiuser-kit).
> Это generic-инструкция. Если у вас есть **свой** boevoy runbook — он приоритетнее.

---

## Два сценария

### Сценарий A — частичный откат (сервер жив)

«Случайно удалил важный файл вчера». Восстанавливаем точечно.

```bash
export RESTIC_REPOSITORY="rclone:yadisk:..."   # из /opt/backup/scripts/restic-env.sh
export RESTIC_PASSWORD_FILE="/root/.secrets/restic-password"

# Посмотреть доступные снапшоты
restic snapshots --tag nightly

# Восстановить latest в /tmp/restore (для проверки)
restic restore latest --target /tmp/restore/

# Или восстановить конкретный путь
restic restore latest --target /tmp/restore/ --include /root/projects/myproject
```

### Сценарий B — полный disaster recovery (новый сервер с нуля)

Сервер потерян. У вас на руках только Bitwarden с паролями + этот документ.

**Шаг 1: подготовить новый VPS.** Следуйте основной инструкции kit'а — [SETUP](../docs/GETTING-STARTED.md) на чистом Ubuntu 24.04. До модуля `backup` дойти не успеете — установите только core.

**Шаг 2: восстановить доступ к Я.Диску.**

```bash
# Восстановите restic-пароль из Bitwarden:
mkdir -p /root/.secrets
echo "ВАШ_RESTIC_ПАРОЛЬ_ИЗ_BITWARDEN" > /root/.secrets/restic-password
chmod 600 /root/.secrets/restic-password

# Восстановите rclone OAuth (нужны client_id/secret из Bitwarden):
# 1. Открыть в браузере:
#    https://oauth.yandex.ru/authorize?response_type=code&client_id=ВАШ_CLIENT_ID
# 2. Получить authorization code (16 символов)
# 3. Обменять на tokens:
curl -X POST https://oauth.yandex.ru/token \
  -d "grant_type=authorization_code" \
  -d "code=ВАШ_CODE" \
  -d "client_id=ВАШ_CLIENT_ID" \
  -d "client_secret=ВАШ_CLIENT_SECRET"

# 4. Создать /root/.config/rclone/rclone.conf вручную или через:
sudo bash install.sh --module backup
```

**Шаг 3: restic restore latest.**

```bash
apt install -y restic rclone tmux
tmux new -s restore   # длительная операция, не оборвётся при SSH disconnect
export RESTIC_REPOSITORY="rclone:yadisk:/server-backups/restic-main"
export RESTIC_PASSWORD_FILE="/root/.secrets/restic-password"
restic restore latest --target /
# Ctrl+b d — отключиться от tmux
# tmux attach -t restore — вернуться
```

Будет долго (3 ГБ ≈ 30-60 минут с Я.Диска).

**Шаг 4: восстановить БД из дампов.**

```bash
# Для каждой PG-БД (если у вас есть docker контейнеры PG):
PASS=$(docker exec НАЗВАНИЕ_КОНТЕЙНЕРА printenv POSTGRES_PASSWORD)
gunzip -c /var/backups/pg/ИМЯ_*.sql.gz \
  | docker exec -i -e PGPASSWORD="$PASS" НАЗВАНИЕ_КОНТЕЙНЕРА psql -U ЮЗЕР ИМЯ_БД
```

**Шаг 5: восстановить Docker volumes.**

```bash
for TAR in /var/backups/docker-volumes/*.tar.gz; do
  VOL=$(basename "$TAR" | sed -E 's/_[0-9-]{10}\.tar\.gz$//')
  docker volume create "$VOL"
  docker run --rm \
    -v "$VOL":/data \
    -v /var/backups/docker-volumes:/backup:ro \
    alpine:3.20 \
    sh -c "cd /data && tar xzf /backup/$(basename "$TAR")"
done
```

**Шаг 6: восстановить SQLite.**

```bash
# Для каждой SQLite-БД:
gunzip -c /var/backups/sqlite/ИМЯ_*.db.gz > /ОРИГИНАЛЬНЫЙ_ПУТЬ.db
```

**Шаг 7: поднять сервисы.**

```bash
# Docker compose сервисы — каждый в своей папке:
cd /root/projects/my-service && docker compose up -d

# Systemd сервисы:
systemctl daemon-reload
systemctl enable --now ИМЯ.service

# Cron:
crontab /var/backups/meta/crontab_*.txt
```

**Шаг 8: дымовая проверка.** См. [TROUBLESHOOTING.md](../docs/TROUBLESHOOTING.md).

---

## Известные ловушки

### «PostgreSQL не принимает дамп» — версия PG

Мы делаем **логические** дампы через `pg_dump` (plain SQL). Они портабельны между мажорными версиями. **Сырые** `data` directories (`/var/lib/postgresql/data/`) — НЕ переносимы, и мы их НЕ бэкапим.

### «n8n credentials мёртвые» — потерян N8N_ENCRYPTION_KEY

Credentials в БД зашифрованы этим ключом. Восстановили БД, но `.env` с ключом не восстановили → credentials превратились в кашу.

**Решение:** убедитесь что `/root/n8n-install/.env` или другой env с `N8N_ENCRYPTION_KEY` — попал в restic_restore до того как n8n стартовал. Если потеряли — credentials придётся вводить заново.

### Аналогично для других сервисов:

- **Plane:** `SECRET_KEY` → сессии/JWT
- **plane-gcal-sync:** `TOKEN_ENCRYPTION_KEY` → Google OAuth
- **Supabase:** `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `VAULT_ENC_KEY`

### «Telethon просит SMS-код» — volume не восстановился

Перед `docker compose up -d telethon-service` убедитесь что `localai_telethon_session` volume restored.

### «Я.Диск качает медленно»

Это нормально (1-5 МБ/с для бесплатных аккаунтов). Запускайте restore в `tmux`.

---

## ⚠️ Тренировка восстановления (обязательно)

DR-план без тренировки = шрёдингеровский: жив пока не проверил.

**Раз в квартал:**
1. Hetzner CPX21 на час = €0.05
2. Пройти этот RESTORE полностью на чистом VPS
3. На каждой проблеме — улучшить runbook (PR в kit)
4. Удалить тестовый VPS

Если ни разу не тренировались — считайте что DR-плана нет.
