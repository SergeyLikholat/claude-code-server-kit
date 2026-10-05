#!/usr/bin/env python3
"""Достаёт публичные облачные настройки из официальной сборки T3.

Официальный релиз собирается с зашитыми ключом входа Clerk и адресом ретранслятора.
Без них своя сборка теряет облачные функции (вход, подключение через relay).
Значения публичные и лежат в клиенте открытым текстом, поэтому берём их оттуда,
а не храним в git: при смене в новом релизе они подхватятся сами.

Телеметрию разработчиков (VITE_RELAY_OTLP_*) намеренно не переносим.

Использование: official_config.py <каталог официальной версии>  → строки export для bash
"""
import glob
import re
import sys

WANTED = [
    "VITE_T3CODE_RELAY_URL",
    "VITE_CLERK_PUBLISHABLE_KEY",
    "VITE_CLERK_JWT_TEMPLATE",
    "VITE_CLERK_CLI_OAUTH_CLIENT_ID",
]
# серверные переменные, которые vite.config сервера читает под другими именами
SERVER_ALIASES = {
    "VITE_T3CODE_RELAY_URL": "T3CODE_RELAY_URL",
    "VITE_CLERK_PUBLISHABLE_KEY": "T3CODE_CLERK_PUBLISHABLE_KEY",
    "VITE_CLERK_JWT_TEMPLATE": "T3CODE_CLERK_JWT_TEMPLATE",
    "VITE_CLERK_CLI_OAUTH_CLIENT_ID": "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
}


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    found: dict[str, str] = {}
    for path in glob.glob(f"{sys.argv[1]}/client/assets/*.js"):
        text = open(path, encoding="utf-8", errors="ignore").read()
        if "VITE_T3CODE_RELAY_URL:" not in text:
            continue
        for key in WANTED:
            match = re.search(key + r":`([^`]*)`", text)
            if match:
                found[key] = match.group(1)
        break
    missing = [k for k in WANTED if not found.get(k)]
    if missing:
        print(f"не нашёл в официальном клиенте: {', '.join(missing)}", file=sys.stderr)
        return 1
    for key in WANTED:
        print(f"export {key}='{found[key]}'")
        print(f"export {SERVER_ALIASES[key]}='{found[key]}'")
    print("export T3CODE_WEB_SOURCEMAP=false")
    return 0


if __name__ == "__main__":
    sys.exit(main())
