// VS Code Live bridge — sessions registry scanner + per-topic state.
// Used by topic with mode="vscode_bridge" in routing.json.
//
// Sessions live as JSONL files under ~/.claude/projects/<slug>/<session_id>.jsonl
// where slug = projectDir with '/' and '_' replaced by '-'.
// We extract real cwd from the first JSONL line (each session writes a header
// record with cwd / timestamp / version).
//
// State persists in /root/.claude/channels/telegram/vscode_bridge.json as:
//   { "<chat_id>:<thread_id>": { session_id, project_dir, connected_at } }

const { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } = require('fs')
const { join, dirname } = require('path')
const { homedir } = require('os')

const SESSIONS_ROOT = join(homedir(), '.claude', 'projects')
const STATE_FILE = '/root/.claude/channels/telegram/vscode_bridge.json'

// ---- Sessions registry scanner ----

function readSessionMeta(jsonlPath) {
  try {
    // Read just enough to capture the first line. Files can be 100+ MB, do not
    // load the whole thing.
    const fd = require('fs').openSync(jsonlPath, 'r')
    const buf = Buffer.alloc(4096)
    const n = require('fs').readSync(fd, buf, 0, 4096, 0)
    require('fs').closeSync(fd)
    const head = buf.slice(0, n).toString('utf8')
    const firstLine = head.split('\n', 1)[0]
    if (!firstLine) return {}
    const obj = JSON.parse(firstLine)
    return {
      cwd: obj.cwd,
      timestamp: obj.timestamp,
      version: obj.version,
      type: obj.type,
    }
  } catch { return {} }
}

function slugToCwdGuess(slug) {
  // Best-effort: slug uses '-' for both '/' and '_', not invertible.
  // Used only as fallback when JSONL header is missing.
  return slug.replace(/^-/, '/').replace(/-/g, '/')
}

// Scan all sessions, return sorted by mtime desc, limited to `limit` entries.
function scanSessions(limit = 20) {
  const result = []
  let dirs = []
  try { dirs = readdirSync(SESSIONS_ROOT) } catch { return [] }
  for (const slug of dirs) {
    const dir = join(SESSIONS_ROOT, slug)
    let files = []
    try {
      files = readdirSync(dir).filter(f => f.endsWith('.jsonl'))
    } catch { continue }
    for (const f of files) {
      const fp = join(dir, f)
      try {
        const st = statSync(fp)
        const meta = readSessionMeta(fp)
        result.push({
          session_id: f.replace(/\.jsonl$/, ''),
          slug,
          cwd: meta.cwd || slugToCwdGuess(slug),
          size_bytes: st.size,
          mtime_ms: st.mtimeMs,
        })
      } catch {}
    }
  }
  result.sort((a, b) => b.mtime_ms - a.mtime_ms)
  return result.slice(0, limit)
}

// ---- State management ----

function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return {} }
}

function writeState(state) {
  try { mkdirSync(dirname(STATE_FILE), { recursive: true }) } catch {}
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

function bridgeKey(chatId, threadId) {
  return `${chatId}:${threadId == null ? 'general' : threadId}`
}

function getBridge(chatId, threadId) {
  const state = readState()
  return state[bridgeKey(chatId, threadId)] || null
}

function setBridge(chatId, threadId, sessionId, projectDir) {
  const state = readState()
  state[bridgeKey(chatId, threadId)] = {
    session_id: sessionId,
    project_dir: projectDir,
    connected_at: new Date().toISOString(),
  }
  writeState(state)
}

function clearBridge(chatId, threadId) {
  const state = readState()
  delete state[bridgeKey(chatId, threadId)]
  writeState(state)
}

// ---- Formatting helpers ----

function humanBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function relTime(ms) {
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 60) return `${s}с`
  if (s < 3600) return `${Math.floor(s / 60)}м`
  if (s < 86400) return `${Math.floor(s / 3600)}ч`
  return `${Math.floor(s / 86400)}д`
}

function projectShortName(cwd) {
  if (!cwd) return '(unknown)'
  const parts = cwd.split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : '/'
}

// Format /list output for Telegram. Returns plain text with code blocks.
function formatSessionsList(sessions) {
  if (sessions.length === 0) {
    return 'Нет сохранённых сессий в ~/.claude/projects/.'
  }
  const lines = ['**Сессии** (последняя активность):', '']
  sessions.forEach((s, i) => {
    const shortId = s.session_id.slice(0, 8)
    const proj = projectShortName(s.cwd)
    lines.push(`${i + 1}. \`${shortId}\` — **${proj}**`)
    lines.push(`   ${s.cwd}`)
    lines.push(`   ${humanBytes(s.size_bytes)} · ${relTime(s.mtime_ms)} назад`)
  })
  lines.push('')
  lines.push('Подключиться: `/connect <номер>` или `/connect <prefix>`')
  return lines.join('\n')
}

// Resolve user-typed identifier to a session.
// Accepts: index (1-based), session_id full or prefix (min 4 chars).
function resolveSessionByQuery(sessions, query) {
  if (!query) return { ok: false, error: 'Аргумент обязателен. Пример: `/connect 1`' }
  const q = String(query).trim()
  // try as 1-based index
  if (/^\d+$/.test(q)) {
    const idx = parseInt(q, 10)
    if (idx >= 1 && idx <= sessions.length) {
      return { ok: true, session: sessions[idx - 1] }
    }
    return { ok: false, error: `Номер ${idx} вне диапазона 1-${sessions.length}` }
  }
  // try as session_id prefix
  if (q.length < 4) {
    return { ok: false, error: 'Префикс session_id слишком короткий (минимум 4 символа)' }
  }
  const matches = sessions.filter(s => s.session_id.toLowerCase().startsWith(q.toLowerCase()))
  if (matches.length === 1) return { ok: true, session: matches[0] }
  if (matches.length > 1) {
    return { ok: false, error: `Неоднозначно — найдено ${matches.length} сессий с префиксом '${q}'. Уточни.` }
  }
  return { ok: false, error: `Сессия не найдена. Используй \`/list\` для списка.` }
}

module.exports = {
  scanSessions,
  readState,
  writeState,
  getBridge,
  setBridge,
  clearBridge,
  formatSessionsList,
  resolveSessionByQuery,
  projectShortName,
  STATE_FILE,
}
