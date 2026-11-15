#!/usr/bin/env node
// SessionStart для Codex: подставляет авто-память текущего кабинета —
// то, что Claude Code грузит сам: /root/.claude/projects/<slug cwd>/memory/MEMORY.md
// (slug = cwd, где «/» и «_» заменены на «-»). Плюс общие правила про Сергея (-root).
// Ошибка или нет файла — пустой ответ, exit 0.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const CLAUDE_PROJECTS = process.env.CODEX_CLAUDE_PROJECTS || '/root/.claude/projects';
const MAX_BYTES = 12 * 1024;

function emit(ctx) {
  if (ctx) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } }));
  process.exit(0);
}
function readCapped(file) {
  try {
    const body = fs.readFileSync(file, 'utf8').trim();
    return body.length > MAX_BYTES ? body.slice(0, MAX_BYTES) + `\n…(обрезано, полностью — ${file})` : body;
  } catch { return ''; }
}

try {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch {}
  const cwd = String(input.cwd || process.cwd()).replace(/\/+$/, '');
  const slug = cwd.replace(/[/_.]/g, '-');
  const projDir = path.join(CLAUDE_PROJECTS, slug, 'memory');
  const rootDir = path.join(CLAUDE_PROJECTS, '-root', 'memory');
  const parts = [];
  const proj = readCapped(path.join(projDir, 'MEMORY.md'));
  parts.push(`# Авто-память этого кабинета\n\nКаталог: \`${projDir}/\` (сюда пишешь новые записи, формат — в AGENTS.md, раздел «Память»).\n\n` +
    (proj || '_Пока пусто._'));
  if (slug !== '-root') {
    const root = readCapped(path.join(rootDir, 'MEMORY.md'));
    if (root) parts.push(`# Общие правила про владельца сервера (из \`${rootDir}/MEMORY.md\`)\n\nИндекс; открывай файлы по ссылкам, когда тема касается запроса.\n\n${root}`);
  }
  emit(parts.join('\n\n---\n\n'));
} catch { emit(''); }
