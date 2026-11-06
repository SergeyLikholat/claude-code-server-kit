#!/usr/bin/env python3
"""Доверить все хуки Codex из hooks.json: берёт currentHash через app-server hooks/list
и пишет [hooks.state."<key>"] trusted_hash в $CODEX_HOME/config.toml."""
import json, os, subprocess, sys, re
home = os.environ.get("CODEX_HOME", os.path.expanduser("~/.codex"))
here = os.path.dirname(os.path.abspath(__file__))
out = subprocess.run([sys.executable, os.path.join(here, "appserver.py"), "hooks/list",
                      json.dumps({"cwds": [os.getcwd()]})], capture_output=True, text=True, timeout=60).stdout
hooks = json.loads(out)["result"]["data"][0]["hooks"]
cfg_path = os.path.join(home, "config.toml")
cfg = open(cfg_path).read() if os.path.exists(cfg_path) else ""
# убрать старые записи hooks.state для этого файла hooks.json — пересчитываем целиком
cfg = re.sub(r'\n?\[hooks\.state\."[^"]*"\]\ntrusted_hash = "[^"]*"\n', "\n", cfg)
blocks = "".join(f'\n[hooks.state."{h["key"]}"]\ntrusted_hash = "{h["currentHash"]}"\n' for h in hooks)
if "[hooks.state]" not in cfg: cfg = cfg.rstrip() + "\n\n[hooks.state]\n"
cfg = cfg.replace("[hooks.state]\n", "[hooks.state]\n" + blocks, 1)
open(cfg_path, "w").write(re.sub(r"\n{3,}", "\n\n", cfg))
print(f"доверено хуков: {len(hooks)}")
