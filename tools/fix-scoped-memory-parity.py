#!/usr/bin/env python3
"""Доводит архитектуру памяти чужих контуров (user2, user3) до паритета с контуром владельца.

Правка 1 — `hooks/memory-retrieval.js`: индексация волта чужого контура.
    У владельца сжатая память лежит в `/root/Obsidian/_wiki` (215 MOC) и индексируется хуком.
    У user2 машинного слоя `_wiki` нет вообще, а сжатая память лежит в
    `obsidian/_people/` (35 файлов) и `obsidian/projects/*/topics/` (593 файла) —
    и хук их НЕ видит, потому что путь `_wiki` захардкожен. Её самый ценный слой
    памяти не участвует в авто-извлечении.
    Вводим `MEMKIT_OBSIDIAN_WIKI` (CSV каталогов) и `MEMKIT_OBSIDIAN_SKIP`
    (имена подкаталогов-исключений, у неё это `digests` — 283 файла сырья).

Правка 2 — `cron/memory-index-builder.js`: убрать битую ссылку.
    Путеводитель чужого контура печатает «Правила про <владельца> → <ROOT_MEM>/MEMORY.md»,
    но у user2 этого файла нет: нативная auto-memory пишется в каталоги по слагам
    сессий (`-root-projects-other-user2-{psychology,health,nutrition}/memory/`),
    а не в корень контура. Ссылка ведёт в пустоту → печатаем строку только если файл есть.

Запуск:  python3 /root/projects/claude-code-server-kit/tools/fix-scoped-memory-parity.py [--dry-run]
Идемпотентен, делает .bak, проверяет `node --check`, откатывается при ошибке.

После применения — добавить в /etc/systemd/system/tg-router2.service:
    Environment=MEMKIT_OBSIDIAN_WIKI=/root/projects_other/user2/obsidian/_people,/root/projects_other/user2/obsidian/projects
    Environment=MEMKIT_OBSIDIAN_SKIP=digests
и `systemctl daemon-reload && systemctl restart tg-router2.service`.
"""

import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

DRY = "--dry-run" in sys.argv

RETRIEVAL = Path("/root/.claude/scripts/hooks/memory-retrieval.js")
BUILDER = Path("/root/.claude/scripts/cron/memory-index-builder.js")

# --- Правка 1: env-переменные + использование в collectCards ---

R1_OLD = "const PROJECTS_DIR = process.env.MEMKIT_PROJECTS_DIR || '/root/projects';"
R1_NEW = """// Волты чужих контуров устроены иначе: машинного слоя `_wiki` у них нет, а сжатая
// память лежит в `_people/` и `projects/*/topics/`. MEMKIT_OBSIDIAN_WIKI задаёт
// каталоги для индексации явно (CSV), MEMKIT_OBSIDIAN_SKIP — имена подкаталогов,
// которые пропускать (у user2 это `digests` — сырьё, 283 файла).
const WIKI_DIRS = (process.env.MEMKIT_OBSIDIAN_WIKI || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const WIKI_SKIP = new Set(
  (process.env.MEMKIT_OBSIDIAN_SKIP || '').split(',').map(s => s.trim()).filter(Boolean));
const PROJECTS_DIR = process.env.MEMKIT_PROJECTS_DIR || '/root/projects';"""

R2_OLD = "  if(OBSIDIAN_WIKI)walk(OBSIDIAN_WIKI,'Obsidian');"
R2_NEW = """  if(WIKI_DIRS.length){for(const d of WIKI_DIRS)walk(d,'Obsidian');}
  else if(OBSIDIAN_WIKI)walk(OBSIDIAN_WIKI,'Obsidian');"""

# Пропуск подкаталогов по имени — вставляем рядом с проверкой на MIRROR.
R3_OLD = "if(e.isDirectory()){if(full===MIRROR)continue;walk(full,label);continue;}"
R3_NEW = "if(e.isDirectory()){if(full===MIRROR||WIKI_SKIP.has(e.name))continue;walk(full,label);continue;}"

# --- Правка 2: не печатать битую ссылку на MEMORY.md ---

B1_OLD = """    `- **Правила про ${OWNER}** — как обращаться, предпочтения, договорённости, рабочие приёмы.`,
    '  → `' + path.join(ROOT_MEM, 'MEMORY.md') + '`',"""
B1_NEW = """    ...(fs.existsSync(path.join(ROOT_MEM, 'MEMORY.md')) ? [
      `- **Правила про ${OWNER}** — как обращаться, предпочтения, договорённости, рабочие приёмы.`,
      '  → `' + path.join(ROOT_MEM, 'MEMORY.md') + '`',
    ] : []),"""


def patch(path: Path, replacements: list[tuple[str, str]]) -> str:
    text = path.read_text(encoding="utf-8")
    states = []
    for old, new in replacements:
        if new in text:
            states.append("already")
            continue
        if old not in text:
            return f"❌ {path.name}: фрагмент не найден — файл разошёлся, ничего не менял"
        text = text.replace(old, new, 1)
        states.append("patched")

    if all(s == "already" for s in states):
        return f"✅ {path.name}: уже исправлен"
    if DRY:
        return f"🔍 {path.name}: применимо ({', '.join(states)}) — dry-run"

    backup = path.with_name(f"{path.name}.bak.{datetime.now():%Y%m%d-%H%M%S}")
    shutil.copy2(path, backup)
    path.write_text(text, encoding="utf-8")

    check = subprocess.run(["node", "--check", str(path)], capture_output=True, text=True)
    if check.returncode != 0:
        shutil.copy2(backup, path)
        return f"❌ {path.name}: синтаксис сломан, откатил из {backup}\n{check.stderr}"
    return f"✅ {path.name}: исправлен ({', '.join(states)}), бэкап {backup}"


def main() -> int:
    print(patch(RETRIEVAL, [(R1_OLD, R1_NEW), (R2_OLD, R2_NEW), (R3_OLD, R3_NEW)]))
    print(patch(BUILDER, [(B1_OLD, B1_NEW)]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
