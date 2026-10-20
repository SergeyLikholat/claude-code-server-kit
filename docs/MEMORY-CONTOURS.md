# Контуры памяти на сервере: владелец и чужие

**Обновлено:** 2026-07-30

Один сервер, один аккаунт Claude, одно физическое хранилище сессий — но три независимых
контура памяти: владелец, user2 (`user2`), user3 (`user3`).
Все различия задаются переменными окружения; движки памяти общие и не содержат
захардкоженных путей ни одного контура.

## Слои памяти — паритет контуров

| Слой | Движок | Владелец | Чужие контуры |
|---|---|---|---|
| Сырьё из JSONL сессий | `digest-jsonl.js` | 02:30 (свой cron) | 02:40 / 09:45 (`other-memory-cron.sh`) |
| Сводка нативной auto-memory | `aggregate-slug-memory.js` | не нужна — почти все сессии в одном слаге `-root` | ✅ сводит слаги топиков в `<контур>/memory/MEMORY.md` |
| Классификация «бездомных» фактов | `classify-homeless.js` | ✅ | не подключена осознанно (см. ниже) |
| Шарды тем → `_index.md` → путеводитель | `memory-index-builder.js` | 02:45 / 09:00 / 16:00 | внутри `other-memory-cron.sh` |
| Граф сущностей | `entity-builder.js` | `entity-cron.sh` → `_wiki/entities/` | внутри `other-memory-cron.sh` → `<контур>/memory/entities/` |
| Волт в авто-извлечении | хук `memory-retrieval.js` | `/root/Obsidian/_wiki` (215 файлов) | `MEMKIT_OBSIDIAN_WIKI` → `obsidian/_people` + `obsidian/projects` |
| Зеркало памяти в волт | `mirror-memory-to-vault.js` | 03:05 / 10:00 | не нужно — их волт наполняет `context-mgr` |
| Инжект путеводителя в сессию | хук `session-start-memory-index.js` | ✅ | ✅ |
| Извлечение по запросу | хук `memory-retrieval.js` | ✅ | ✅ |

## Переменные, разводящие контуры

| Переменная | Смысл |
|---|---|
| `MEMKIT_ROOT_MEM` | корень памяти контура |
| `MEMKIT_PROJECTS_DIR` | где искать подпроекты с `memory/` (у чужих — пустышка `.noprojects`) |
| `MEMKIT_OBSIDIAN_DIR` | волт контура; **пустая строка допустима**, но см. предупреждение ниже |
| `MEMKIT_OBSIDIAN_WIKI` | CSV каталогов волта для индексации (если слоя `_wiki` нет) |
| `MEMKIT_OBSIDIAN_SKIP` | имена подкаталогов-исключений (у user2 `digests` — 283 файла сырья) |
| `MEMKIT_OWNER_LABEL` | подпись владельца, винительный падеж («user2») |
| `MEMKIT_SLUG_PREFIX` | префикс слагов сессий контура — граница для агрегатора |
| `MEMKIT_ROOT_TITLE` / `MEMKIT_ROOT_HINT` | как назвать и описать корневой контур в путеводителе |

Подпись владельца берётся из `<контур>/memory/.owner-label`, префикс слагов вычисляется из
пути контура (`/root/projects_other/X` → `-root-projects-other-X`).

## Защиты от смешивания

- `aggregate-slug-memory.js` **отказывается работать** без `MEMKIT_SLUG_PREFIX` и при префиксе
  `-root` / `-root-projects`: иначе один запуск переписал бы `MEMORY.md` владельца чужими фактами.
- `other-memory-cron.sh` имеет собственные lock, sentinel и журнал — прогон чужих контуров
  физически не может занять или сбросить sentinel владельца (`.entity.lastrun`, `.memory-index.lastrun`).
- Хуки при заданном `MEMKIT_ROOT_MEM` читают ТОЛЬКО память своего контура (`SCOPED`).
- Путеводитель чужого контура не содержит ссылок на память и волт владельца.

## Известные грабли

1. **`MEMKIT_OBSIDIAN_DIR=''` в роутере.** Исправлено, но помнить: до правки 2026-07-30
   пустая строка приводила к `path.join(null,…)` → TypeError → fail-safe → хук молча
   отдавал **пустую** память. Контуры user2 и user3 жили без авто-извлечения.
2. **Нативная auto-memory не переопределяется.** Каталог выводится из `cwd` сессии, env нет.
   Поэтому у контура с несколькими топиками факты расползаются по слагам — лечится только
   агрегатором. Проверять после добавления новых топиков.
3. **`classify-homeless.js` жёстко привязан к путям владельца** (`/root/projects`,
   `-root/memory/activity/daily.md`). Для чужих контуров не подключён намеренно: их буфер
   и так один, а дробление на поддомены дало бы ночную трату лимита при близком к нулю
   выигрыше. Если у контура появятся подпроекты со своими `memory/` — параметризовать.
4. **ECC-плагин возвращает удалённое.** `rules/zh` (5 700 токенов дубликата на каждое
   сообщение) удалён 2026-07-30; `ecc install --profile full` вернёт его обратно.

## Проверки

```bash
# память контура отдаётся и включает волт
echo '{"prompt":"ферритин железо","cwd":"/root/projects_other/user2/hub","hook_event_name":"UserPromptSubmit"}' \
 | env MEMKIT_ROOT_MEM=/root/projects_other/user2/memory \
       MEMKIT_PROJECTS_DIR=/root/projects_other/user2 \
       MEMKIT_OBSIDIAN_WIKI=/root/projects_other/user2/obsidian/_people,/root/projects_other/user2/obsidian/projects \
       MEMKIT_OBSIDIAN_SKIP=digests \
   node /root/.claude/scripts/hooks/memory-retrieval.js

# сводка auto-memory контура
env MEMKIT_ROOT_MEM=/root/projects_other/user2/memory \
    MEMKIT_SLUG_PREFIX=-root-projects-other-user2 \
    MEMKIT_OWNER_LABEL=user2 node /root/.claude/scripts/cron/aggregate-slug-memory.js --dry-run

# трассировка ночного прогона без трат лимита: подменить node заглушкой,
# которая печатает env, и прогнать копию other-memory-cron.sh с /tmp-путями
```

## Что осталось неравным осознанно

- `classify-homeless` — см. пункт 3 выше.
- `mirror-memory-to-vault` — их волт наполняет `context-mgr`, зеркало было бы дублем.
- Граф сущностей у user2 строится по 7 шардам и даёт мало хабов; её реальный слой
  людей — `obsidian/_people/` (35 файлов), который делает `context-mgr` и который теперь
  индексируется хуком. Расширять `entity-builder` на её волт смысла нет — это был бы дубль.
