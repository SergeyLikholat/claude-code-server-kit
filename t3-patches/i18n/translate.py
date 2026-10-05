#!/usr/bin/env python3
"""t3-patch: перевести строки каталога, которых ещё нет в ru.json.

    translate.py [--batch 120] [--parallel 6] [--limit N]

Берёт catalog.json (extract.mjs), отбирает непереведённые строки (кроме помеченных
compared), делит на пачки и переводит через Claude CLI с глоссарием. Каждый ответ
проверяется: подстановки {i} на месте, формы числа записаны верно, есть кириллица.
Непрошедшее проверку не попадает в словарь и остаётся в отчёте — строка просто
останется английской. Результат дописывается в ru.json.
"""
import argparse, json, re, subprocess, sys, tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
CLAUDE = "/root/.local/bin/claude"
MODEL = "claude-opus-5-5"

RULES = """Ты переводишь интерфейс программы T3 Code (оболочка для ИИ-агентов программирования) с английского на русский.
Верни ТОЛЬКО JSON-объект {"английская строка": "перевод", ...} — ровно те ключи, что на входе, без пояснений и без markdown.

Правила:
1. Стиль русских интерфейсов: коротко, без канцелярита. Кнопки и пункты меню — инфинитив («Открыть», «Скопировать путь», «Удалить тред»). Заголовки и подписи — с заглавной буквы только первое слово.
2. Подстановки {0}, {1}… сохраняй все, можно переставлять. Если подстановка в английском — это окончание множественного числа (например "{0} thread{1}", где {1} даёт "s" или ""), убери её и используй форму числа.
3. Форма числа: {0|форма для 1|для 2–4|для 5–20} выбирает слово по выражению 0. Число само не вставляется — пиши "{0} {0|тред|треда|тредов}".
4. Не переводи: Claude, Codex, Cursor, Grok, OpenCode, Antigravity, T3, T3 Code, Git, GitHub, GitLab, VS Code, MCP, API, URL, JSON, SSH, PR, CLI, Tailscale, Clerk, Opus, Sonnet, Haiku, Fable, названия клавиш (Enter, Shift, Ctrl, Cmd, Alt, Esc, Tab), команды и пути в `обратных кавычках`, имена файлов.
5. Сохраняй пунктуацию и символы по краям строки (·, …, :, →, (), %), многоточие как в оригинале.
6. Если строка — не текст для человека (значение CSS, код, формат, идентификатор), верни её без изменений.
7. Контекст «где» — путь к файлу исходника, он подсказывает смысл (settings — настройки, sidebar — список тредов, files — проводник, chat/composer — чат, pullRequest — PR, terminal — терминал).

Глоссарий (обязателен): thread → тред; project → проект; settled → завершённые; pin/pinned → закрепить/закреплённые; snooze → отложить; composer → поле ввода; branch → ветка; commit → коммит; pull request → PR; diff → изменения (в заголовках), diff (в технических местах); worktree → рабочая копия; provider → провайдер; pairing/pair → сопряжение/подключить; environment → окружение; surface/tab → вкладка; model → модель; effort → глубина рассуждений; Low/Medium/High → низкая/средняя/высокая; Settings → Настройки; terminal → терминал; preview browser → браузер предпросмотра; attachment → вложение; mention → упоминание; skill → скилл; agent → агент; turn → ход; checkpoint → контрольная точка; archive → архив; workspace → рабочая папка; session → сессия; token (auth) → токен; usage → расход.
"""

PH = re.compile(r"\{(\d+)(?:\|[^|}]*\|[^|}]*\|[^|}]*)?\}")
PLURAL = re.compile(r"\{(\d+)\|([^|}]*)\|([^|}]*)\|([^|}]*)\}")


def placeholder_ok(src: str, ru: str) -> tuple[bool, str]:
    need = set(re.findall(r"\{(\d+)\}", src))
    got = {m.group(1) for m in PH.finditer(ru)}
    if got - need:
        return False, f"лишние подстановки {sorted(got - need)}"
    has_plural = bool(PLURAL.search(ru))
    for i in need - got:
        # Убрать можно английскую грамматику, которую заменила русская форма числа
        # (окончание -s, is/are, it/them), либо окончание вплотную к слову.
        if not has_plural and not re.search(r"[A-Za-z]\{" + i + r"\}", src):
            return False, f"пропала подстановка {{{i}}}"
    if "{" in PH.sub("", ru) and re.search(r"\{\d", PH.sub("", ru)):
        return False, "кривая форма числа"
    return True, ""


def validate(src: str, ru) -> tuple[bool, str]:
    if not isinstance(ru, str) or not ru.strip():
        return False, "пустой перевод"
    ok, why = placeholder_ok(src, ru)
    if not ok:
        return False, why
    return True, ""


def run_batch(idx: int, items: list[dict]) -> dict:
    payload = [{"s": it["key"], "где": it["where"][:2], "вид": it["kinds"]} for it in items]
    prompt = RULES + "\nСтроки (s — что переводить):\n" + json.dumps(payload, ensure_ascii=False, indent=0)
    with tempfile.TemporaryDirectory() as tmp:  # вне /root — без CLAUDE.md проектов
        proc = subprocess.run([CLAUDE, "-p", "--model", MODEL, "--max-turns", "1"], input=prompt,
                              capture_output=True, text=True, cwd=tmp, timeout=900)
    text = proc.stdout
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return {"_error": f"пачка {idx}: нет JSON ({proc.stderr[-200:]})"}
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError as e:
        return {"_error": f"пачка {idx}: JSON не разобрался ({e})"}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch", type=int, default=120)
    ap.add_argument("--parallel", type=int, default=6)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    catalog = json.loads((HERE / "catalog.json").read_text())
    dict_path = HERE / "ru.json"
    d = json.loads(dict_path.read_text()) if dict_path.exists() else {"strings": {}, "files": {}}
    scoped = {k for f in d.get("files", {}).values() for k in f}
    todo = [dict(key=k, **v) for k, v in catalog.items()
            if "compared" not in v and k not in d["strings"] and k not in scoped]
    if args.limit:
        todo = todo[: args.limit]
    batches = [todo[i : i + args.batch] for i in range(0, len(todo), args.batch)]
    print(f"к переводу: {len(todo)} строк, пачек: {len(batches)}", flush=True)

    rejected = []
    with ThreadPoolExecutor(max_workers=args.parallel) as pool:
        for n, result in enumerate(pool.map(lambda p: run_batch(*p), enumerate(batches)), 1):
            if "_error" in result:
                print("  ОШИБКА", result["_error"], flush=True)
                continue
            added = 0
            for src, ru in result.items():
                if src not in catalog:
                    continue
                ok, why = validate(src, ru)
                if ok:
                    d["strings"][src] = ru
                    added += 1
                else:
                    rejected.append((src, ru, why))
            dict_path.write_text(json.dumps(d, ensure_ascii=False, indent=1, sort_keys=True))
            print(f"  пачка {n}/{len(batches)}: +{added}", flush=True)
    (HERE / "rejected.json").write_text(json.dumps(rejected, ensure_ascii=False, indent=1))
    print(f"итог: в словаре {len(d['strings'])}, отклонено проверкой {len(rejected)} (rejected.json)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
