#!/usr/bin/env node
'use strict';
// Digest v2: читает РОДНЫЕ транскрипты Claude Code (~/.claude/projects/*/*.jsonl)
// и сессии Codex (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) — резервной модели в T3.
// Чинит баги старого digest на session-data/*.tmp: обрезку до ~10 реплик, затирание сессий
// одного дня, потерю ответов. Дедуп по sessionId, инкрементально по mtime.
const fs = require('node:fs');
const path = require('node:path');

const H = process.env.HOME || '/root';
const CLAUDE_DIR = process.env.MEMKIT_CLAUDE_DIR || (H + '/.claude');
const PROJECTS_DIR = process.env.MEMKIT_PROJECTS_DIR || (H + '/projects');
const ROOT_MEM = process.env.MEMKIT_ROOT_MEM || (CLAUDE_DIR + '/projects/-root/memory');
const SRC = path.join(CLAUDE_DIR, 'projects');
const CODEX_SESSIONS = process.env.MEMKIT_CODEX_SESSIONS || (H + '/.codex/sessions');
const ROUTING = process.env.MEMKIT_TG_ROUTING || (CLAUDE_DIR + '/channels/telegram/routing.json');
// state отдельный на каждый контур: владельческий прогон помечает чужие транскрипты
// обработанными (чтобы не перечитывать), и с общим state память чужого контура
// никогда бы не построилась — его digest считал бы их уже разобранными.
const STATE = path.join(CLAUDE_DIR, 'scripts', 'cron',
  '.digest-jsonl.state' + (process.argv.includes('--owner') ? '.' + process.argv[process.argv.indexOf('--owner') + 1] : '') + '.json');
const TZ = process.env.MEMKIT_TZ || 'Europe/Moscow';
const WINDOW_DAYS = 14, MAX_Q = 20, MAX_A = 8, Q_LEN = 260, A_LEN = 420;
const MIN_CHARS = 400, MIN_Q = 2, MAX_BLOCKS = 90;   // фильтр шума + потолок буфера

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const ALL = args.includes('--all');           // разовый прогон всей истории
// --owner <slug>: режим ЧУЖОГО контура (жена, знакомые). Читает ТОЛЬКО сессии этого человека
// (директории транскриптов -root-projects-other-<slug>*) и пишет в ЕГО память (MEMKIT_ROOT_MEM).
// Без флага — обычный режим владельца, где такие сессии наоборот отсекаются (см. isForeign).
const OWNER = (() => { const i = args.indexOf('--owner'); return i >= 0 ? args[i + 1] : null; })();
const log = (...a) => console.log('[digest2 ' + new Date().toISOString() + ']', ...a);
const dstr = iso => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso)); } catch { return null; } };
const tstr = iso => { try { return new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso)); } catch { return '?'; } };

function loadState() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } }
function saveState(s) { try { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s)); } catch {} }
function loadRouting() { try { const d = JSON.parse(fs.readFileSync(ROUTING, 'utf8')); const m = {}; for (const [t, v] of Object.entries(d.topics || {})) { const dir = (v.project_dir || '').replace(/\/+$/, ''); if (dir) m[t] = path.basename(dir); } return m; } catch { return {}; } }
const TOPIC_MAP = loadRouting();

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(b => b && b.type === 'text').map(b => b.text || '').join('\n');
  return '';
}
function cleanPrompt(t) {
  const thread = (String(t).match(/message_thread_id="(\d+)"/) || [])[1];
  let s = String(t).replace(/<channel[^>]*>/g, '').replace(/<\/channel>/g, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<ide_[^>]*>[\s\S]*?<\/ide_[^>]*>/g, '')
    .replace(/<persisted-output>[\s\S]*?<\/persisted-output>/g, '')
    .replace(/\s+/g, ' ').trim();
  return { text: s, thread };
}
function projectFromCwd(cwd) {
  if (!cwd) return null;
  const m = String(cwd).match(new RegExp('^' + PROJECTS_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/([^/]+)'));
  return m ? m[1] : null;
}

// ГРАНИЦА КОНТУРОВ. Сессии других людей (жена, знакомые — свои деревья в /root/projects_other/,
// свои Telegram-роутеры) НЕ должны попадать в память владельца: это чужие персональные данные.
// Баг до 2026-07-28: cwd проверялся как startsWith('/root/projects') БЕЗ слэша, поэтому
// '/root/projects_other/likholat_katrine' проходил фильтр как «своё дерево», projectFromCwd
// возвращал null → запись падала в общий буфер → classify раскладывал её по смыслу
// (психиатрия → my-psychologist, боты → vit). Здесь два независимых заслона.
const FOREIGN_TREES = (process.env.MEMKIT_FOREIGN_TREES || '/root/projects_other')
  .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
function isForeign(cwd, sessionDir) {
  // 1) по имени директории транскрипта: -root-projects-other-* (Claude Code кодирует cwd в имя)
  for (const t of FOREIGN_TREES) {
    const slug = t.replace(/^\//, '').replace(/[/_]/g, '-');        // /root/projects_other → root-projects-other
    if (sessionDir && String(sessionDir).replace(/_/g, '-').startsWith('-' + slug)) return true;
  }
  if (!cwd) return false;
  const c = String(cwd);
  // 2) по cwd: явные чужие деревья
  for (const t of FOREIGN_TREES) if (c === t || c.startsWith(t + '/')) return true;
  // 3) всё вне своего дерева/домашней/tmp (СО слэшем — иначе projects_other проходит как projects)
  return !(c === PROJECTS_DIR || c.startsWith(PROJECTS_DIR + '/') || c === H || c.startsWith('/tmp'));
}

function parseSession(file) {
  let q = [], a = [], files = new Set(), cwd = null, sid = null, first = null, last = null, threads = {};
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.sessionId && !sid) sid = d.sessionId;
    if (d.cwd && !cwd) cwd = d.cwd;
    if (d.timestamp) { if (!first) first = d.timestamp; last = d.timestamp; }
    if (d.type === 'user') {
      const raw = textOf(d.message && d.message.content);
      if (!raw) continue;
      const { text, thread } = cleanPrompt(raw);
      if (thread) threads[thread] = (threads[thread] || 0) + 1;
      if (text && !/^\s*$/.test(text) && !text.startsWith('Caveat:')) q.push(text.slice(0, Q_LEN));
    } else if (d.type === 'assistant') {
      const c = d.message && d.message.content;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type === 'text' && (b.text || '').length > 120) a.push(b.text.replace(/\s+/g, ' ').slice(0, A_LEN));
          if (b.type === 'tool_use' && /Write|Edit/i.test(b.name || '')) { const p = b.input && (b.input.file_path || b.input.path); if (p) files.add(p); }
        }
      }
    }
  }
  let thread = null, best = 0;
  for (const [t, n] of Object.entries(threads)) if (n > best) { best = n; thread = t; }
  return { sid, cwd, first, last, q, a, files: [...files], thread };
}


// Сессия Codex: session_meta (id, cwd) + response_item/message (user, assistant).
// Служебные вставки Codex и T3 (<environment_context>, AGENTS.md, картинки) отсекаются.
// sid — последние 8 hex id: начало UUIDv7 — это время, у соседних сессий оно совпадает.
const CODEX_NOISE = /^\s*(<[a-z_][\w -]*>|<\/?image|# AGENTS\.md instructions|\[Attached image)/i;
function parseCodexSession(file) {
  let q = [], a = [], files = new Set(), cwd = null, sid = null, first = null, last = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    const p = d.payload || {};
    if (d.timestamp) { if (!first) first = d.timestamp; last = d.timestamp; }
    if (d.type === 'session_meta') {
      if (!sid && p.id) sid = String(p.id).replace(/-/g, '').slice(-8);
      if (!cwd && p.cwd) cwd = p.cwd;
      continue;
    }
    if (d.type !== 'response_item') continue;
    if (p.type === 'message' && Array.isArray(p.content)) {
      for (const c of p.content) {
        const t = String(c.text || '');
        if (!t.trim()) continue;
        if (p.role === 'user' && c.type === 'input_text' && !CODEX_NOISE.test(t)) q.push(t.replace(/\s+/g, ' ').trim().slice(0, Q_LEN));
        if (p.role === 'assistant' && c.type === 'output_text' && t.length > 120) a.push(t.replace(/\s+/g, ' ').slice(0, A_LEN));
      }
    } else if (p.type === 'custom_tool_call' || p.type === 'function_call') {
      const body = String(p.input || p.arguments || '');
      for (const m of body.matchAll(/\*\*\* (?:Add|Update) File: ([^\n\\]+)/g)) files.add(m[1].trim());
    }
  }
  return { sid, cwd, first, last, q, a, files: [...files], thread: null, source: 'Codex' };
}
function listCodexSessions(dir) {
  const out = [];
  const walk = d => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (/^rollout-.*\.jsonl$/.test(e.name)) out.push(f); } };
  walk(dir);
  return out;
}

function blockOf(s, project) {
  const date = dstr(s.last) || dstr(s.first);
  const L = [`## ${date} — ${project} (${tstr(s.first)}–${tstr(s.last)}) [session ${String(s.sid || '').slice(0, 8)}]`];
  if (s.source) L.push(`**Модель:** ${s.source} (резервная, через T3)`);
  if (s.q.length) { L.push('**Вопросы/задачи:**'); s.q.slice(-MAX_Q).forEach(x => L.push('- ' + x)); }
  if (s.a.length) { L.push('**Ключевое из ответов:**'); s.a.slice(0, MAX_A).forEach(x => L.push('- ' + x)); }
  if (s.files.length) { L.push(`**Файлы (${s.files.length}):**`); s.files.slice(0, 10).forEach(f => L.push('- ' + f)); }
  L.push('');
  return L.join('\n');
}
function splitBlocks(md) { return md.split(/(?=^## \d{4}-\d{2}-\d{2})/m).filter(b => /^## \d{4}-\d{2}-\d{2}/.test(b)); }
function sidOf(b) { const m = b.match(/\[session ([0-9a-f]+)\]/); return m ? m[1] : null; }

function writeTo(target, blocks, label) {
  const dir = path.dirname(target); fs.mkdirSync(dir, { recursive: true });
  const hdr = `# Recent activity — ${label}, последние ${WINDOW_DAYS} дней (auto, из транскриптов)\n\n`;
  let ex = ''; try { ex = fs.readFileSync(target, 'utf8'); } catch {}
  if (!ex.startsWith('#')) ex = hdr + ex;
  const he = ex.indexOf('\n\n') + 2;
  const old = splitBlocks(ex.slice(he));
  const newSids = new Set(blocks.map(sidOf).filter(Boolean));
  const kept = old.filter(b => { const s = sidOf(b); return !s || !newSids.has(s); });   // старую версию сессии выкинуть
  const all = [...blocks, ...kept];
  // окно по дате
  const today = new Date();
  const fresh = all.filter(b => { const m = b.match(/^## (\d{4}-\d{2}-\d{2})/); if (!m) return true; return (today - new Date(m[1])) / 86400000 <= WINDOW_DAYS; });
  const capped = fresh.slice(0, MAX_BLOCKS);
  fs.writeFileSync(target, ex.slice(0, he) + capped.join('\n'));
  return capped.length;
}

function main() {
  log(`старт (dry=${DRY}, all=${ALL}${OWNER ? ', контур=' + OWNER : ''})`);
  const state = loadState();
  const byTarget = {};   // target file → blocks
  let scanned = 0, taken = 0;
  let dirs = []; try { dirs = fs.readdirSync(SRC); } catch { log('нет ' + SRC); return; }
  // В режиме --owner берём только директории сессий этого человека.
  if (OWNER) {
    const pref = ('-root-projects-other-' + OWNER).replace(/_/g, '-');
    dirs = dirs.filter(d => String(d).replace(/_/g, '-').startsWith(pref));
    if (!dirs.length) { log(`нет сессий контура ${OWNER}`); return; }
  }
  // Пары [файл, директория-сессии|null, парсер]: транскрипты Claude, затем сессии Codex.
  const sources = [];
  for (const d of dirs) {
    const dp = path.join(SRC, d);
    let files = []; try { files = fs.readdirSync(dp).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) sources.push([path.join(dp, f), d, parseSession]);
  }
  // Codex — только в режиме владельца: чужие контуры работают под своими пользователями.
  if (!OWNER) for (const f of listCodexSessions(CODEX_SESSIONS)) sources.push([f, null, parseCodexSession]);
  for (const [full, d, parse] of sources) {
    {
      scanned++;
      let st; try { st = fs.statSync(full); } catch { continue; }
      const key = full, mt = st.mtimeMs;
      if (!ALL && state[key] === mt) continue;                       // не менялся — пропуск
      let s; try { s = parse(full); } catch { continue; }
      const bulk = s.q.join(' ').length + s.a.join(' ').length;
      if (s.q.length < MIN_Q || bulk < MIN_CHARS) { state[key] = mt; continue; }   // служебная/пустая сессия
      const ageDays = (Date.now() - new Date(s.last || 0)) / 86400000;
      if (!ALL && ageDays > WINDOW_DAYS) { state[key] = mt; continue; }
      if (!OWNER && isForeign(s.cwd, d)) { state[key] = mt; continue; }   // чужой контур — в мою память НЕ попадает
      // проект: telegram-топик → cwd → общий
      // Чужой контур: подпроектов нет — всё в один буфер этого человека.
      let project = OWNER ? null
        : (s.thread && TOPIC_MAP[s.thread] && TOPIC_MAP[s.thread] !== 'root') ? TOPIC_MAP[s.thread] : projectFromCwd(s.cwd);
      let target, label;
      if (project && fs.existsSync(path.join(PROJECTS_DIR, project))) { target = path.join(PROJECTS_DIR, project, 'memory', 'activity', 'daily.md'); label = project; }
      else { target = path.join(ROOT_MEM, 'activity', 'daily.md'); label = OWNER || 'общий контур'; project = project || 'root'; }
      (byTarget[target] ||= { blocks: [], label }).blocks.push(blockOf(s, project));
      state[key] = mt; taken++;
    }
  }
  log(`просканировано ${scanned} транскриптов, свежих/новых сессий: ${taken}`);
  if (DRY) { for (const [t, v] of Object.entries(byTarget)) log(`  [dry] ${v.label}: +${v.blocks.length} → ${t}`); return; }
  for (const [t, v] of Object.entries(byTarget)) { const n = writeTo(t, v.blocks, v.label); log(`  ${v.label}: +${v.blocks.length} блоков (всего ${n}) → ${t}`); }
  saveState(state);
  log('готово');
}
main();
