#!/usr/bin/env node
// PreToolUse для Codex: запрещает правку секретных и ключевых файлов Claude Code.
// Claude сам в /root/.claude писать не может (жёсткий запрет харнесса), Codex может —
// этот хук закрывает самое опасное. Память и скрипты хуков остаются доступны.
// Вход — payload Codex; правки apply_patch приходят через codex-adapter.js как Write/Edit.
'use strict';
const fs = require('node:fs');

const CLAUDE_DIR = '/root/.claude';
// Что закрыто: настройки, учётные данные, плагины, файл ~/.claude.json.
const PROTECTED = [
  /^\/root\/\.claude\/settings(\.local)?\.json$/,
  /^\/root\/\.claude\/\.credentials\.json$/,
  /^\/root\/\.claude\/(.*\/)?\.env$/,
  /^\/root\/\.claude\/plugins\//,
  /^\/root\/\.claude\.json$/,
];
// Shell: запись в защищённый путь (перенаправление, sed -i, cp/mv/tee/rm в него).
const WRITE_CMD = /(>\s*|\b(sed\s+-i\S*|tee|cp|mv|rm|truncate|install|ln)\b[^|;&]*)(\/root\/\.claude\/(settings(\.local)?\.json|\.credentials\.json|plugins\/|\S*\.env\b)|\/root\/\.claude\.json)/;

function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
  process.exit(0);
}

let input = {};
try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
const tool = String(input.tool_name || '');
const ti = input.tool_input || {};
const reason = 'Файлы настроек Claude Code (settings.json, .credentials.json, .env, plugins/, ~/.claude.json) '
  + 'Codex не правит. Подготовь новую версию под /root/projects/_scratch/staging/ и попроси Сергея положить её на место.';

if (ti.file_path) {
  const p = String(ti.file_path).replace(/\/+/g, '/');
  if (p.startsWith(CLAUDE_DIR) && PROTECTED.some(re => re.test(p))) deny(reason);
}
if (tool === 'Bash' && WRITE_CMD.test(String(ti.command || ''))) deny(reason);
process.exit(0);
