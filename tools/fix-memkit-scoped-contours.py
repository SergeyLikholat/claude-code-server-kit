#!/usr/bin/env python3
"""Исправляет два бага изоляции памяти в установленных хуках /root/.claude/scripts/.

Оба ломают ЧУЖИЕ контуры памяти (user2, user3), контур владельца не затрагивают.

БАГ 1 — memory-retrieval.js: при MEMKIT_OBSIDIAN_DIR='' переменная OBSIDIAN_WIKI = null,
        дальше path.join(null, 'память') бросает TypeError, fail-safe его глотает →
        хук молча отдаёт ПУСТУЮ память. То есть у scoped-пользователя авто-извлечение
        памяти не работало вообще. В /root/projects/llm-memory-kit/hooks/ уже исправлено.

БАГ 2 — cron/memory-index-builder.js: в шаблоне путеводителя зашиты «Правила про владельца
        → /root/.claude/projects/-root/memory/MEMORY.md» и «/root/Obsidian/_wiki». Поэтому
        в _memory-index.md ЧУЖОГО контура (и, через SessionStart-хук, в контекст её сессий)
        попадала карта памяти владельца.

Запуск:  python3 /root/projects/claude-code-server-kit/tools/fix-memkit-scoped-contours.py [--dry-run]
Идемпотентен, делает .bak перед правкой, проверяет синтаксис через node --check.
"""

import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

DRY = "--dry-run" in sys.argv

RETRIEVAL = Path("/root/.claude/scripts/hooks/memory-retrieval.js")
BUILDER = Path("/root/.claude/scripts/cron/memory-index-builder.js")

FIX1_OLD = "  const MIRROR=path.join(OBSIDIAN_WIKI,'память');"
FIX1_NEW = "  const MIRROR=OBSIDIAN_WIKI?path.join(OBSIDIAN_WIKI,'память'):'';"

FIX2_ANCHOR = "const GLOBAL_INDEX = path.join(ROOT_MEM, '_memory-index.md');"
FIX2_VARS = """const GLOBAL_INDEX = path.join(ROOT_MEM, '_memory-index.md');
// Владелец контура и его волт. Без этого в путеводитель ЧУЖОГО контура попадала
// ссылка на память и Obsidian владельца — карта его памяти уезжала в контекст
// сессий жены/знакомых через SessionStart-хук.
// Значение в винительном падеже: подставляется в «Правила про <OWNER>».
const OWNER = process.env.MEMKIT_OWNER_LABEL || 'владельца';
const OBSIDIAN = process.env.MEMKIT_OBSIDIAN_DIR === undefined
  ? '/root/Obsidian'
  : process.env.MEMKIT_OBSIDIAN_DIR;"""

FIX2_TPL_OLD = """    '- **Правила про владельца** — как обращаться, предпочтения, договорённости, рабочие приёмы.',
    '  → `/root/.claude/projects/-root/memory/MEMORY.md`',
    '- **Знания из заметок (Obsidian)** — ТК, бизнес, личное, ресурсы; 44 тематические карты (MOC).',
    '  → `/root/Obsidian/_wiki/index.md` _(релевантные карты также подставляются авто на каждый запрос)_',
    '- **История и задачи по проектам** — ниже, у каждого свой `_index.md`.', '',"""

FIX2_TPL_NEW = """    `- **Правила про ${OWNER}** — как обращаться, предпочтения, договорённости, рабочие приёмы.`,
    '  → `' + path.join(ROOT_MEM, 'MEMORY.md') + '`',
    ...(OBSIDIAN ? [
      '- **Знания из заметок (Obsidian)** — тематические карты (MOC).',
      '  → `' + path.join(OBSIDIAN, '_wiki', 'index.md') + '` _(релевантные карты также подставляются авто на каждый запрос)_',
    ] : []),
    '- **История и задачи по проектам** — ниже, у каждого свой `_index.md`.', '',"""


def patch(path: Path, replacements: list[tuple[str, str]]) -> str:
    text = path.read_text(encoding="utf-8")
    applied = []
    for old, new in replacements:
        if new in text:
            applied.append("already")
            continue
        if old not in text:
            return f"❌ {path.name}: не найден фрагмент для правки — файл разошёлся, патч не применён"
        text = text.replace(old, new, 1)
        applied.append("patched")

    if all(a == "already" for a in applied):
        return f"✅ {path.name}: уже исправлен, изменений нет"
    if DRY:
        return f"🔍 {path.name}: правки применимы ({', '.join(applied)}) — dry-run, файл не тронут"

    backup = path.with_name(f"{path.name}.bak.{datetime.now():%Y%m%d-%H%M%S}")
    shutil.copy2(path, backup)
    path.write_text(text, encoding="utf-8")

    check = subprocess.run(["node", "--check", str(path)], capture_output=True, text=True)
    if check.returncode != 0:
        shutil.copy2(backup, path)
        return f"❌ {path.name}: синтаксис сломался, откатил из {backup}\n{check.stderr}"
    return f"✅ {path.name}: исправлен ({', '.join(applied)}), бэкап {backup}"


def main() -> int:
    print(patch(RETRIEVAL, [(FIX1_OLD, FIX1_NEW)]))
    print(patch(BUILDER, [(FIX2_ANCHOR, FIX2_VARS), (FIX2_TPL_OLD, FIX2_TPL_NEW)]))
    print()
    print("Проверка после применения:")
    print("  MEMKIT_ROOT_MEM=/root/projects_other/user2/memory \\")
    print("  MEMKIT_PROJECTS_DIR=/root/projects_other/user2 MEMKIT_OBSIDIAN_DIR= \\")
    print("  node /root/.claude/scripts/hooks/memory-retrieval.js <<< '{\"prompt\":\"щитовидка\"}'")
    print("  → должна вернуться её память, а не пустой additionalContext")
    return 0


if __name__ == "__main__":
    sys.exit(main())
