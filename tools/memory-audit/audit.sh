#!/bin/bash
# Аудит памяти llm-memory-kit на сервере: по каждому пользователю с ~/llm-memory-kit.
# Только чтение. Запуск: ssh <host> 'bash -s' < audit.sh
for H in /root /home/*; do
  K=$H/llm-memory-kit; [ -d "$K" ] || continue
  U=$(stat -c %U "$H"); echo "### user=$U home=$H"
  echo "kit: $(git -C $K log -1 --format=%h_%cs 2>/dev/null) digest_md5=$(md5sum < $K/core/digest.js | cut -c1-8) codex_support=$(grep -c parseCodexSession $K/core/digest.js)"
  grep -hE "^export MEMKIT_(PROJECTS_DIR|ROOT_MEM|OWNER_LABEL)=" $K/config.sh 2>/dev/null | cut -c1-110
  S=$H/.claude/settings.json
  echo "hooks: $(python3 -c "import json;d=json.load(open('$S')).get('hooks',{});print(','.join(sorted(e for e,gs in d.items() for g in gs for h in g.get('hooks',[]) if 'memory' in h.get('command',''))))" 2>&1)"
  echo "cron: $(crontab -u $U -l 2>/dev/null | grep -c llm-memory-kit) lines; digest=$(crontab -u $U -l 2>/dev/null | grep -c core/digest.js)"
  echo "last digest: $(grep -h 'просканировано' $K/core/digest.log 2>/dev/null | tail -1 | cut -c1-110)"
  echo "last memcron: $(tail -1 $K/core/memory-cron.log 2>/dev/null | cut -c1-80)"
  P=$(grep -oP '^export MEMKIT_PROJECTS_DIR="\$\{MEMKIT_PROJECTS_DIR:-\K[^}]+' $K/config.sh 2>/dev/null); P=${P:-$H/projects}
  # transcripts: cwd outside projects dir/home -> digest drops them as foreign
  python3 - "$H/.claude/projects" "$P" "$H" <<'PY'
import json,os,sys,glob,time
src,P,H=sys.argv[1:4]; tot=fo=0; recent=0; fdirs={}
for f in glob.glob(src+'/*/*.jsonl'):
    tot+=1; cwd=None
    try:
        for l in open(f):
            try: d=json.loads(l)
            except: continue
            if d.get('cwd'): cwd=d['cwd']; break
    except: continue
    if time.time()-os.path.getmtime(f)<14*86400: recent+=1
    if cwd and not (cwd==P or cwd.startswith(P+'/') or cwd==H or cwd.startswith('/tmp')):
        fo+=1; fdirs[cwd]=fdirs.get(cwd,0)+1
print(f"transcripts: {tot} (14d: {recent}); OUTSIDE projects (never digested): {fo} {dict(list(fdirs.items())[:4])}")
PY
  n=$(find $P/*/memory/topics $H/.claude/projects/*/memory/topics -name '*.md' 2>/dev/null | wc -l); a=$(find $P/*/memory/activity $H/.claude/projects/*/memory/activity -name 'daily.md' 2>/dev/null | wc -l)
  echo "topics: $n, activity buffers: $a"
  DB=$H/.t3/userdata/state.sqlite
  [ -f $DB ] && echo "t3 projects: $(sqlite3 $DB "select group_concat(workspace_root,' | ') from projection_projects where deleted_at is null" 2>&1 | cut -c1-200)"
done
