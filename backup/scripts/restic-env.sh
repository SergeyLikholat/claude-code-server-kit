# Source from other backup scripts:  source /opt/backup/scripts/restic-env.sh
export RESTIC_REPOSITORY="rclone:__RCLONE_REMOTE__:__BACKUP_TARGET_PATH__"
export RESTIC_PASSWORD_FILE="/root/.secrets/restic-password"
export RESTIC_CACHE_DIR="/var/cache/restic"
# Тюнинг rclone (предотвращает rate-limit на Я.Диске; для других бэкендов
# можно ослабить — gdrive выдерживает до 10 параллельных загрузок).
export RCLONE_TRANSFERS=4
export RCLONE_TPSLIMIT=8
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
