"""
office_guard — не даёт серверу перезаписать xlsx/docx, открытый в Excel/Word на ПК.

Зачем. База /root/Obsidian синхронизируется Syncthing с ПК. Если файл открыт
в Excel, а сервер его перезаписал, Syncthing на ПК не может подменить
заблокированный файл, а после сохранения в Excel появляется
`*.sync-conflict-*`. Excel и Word держат рядом файл-владелец `~$имя`, и
Syncthing привозит его на сервер — по нему и видно, что файл открыт.

Как работает. Файл `office_guard.pth` в site-packages импортирует модуль
при старте любого python3. Модуль ставит хук импорта и, когда кто-то
загружает openpyxl или python-docx, оборачивает `Workbook.save` и
`Document.save`. Если целевой файл лежит в базе и открыт на ПК, в stderr
идёт предупреждение; сама запись не меняется.

Почему только предупреждение (2026-09-27). Сначала запись уводилась в копию
`<имя> (сервер)`, но это ломает скрипты, которые правят файл в несколько
проходов (zip-правка + Document(OUT) + save): часть шагов ушла в оригинал,
часть в копию, ни одна версия не была полной. А открытый, но не изменённый
файл Syncthing на ПК и так подменяет сам после закрытия — повторяет попытку.
Конфликт бывает, только если файл сохранили на ПК; его разбирает check.py.

Отключить на один запуск: OFFICE_GUARD=off.
"""

import os
import sys
import time
from importlib.abc import MetaPathFinder
from importlib.machinery import PathFinder
from pathlib import Path

GUARDED_ROOT = Path("/root/Obsidian")
SIDE_SUFFIX = " (сервер)"
STALE_LOCK_S = 3 * 24 * 3600  # старше — след упавшего Excel, не открытый файл


def lock_candidates(path: Path) -> list[Path]:
    """Имена файла-владельца: Excel пишет `~$` + полное имя, Word укорачивает."""
    name, stem = path.name, path.stem
    names = ["~$" + name]
    if len(stem) == 7:
        names.append("~$" + name[1:])
    elif len(stem) >= 8:
        names.append("~$" + name[2:])
    return [path.with_name(n) for n in names]


def find_lock(path: Path) -> Path | None:
    now = time.time()
    for p in lock_candidates(path):
        try:
            if now - p.stat().st_mtime < STALE_LOCK_S:
                return p
        except FileNotFoundError:
            pass
    return None


def side_path(path: Path) -> Path:
    return path.with_name(f"{path.stem}{SIDE_SUFFIX}{path.suffix}")


def guard(target):
    if os.environ.get("OFFICE_GUARD") == "off":
        return target
    if not isinstance(target, (str, os.PathLike)):
        return target  # поток в памяти
    path = Path(os.fspath(target)).resolve()
    if GUARDED_ROOT not in path.parents:
        return target
    lock = find_lock(path)
    if lock is None:
        return target
    print(
        f"⚠️ office_guard: «{path.name}» открыт на ПК ({lock.name}). Файл записан; "
        f"Syncthing подменит его на ПК, как только его закроют. Скажи владельцу: "
        f"закрыть без сохранения, иначе будет конфликт версий.",
        file=sys.stderr,
    )
    return target


def _wrap_save(cls, attr="save"):
    original = getattr(cls, attr)
    if getattr(original, "_office_guard", False):
        return

    def save(self, target, *args, **kwargs):
        return original(self, guard(target), *args, **kwargs)

    save._office_guard = True
    setattr(cls, attr, save)


_PATCHES = {
    "openpyxl.workbook.workbook": lambda m: _wrap_save(m.Workbook),
    "docx.document": lambda m: _wrap_save(m.Document),
}


class _Finder(MetaPathFinder):
    def find_spec(self, name, path=None, target=None):
        patch = _PATCHES.get(name)
        if patch is None:
            return None
        spec = PathFinder.find_spec(name, path)
        if spec is None or spec.loader is None:
            return spec
        exec_module = spec.loader.exec_module

        def patched_exec(module):
            exec_module(module)
            patch(module)

        spec.loader.exec_module = patched_exec
        return spec


def install():
    if not any(isinstance(f, _Finder) for f in sys.meta_path):
        sys.meta_path.insert(0, _Finder())
    for name, patch in _PATCHES.items():  # модуль уже загружен до нас
        if name in sys.modules:
            patch(sys.modules[name])


install()
