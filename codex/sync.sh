#!/usr/bin/env bash
# Собирает для Codex ту же обвязку, что у Claude Code: правила, хуки памяти и охраны,
# скиллы, MCP. Источник правды остаётся у Claude; запуск повторяемый.
#
#   bash codex/sync.sh            — собрать и применить
#   bash codex/sync.sh --dry-run  — показать, что будет сделано
#
# Окружение: CODEX_HOME (по умолчанию ~/.codex), CLAUDE_DIR (~/.claude),
#            ROOT_CLAUDE_MD (/root/CLAUDE.md), AGENTS_SKILLS (~/.agents/skills).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"
ROOT_CLAUDE_MD="${ROOT_CLAUDE_MD:-/root/CLAUDE.md}"
AGENTS_SKILLS="${AGENTS_SKILLS:-$HOME/.agents/skills}"
CLAUDE_HOOKS="$CLAUDE_DIR/scripts/hooks"
DRY=0; [[ "${1:-}" == "--dry-run" ]] && DRY=1
STAMP="$(date +%Y%m%d-%H%M%S)"

log()  { printf '[codex-sync] %s\n' "$*"; }
die()  { printf '[codex-sync] ОШИБКА: %s\n' "$*" >&2; exit 1; }
backup() { [[ -f "$1" ]] && cp -p "$1" "$1.bak.$STAMP" && log "бэкап: $1.bak.$STAMP" || true; }

command -v codex >/dev/null || die "codex не найден в PATH"
command -v node  >/dev/null || die "node не найден в PATH"
# Два устройства сервера:
#  - «сервер Сергея»: хуки памяти в ~/.claude/scripts/hooks, правила в /root/CLAUDE.md;
#  - «сервер kit» (сотрудники): память из ~/llm-memory-kit (run.sh hooks/<имя>), CLAUDE.md может не быть.
MEMKIT_RUN="${MEMKIT_RUN:-$HOME/llm-memory-kit/run.sh}"
if [[ -f "$CLAUDE_HOOKS/memory-retrieval.js" ]]; then LAYOUT=sergey
elif [[ -f "$MEMKIT_RUN" ]]; then LAYOUT=kit
else die "не найдены хуки памяти: ни $CLAUDE_HOOKS, ни $MEMKIT_RUN"; fi
HEADER="${CODEX_HEADER:-$HERE/AGENTS.header.md}"
[[ "$LAYOUT" == kit && -z "${CODEX_HEADER:-}" ]] && HEADER="$HERE/AGENTS.header.kit.md"
[[ -f "$HEADER" ]] || die "нет шапки $HEADER"
log "устройство: $LAYOUT, шапка: $(basename "$HEADER")"
mkdir -p "$CODEX_HOME"

# ---------- 1. AGENTS.md: шапка Codex + /root/CLAUDE.md + общие правила ----------
build_agents() {
  cat "$HEADER"
  if [[ -f "$ROOT_CLAUDE_MD" ]]; then
    printf '\n# Правила владельца (%s)\n\n' "$ROOT_CLAUDE_MD"
    cat "$ROOT_CLAUDE_MD"
  fi
  for dir in common web; do
    rd="$CLAUDE_DIR/rules/$dir"; [[ -d "$rd" ]] || rd="$CLAUDE_DIR/rules/ecc/$dir"
    [[ -d "$rd" ]] || continue
    printf '\n\n# Правила разработки: %s (%s)\n' "$dir" "$rd"
    for f in "$rd"/*.md; do
      printf '\n<!-- %s -->\n' "$f"
      # Заголовки правил на уровень ниже, чтобы не спорили с разделами выше.
      sed 's/^#/##/' "$f"
    done
  done
}
TMP_AGENTS="$(mktemp)"; build_agents > "$TMP_AGENTS"
log "AGENTS.md: $(wc -c < "$TMP_AGENTS") байт"
if (( DRY )); then rm -f "$TMP_AGENTS"; else
  if ! cmp -s "$TMP_AGENTS" "$CODEX_HOME/AGENTS.md"; then backup "$CODEX_HOME/AGENTS.md"; fi
  mv "$TMP_AGENTS" "$CODEX_HOME/AGENTS.md"; chmod 644 "$CODEX_HOME/AGENTS.md"
fi

# ---------- 2. hooks.json: наши хуки + чужие (Orca), что уже стоят ----------
TMP_HOOKS="$(mktemp)"
HERE="$HERE" CLAUDE_HOOKS="$CLAUDE_HOOKS" CODEX_HOME="$CODEX_HOME" LAYOUT="$LAYOUT" MEMKIT_RUN="$MEMKIT_RUN" python3 - "$TMP_HOOKS" <<'PY'
import json, os, sys
here, ch, home = os.environ["HERE"], os.environ["CLAUDE_HOOKS"], os.environ["CODEX_HOME"]
MARK = "# codex-sync"            # метка наших хуков: по ней пересобираем, чужие не трогаем
adapter = f'node "{here}/hooks/codex-adapter.js"'
def cmd(c, timeout=15, matcher=None):
    g = {"hooks": [{"type": "command", "command": f"{c} {MARK}", "timeout": timeout}]}
    if matcher: g["matcher"] = matcher
    return g
if os.environ["LAYOUT"] == "kit":
    mem = lambda name: f'bash "{os.environ["MEMKIT_RUN"]}" hooks/{name}'
else:
    mem = lambda name: f'node "{ch}/{name}"'
ours = {
  "SessionStart": [
    cmd(mem("session-start-memory-index.js"), 10),
    cmd(f'node "{here}/hooks/project-memory.js"', 10),
  ],
  "UserPromptSubmit": [cmd(mem("memory-retrieval.js"), 15)],
  "PreToolUse": [cmd(f'{adapter} "{here}/hooks/protect-claude-config.js"', 10, "^(Bash|apply_patch)$")],
}
# Охрана текстов наружу и журнал команд есть только на сервере Сергея.
if os.path.isfile(f"{ch}/outbound-text-guard.js"):
    ours["PreToolUse"].append(cmd(f'{adapter} "{ch}/outbound-text-guard.js"', 10, "^(Bash|apply_patch|mcp__.*)$"))
if os.path.isfile(f"{ch}/post-bash-command-log.js"):
    ours["PostToolUse"] = [cmd(f'node "{ch}/post-bash-command-log.js" audit', 10, "^Bash$")]
path = os.path.join(home, "hooks.json")
try: cur = json.load(open(path)).get("hooks", {})
except Exception: cur = {}
merged = {}
for ev in sorted(set(cur) | set(ours)):
    foreign = [g for g in cur.get(ev, []) if not any(MARK in h.get("command", "") for h in g.get("hooks", []))]
    merged[ev] = ours.get(ev, []) + foreign
json.dump({"hooks": merged}, open(sys.argv[1], "w"), ensure_ascii=False, indent=2)
PY
if [[ "$LAYOUT" == sergey ]]; then
  for f in session-start-memory-index.js memory-retrieval.js; do
    [[ -f "$CLAUDE_HOOKS/$f" ]] || die "нет хука Claude: $CLAUDE_HOOKS/$f"
  done
fi
log "hooks.json: $(python3 -c "import json,sys;d=json.load(open(sys.argv[1]))['hooks'];print(sum(len(v) for v in d.values()))" "$TMP_HOOKS") групп"
if (( DRY )); then rm -f "$TMP_HOOKS"; else
  if ! cmp -s "$TMP_HOOKS" "$CODEX_HOME/hooks.json"; then backup "$CODEX_HOME/hooks.json"; fi
  mv "$TMP_HOOKS" "$CODEX_HOME/hooks.json"
fi

# ---------- 3. Скиллы: ссылки ~/.agents/skills/<имя> → ~/.claude/skills/<имя> ----------
linked=0; skipped=0
(( DRY )) || mkdir -p "$AGENTS_SKILLS"
for d in "$CLAUDE_DIR"/skills/*/; do
  d="${d%/}"; name="$(basename "$d")"
  [[ -f "$d/SKILL.md" ]] || { skipped=$((skipped+1)); continue; }
  dst="$AGENTS_SKILLS/$name"
  if [[ -e "$dst" && ! -L "$dst" ]]; then log "пропуск $name: $dst — не ссылка, не трогаю"; continue; fi
  (( DRY )) || ln -sfn "$d" "$dst"
  linked=$((linked+1))
done
# Убрать ссылки на удалённые скиллы Claude.
if [[ -d "$AGENTS_SKILLS" ]]; then
  for l in "$AGENTS_SKILLS"/*; do
    [[ -L "$l" ]] || continue
    t="$(readlink "$l")"
    [[ "$t" == "$CLAUDE_DIR/skills/"* && ! -e "$t" ]] && { (( DRY )) || rm -f "$l"; log "убрана ссылка на удалённый скилл: $l"; }
  done
fi
log "скиллы: ссылок $linked, без SKILL.md пропущено $skipped"

# ---------- 4. config.toml: через сам Codex (app-server config/batchWrite) ----------
EDITS="$(CLAUDE_DIR="$CLAUDE_DIR" python3 - <<'PY'
import json, os
edits = [
  {"keyPath": "project_doc_max_bytes", "value": 131072},
  {"keyPath": "project_doc_fallback_filenames", "value": ["CLAUDE.md"]},
  {"keyPath": "features.hooks", "value": True},
  {"keyPath": "features.memories", "value": False},   # память одна — общая с Claude
  {"keyPath": "web_search", "value": "live"},
]
# MCP: те же серверы, что глобально у Claude (кроме плагинов Telegram и т. п.).
try:
    servers = json.load(open(os.path.expanduser("~/.claude.json"))).get("mcpServers", {})
except Exception:
    servers = {}
for name, s in servers.items():
    if s.get("type", "stdio") != "stdio" or not s.get("command"):
        continue
    v = {"command": s["command"], "args": s.get("args", []), "startup_timeout_sec": 60}
    if s.get("env"): v["env"] = s["env"]
    edits.append({"keyPath": f"mcp_servers.{name}", "value": v})
for e in edits: e["mergeStrategy"] = "replace"
print(json.dumps({"edits": edits}))
PY
)"
log "config.toml: $(python3 -c "import json,sys;print(', '.join(e['keyPath'] for e in json.loads(sys.argv[1])['edits']))" "$EDITS")"
if (( ! DRY )); then
  backup "$CODEX_HOME/config.toml"
  out="$(cd /tmp && CODEX_HOME="$CODEX_HOME" timeout 90 python3 "$HERE/appserver.py" config/batchWrite "$EDITS")"
  grep -q '"status": "ok"' <<<"$out" || die "config/batchWrite не прошёл: $out"
fi

# ---------- 5. Доверить хукам (Codex запускает только доверенные) ----------
if (( ! DRY )); then
  (cd /root && CODEX_HOME="$CODEX_HOME" timeout 90 python3 "$HERE/trust_hooks.py")
fi
# Оставить по 5 последних бэкапов каждого файла.
for f in AGENTS.md hooks.json config.toml; do
  ls -1t "$CODEX_HOME/$f".bak.* 2>/dev/null | tail -n +6 | xargs -r rm -f
done
log "готово. Новые треды Codex в T3 подхватят настройки; открытые — после перезапуска треда."
