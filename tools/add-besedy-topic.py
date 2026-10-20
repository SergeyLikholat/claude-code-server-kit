#!/usr/bin/env python3
"""Врезает топик «Беседы» (mode=vscode_bridge) в routing.json роутера user2.

Использование:
    python3 /root/projects/claude-code-server-kit/tools/add-besedy-topic.py <THREAD_ID>

Делает бэкап, проверяет, что топик ещё не заведён, и валидирует результат.
После применения нужен рестарт: systemctl restart tg-router2.service
"""

import json
import shutil
import sys
from datetime import datetime
from pathlib import Path

ROUTING = Path("/root/.claude/channels/telegram2/routing.json")
PROJECT_DIR = "/root/projects_other/user2"
TOPIC_NAME = "Беседы"


def main() -> int:
    if len(sys.argv) != 2 or not sys.argv[1].isdigit():
        print(__doc__)
        return 2
    thread_id = sys.argv[1]

    data = json.loads(ROUTING.read_text(encoding="utf-8"))
    topics = data.setdefault("topics", {})

    if thread_id in topics:
        print(f"⚠️  Топик {thread_id} уже есть: {topics[thread_id].get('name')!r} — ничего не меняю")
        return 1

    existing = [t.get("name") for t in topics.values()]
    if TOPIC_NAME in existing:
        print(f"⚠️  Топик с именем {TOPIC_NAME!r} уже заведён под другим thread_id — проверь вручную")
        return 1

    backup = ROUTING.with_suffix(f".json.bak.{datetime.now():%Y%m%d-%H%M%S}")
    shutil.copy2(ROUTING, backup)

    topics[thread_id] = {
        "name": TOPIC_NAME,
        "mode": "vscode_bridge",
        "project_dir": PROJECT_DIR,
        "session_id": "_BRIDGE_PLACEHOLDER_",
        "ux": {"stream_intermediate": True, "stream_poll_ms": 15000},
    }

    ROUTING.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # Валидация: файл читается, топик на месте, режим тот самый.
    check = json.loads(ROUTING.read_text(encoding="utf-8"))["topics"][thread_id]
    assert check["mode"] == "vscode_bridge", check

    print(f"✅ Топик «{TOPIC_NAME}» (thread_id={thread_id}) добавлен")
    print(f"   бэкап: {backup}")
    print("   дальше: systemctl restart tg-router2.service")
    return 0


if __name__ == "__main__":
    sys.exit(main())
