#!/usr/bin/env python3
"""Минимальный JSON-RPC клиент к `codex app-server` (stdio). Использование:
   appserver.py METHOD '{"json":"params"}' [METHOD2 PARAMS2 ...]"""
import json, subprocess, sys, os
p = subprocess.Popen(["codex", "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=subprocess.DEVNULL, text=True, env=os.environ)
def send(msg): p.stdin.write(json.dumps(msg) + "\n"); p.stdin.flush()
def wait(i):
    for line in p.stdout:
        d = json.loads(line)
        if d.get("id") == i: return d
send({"jsonrpc":"2.0","id":0,"method":"initialize","params":{"clientInfo":{"name":"setup","version":"0"},"capabilities":{"experimentalApi":True}}})
wait(0); send({"jsonrpc":"2.0","method":"initialized"})
a = sys.argv[1:]; n = 1
for m, prm in zip(a[::2], a[1::2]):
    send({"jsonrpc":"2.0","id":n,"method":m,"params":json.loads(prm)})
    print(json.dumps(wait(n), ensure_ascii=False, indent=1)); n += 1
p.terminate()
