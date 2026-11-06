#!/usr/bin/env node
// Переходник: запускает хук Claude Code под Codex.
//   node codex-adapter.js <путь к хуку Claude> [аргументы хука...]
//
// Codex правит файлы инструментом apply_patch, а хуки Claude ждут Write/Edit с
// tool_input.file_path. Патч разбирается на файлы, хук вызывается на каждый файл
// отдельно, ответы склеиваются. Остальные события передаются как есть.
// Любая ошибка переходника — пустой ответ и exit 0: хук не должен ломать работу Codex.
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');

const [hookPath, ...hookArgs] = process.argv.slice(2);
const HOOK_TIMEOUT_MS = 20000;

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

// Разбор формата apply_patch: «*** Add File: p», «*** Update File: p», «*** Delete File: p».
function parsePatch(patch) {
  const files = [];
  let cur = null;
  for (const line of String(patch).split('\n')) {
    const m = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (m) {
      cur = { op: m[1], path: m[2].trim(), added: [] };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    const mv = line.match(/^\*\*\* Move to: (.+)$/);
    if (mv) { cur.path = mv[1].trim(); continue; }
    if (line.startsWith('+') && !line.startsWith('+++')) cur.added.push(line.slice(1));
  }
  return files.filter(f => f.op !== 'Delete');
}

function toClaudePayloads(input) {
  if (input.tool_name !== 'apply_patch') return [input];
  const patch = (input.tool_input && (input.tool_input.command || input.tool_input.input)) || '';
  return parsePatch(patch).map(f => {
    const text = f.added.join('\n');
    return f.op === 'Add'
      ? { ...input, tool_name: 'Write', tool_input: { file_path: f.path, content: text } }
      : { ...input, tool_name: 'Edit', tool_input: { file_path: f.path, old_string: '', new_string: text } };
  });
}

function runHook(payload) {
  const r = spawnSync(process.execPath, [hookPath, ...hookArgs], {
    input: JSON.stringify(payload), encoding: 'utf8', timeout: HOOK_TIMEOUT_MS,
    env: { ...process.env, CODEX_HOOK: '1' },
  });
  let json = null;
  try { json = r.stdout && r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch {}
  return { code: r.status || 0, json, stderr: r.stderr || '' };
}

function main() {
  const raw = readStdin();
  if (!hookPath) return { code: 0 };
  let input;
  try { input = raw.trim() ? JSON.parse(raw) : {}; } catch { return { code: 0 }; }

  const results = toClaudePayloads(input).map(runHook);
  // Блок от любого вызова — блок всего действия (exit 2 + причина в stderr).
  const blocked = results.find(r => r.code === 2);
  if (blocked) return { code: 2, stderr: blocked.stderr };

  const event = input.hook_event_name || '';
  const contexts = [];
  let decision = null;
  for (const r of results) {
    const h = r.json && r.json.hookSpecificOutput;
    if (!h) continue;
    if (h.additionalContext) contexts.push(h.additionalContext);
    if (h.permissionDecision === 'deny') decision = h;
  }
  if (decision) {
    return { code: 0, json: { hookSpecificOutput: { hookEventName: event, permissionDecision: 'deny',
      permissionDecisionReason: decision.permissionDecisionReason || 'Запрещено хуком' } } };
  }
  if (!contexts.length) return { code: 0 };
  return { code: 0, json: { hookSpecificOutput: { hookEventName: event, additionalContext: contexts.join('\n\n') } } };
}

let out = { code: 0 };
try { out = main(); } catch { out = { code: 0 }; }
if (out.json) process.stdout.write(JSON.stringify(out.json));
if (out.stderr) process.stderr.write(out.stderr);
process.exit(out.code);
