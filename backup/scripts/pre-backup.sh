#!/bin/bash
# pre-backup.sh — снимает дампы БД и tar боевых docker-volumes ПЕРЕД restic.
# Конфиг: /opt/backup/config.yml (если нет — просто пропускает БД/volumes).

set -e
LOG="/var/log/backup-pre.log"
BACKUP_DIR="/var/backups"
CONFIG="/opt/backup/config.yml"
DATE=$(date +%F)

mkdir -p "$BACKUP_DIR"/{pg,sqlite,docker-volumes,meta}

log() { echo "[pre-backup $(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

log "==== START ===="

# ============================================================
# Если нет yq — попробуем установить (нужен для парсинга YAML)
# ============================================================
if ! command -v yq >/dev/null 2>&1; then
  log "yq не установлен, ставлю..."
  wget -q https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64 -O /usr/local/bin/yq
  chmod +x /usr/local/bin/yq
fi

# ============================================================
# 1. PostgreSQL дампы
# ============================================================
if [ -f "$CONFIG" ]; then
  count=$(yq '.postgres_containers | length' "$CONFIG" 2>/dev/null || echo 0)
  for ((i=0; i<count; i++)); do
    container=$(yq -r ".postgres_containers[$i].name" "$CONFIG")
    user=$(yq -r ".postgres_containers[$i].user" "$CONFIG")
    output=$(yq -r ".postgres_containers[$i].output_name" "$CONFIG")
    dump_all=$(yq -r ".postgres_containers[$i].dump_all // false" "$CONFIG")
    database=$(yq -r ".postgres_containers[$i].database // \"\"" "$CONFIG")

    if ! docker ps --format '{{.Names}}' | grep -qx "$container"; then
      log "⚠ контейнер $container не запущен — пропускаю"
      continue
    fi

    pw=$(docker exec "$container" printenv POSTGRES_PASSWORD 2>/dev/null)

    if [ "$dump_all" = "true" ]; then
      log "pg: $container — pg_dumpall as $user"
      docker exec -e PGPASSWORD="$pw" "$container" pg_dumpall -U "$user" 2>/dev/null \
        | gzip > "$BACKUP_DIR/pg/${output}_${DATE}.sql.gz"
    else
      log "pg: $container — pg_dump $database as $user"
      docker exec -e PGPASSWORD="$pw" "$container" pg_dump -U "$user" "$database" 2>/dev/null \
        | gzip > "$BACKUP_DIR/pg/${output}_${DATE}.sql.gz"
    fi
    sz=$(stat -c%s "$BACKUP_DIR/pg/${output}_${DATE}.sql.gz")
    if [ "$sz" -lt 1000 ]; then
      log "  ❌ dump подозрительно мал ($sz байт) — проверьте credentials"
    else
      log "  → $(du -h "$BACKUP_DIR/pg/${output}_${DATE}.sql.gz" | cut -f1)"
    fi
  done
else
  log "config.yml не найден — пропускаю PG дампы"
fi

# ============================================================
# 2. SQLite базы
# ============================================================
if [ -f "$CONFIG" ]; then
  count=$(yq '.sqlite_files | length' "$CONFIG" 2>/dev/null || echo 0)
  for ((i=0; i<count; i++)); do
    path=$(yq -r ".sqlite_files[$i].path" "$CONFIG")
    output=$(yq -r ".sqlite_files[$i].output_name" "$CONFIG")
    if [ -f "$path" ]; then
      log "sqlite: $path (online backup)"
      sqlite3 "$path" ".backup '$BACKUP_DIR/sqlite/${output}_${DATE}.db'"
      gzip -f "$BACKUP_DIR/sqlite/${output}_${DATE}.db"
      log "  → $(du -h "$BACKUP_DIR/sqlite/${output}_${DATE}.db.gz" | cut -f1)"
    fi
  done
fi

# ============================================================
# 3. Docker volumes
# ============================================================
if [ -f "$CONFIG" ]; then
  count=$(yq '.docker_volumes | length' "$CONFIG" 2>/dev/null || echo 0)
  for ((i=0; i<count; i++)); do
    vol=$(yq -r ".docker_volumes[$i].name" "$CONFIG")
    if docker volume inspect "$vol" >/dev/null 2>&1; then
      log "volume: $vol"
      docker run --rm \
        -v "$vol":/data:ro \
        -v "$BACKUP_DIR/docker-volumes":/backup \
        alpine:3.20 \
        tar czf "/backup/${vol}_${DATE}.tar.gz" -C /data . 2>/dev/null
      log "  → $(du -h "$BACKUP_DIR/docker-volumes/${vol}_${DATE}.tar.gz" | cut -f1)"
    fi
  done
fi

# ============================================================
# 4. Произвольные pre-backup команды
# ============================================================
if [ -f "$CONFIG" ]; then
  count=$(yq '.pre_backup_commands | length' "$CONFIG" 2>/dev/null || echo 0)
  for ((i=0; i<count; i++)); do
    desc=$(yq -r ".pre_backup_commands[$i].description" "$CONFIG")
    cmd=$(yq -r ".pre_backup_commands[$i].command" "$CONFIG")
    log "cmd: $desc"
    eval "$cmd" 2>&1 | tee -a "$LOG" || log "  ⚠ команда вернула ошибку"
  done
fi

# ============================================================
# 5. Метаданные (всегда)
# ============================================================
log "meta: crontab, docker ps, ufw, systemd"
crontab -l > "$BACKUP_DIR/meta/crontab_${DATE}.txt" 2>/dev/null || echo "(no crontab)" > "$BACKUP_DIR/meta/crontab_${DATE}.txt"
docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' > "$BACKUP_DIR/meta/docker-ps_${DATE}.txt" 2>/dev/null || true
docker volume ls > "$BACKUP_DIR/meta/docker-volumes_${DATE}.txt" 2>/dev/null || true
ufw status verbose > "$BACKUP_DIR/meta/ufw_${DATE}.txt" 2>/dev/null || true
systemctl list-unit-files --state=enabled --no-pager > "$BACKUP_DIR/meta/systemd-enabled_${DATE}.txt" 2>/dev/null || true

# ============================================================
# 6. Очистка старых дампов (старше 7 дней)
# ============================================================
find "$BACKUP_DIR" -type f -mtime +7 \( -name "*.gz" -o -name "*.txt" -o -name "*.json" \) -delete 2>/dev/null || true

TOTAL=$(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1)
log "==== DONE: $BACKUP_DIR теперь $TOTAL ===="
