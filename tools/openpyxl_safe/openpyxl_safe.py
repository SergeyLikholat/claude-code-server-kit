"""
openpyxl_safe — один import, и сгенерированные xlsx открываются в Excel
без диалога «Excel удалось открыть файл, восстановив или удалив нечитаемое
содержимое».

Использование:
    import sys
    sys.path.insert(0, "/opt/openpyxl_safe")
    import openpyxl_safe  # noqa: F401  (side-effect патч)

    # дальше обычный openpyxl-код
    import openpyxl
    wb = openpyxl.Workbook()
    ...
    wb.save("file.xlsx")

Что патчится:

1. **Битый W3CDTF в docProps/core.xml.**
   openpyxl 3.1.x в `NestedDateTime.to_tree` всегда дописывает 'Z' к
   `value.isoformat()`. При этом `writer/excel.py` перед save принудительно
   ставит `properties.modified = datetime.now(tz=UTC)` (tz-aware).
   Результат: `2026-04-27T15:22:19+00:00Z` — невалидный W3CDTF.
   Excel считает core.xml повреждённым и предлагает «восстановить».
   Фикс: tz-aware datetime приводим к naive UTC до isoformat().

Версия openpyxl, на которой подтверждён баг: 3.1.2.
"""

from datetime import timezone

from openpyxl.packaging import core as _opx_core
from openpyxl.xml.functions import Element


def _safe_dt_to_tree(self, tagname=None, value=None, namespace=None):
    namespace = getattr(self, "namespace", namespace)
    if namespace is not None:
        tagname = "{%s}%s" % (namespace, tagname)
    el = Element(tagname)
    if value is not None:
        if value.tzinfo is not None:
            value = value.astimezone(timezone.utc).replace(tzinfo=None)
        el.text = value.isoformat(timespec="seconds") + "Z"
        return el


_opx_core.NestedDateTime.to_tree = _safe_dt_to_tree
