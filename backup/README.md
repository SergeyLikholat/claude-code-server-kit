# /opt/backup — Backup-инфраструктура

Эта папка — generic-версия backup-системы, разворачивается через `sudo bash install.sh --module backup` из [claude-code-server-kit](https://github.com/SergeyLikholat/claude-code-server-kit).

## Файлы

| Файл | Назначение |
|---|---|
| `scripts/backup.sh` | Главный orchestrator (запускается из systemd timer в 03:00) |
| `scripts/pre-backup.sh` | Дампы БД и tar volumes ДО restic backup |
| `scripts/notify.sh` | Уведомление в TG о результате (если модуль tg-bot установлен) |
| `scripts/restic-env.sh` | env-переменные (RESTIC_REPOSITORY, password file) |
| `config.example.yml` | Шаблон конфига что бэкапить (БД, volumes, custom команды) |
| `includes.template.txt` | Что забираем в restic (адаптируйте под себя в `/opt/backup/includes.txt`) |
| `exclude.txt` | Что НЕ забираем (кэши, логи, ML-модели) |
| `RESTORE.md` | Как восстановиться (точечно или полный DR) |

## Документация

- **Настройка с нуля:** [docs/BACKUP-SETUP.md](../docs/BACKUP-SETUP.md)
- **Восстановление:** [RESTORE.md](RESTORE.md)
- **Архитектура:** [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)

## Как меняется при установке

`setup/modules/backup.sh` копирует эту папку в `/opt/backup/`, подставляет:
- `__BACKUP_TARGET_PATH__` → путь на Я.Диске (по умолчанию `/server-backups/restic-main`)
- Создаёт `/root/.config/rclone/rclone.conf` с OAuth токеном Яндекса
- Создаёт `/root/.secrets/restic-password` (44-символьный шифр-ключ)
- Устанавливает systemd `backup.timer` на 03:00

После установки **адаптируйте `/opt/backup/config.yml`** под ваши контейнеры/volumes. Без него pre-backup делает только дампы файловой системы (без БД).
