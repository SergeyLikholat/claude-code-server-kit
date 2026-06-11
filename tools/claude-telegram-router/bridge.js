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
    const fsmod = require('fs')
    const fd = fsmod.openSync(jsonlPath, 'r')
    const meta = {}
    try {
      // 1) Scan first ~64 KB for header meta (cwd / slug / entrypoint).
      const headBuf = Buffer.alloc(65536)
      const headN = fsmod.readSync(fd, headBuf, 0, 65536, 0)
      const head = headBuf.slice(0, headN).toString('utf8')
      for (const line of head.split('\n')) {
        if (!line.trim()) continue
        let obj
        try { obj = JSON.parse(line) } catch { continue }
        if (!meta.cwd && obj.cwd) meta.cwd = obj.cwd
        if (!meta.slug && obj.slug) meta.slug = obj.slug
        if (!meta.entrypoint && obj.entrypoint) meta.entrypoint = obj.entrypoint
        if (!meta.timestamp && obj.timestamp) meta.timestamp = obj.timestamp
        if (!meta.version && obj.version) meta.version = obj.version
        if (obj.type === 'ai-title' && obj.aiTitle) meta.aiTitle = obj.aiTitle
        if (meta.cwd && meta.slug && meta.entrypoint && meta.aiTitle) break
      }
      // 2) If no aiTitle found in head, scan last ~256 KB — VS Code appends
      //    ai-title records over the session lifetime, latest one wins.
      if (!meta.aiTitle) {
        const stat = fsmod.fstatSync(fd)
        const tailSize = Math.min(262144, stat.size)
        if (tailSize > headN) {  // only worth tailing if there's content beyond head
          const tailBuf = Buffer.alloc(tailSize)
          const tailStart = stat.size - tailSize
          const tailN = fsmod.readSync(fd, tailBuf, 0, tailSize, tailStart)
          const tail = tailBuf.slice(0, tailN).toString('utf8')
          // Find latest ai-title record by scanning all matches.
          const lines = tail.split('\n')
          for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i]
            if (!line.includes('"type":"ai-title"')) continue
            try {
              const obj = JSON.parse(line)
              if (obj.type === 'ai-title' && obj.aiTitle) {
                meta.aiTitle = obj.aiTitle
                break
              }
            } catch {}
          }
        }
      }
    } finally {
      fsmod.closeSync(fd)
    }
    return meta
  } catch { return {} }
}

function slugToCwdGuess(slug) {
  // Best-effort: slug uses '-' for both '/' and '_', not invertible.
  // Used only as fallback when JSONL header is missing.
  return slug.replace(/^-/, '/').replace(/-/g, '/')
}

// Heuristic: identify claude-mem auto-spawned observer/memory-agent sessions.
function isAgentSession(s) {
  if (!s) return false
  if (s.cwd && (s.cwd.includes('/.claude-mem/') || s.cwd.includes('/observer-sessions') || s.cwd.includes('/claude-mem/observer'))) return true
  if (s.slug && (s.slug.includes('claude-mem') || s.slug.includes('observer-sessions'))) return true
  return false
}

// Scan all sessions, return sorted by mtime desc.
// opts: {
//   excludeTgRouted: bool (default true)
//   excludeAgents:   bool (default true) — hide claude-mem observer sessions
//   limit: number (default Infinity)
// }
function scanSessions(limitOrOpts = {}) {
  const opts = typeof limitOrOpts === 'number' ? { limit: limitOrOpts } : (limitOrOpts || {})
  const excludeTgRouted = opts.excludeTgRouted !== false  // default true
  const excludeAgents   = opts.excludeAgents   !== false  // default true
  const limit = opts.limit || Infinity
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
          project_slug: meta.slug,
          entrypoint: meta.entrypoint,
          ai_title: meta.aiTitle,        // VS Code Sidebar title (e.g. "Plan n8n stylist editor refactoring")
          size_bytes: st.size,
          mtime_ms: st.mtimeMs,
        })
      } catch {}
    }
  }
  result.sort((a, b) => b.mtime_ms - a.mtime_ms)
  let filtered = result
  if (excludeTgRouted) {
    const map = loadAllRoutingsMap()
    filtered = filtered.filter(s => !map[s.session_id])
  }
  if (excludeAgents) {
    filtered = filtered.filter(s => !isAgentSession(s))
  }
  return filtered.slice(0, limit)
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

// ---- Session display name: prefer routing.json mapping, then JSONL preview ----

// Routing-файлы, из которых нужно вытащить session_id уже занятых TG-топиков
// (чтобы /list скрывал их из общего списка VS Code сессий).
//
// Дефолт — основной + опциональный второй бот.
// Перекрыть можно через env TG_ROUTING_FILES (запятая-разделённый список):
//   TG_ROUTING_FILES=/root/.claude/channels/telegram/routing.json,/path/to/other.json
//
// Owner-метка для отображения в /list берётся либо из routing.json
// (поле `ux.owner`), либо из basename каталога файла (telegram → "bot1",
// telegram2 → "bot2"). Без хардкодa имён.
const TG_ROUTING_FILES = (process.env.TG_ROUTING_FILES || [
  '/root/.claude/channels/telegram/routing.json',
  '/root/.claude/channels/telegram2/routing.json',
].join(',')).split(',').filter(Boolean).map(p => ({ path: p.trim() }))

let _routingCache = null
let _routingCacheAt = 0
const ROUTING_CACHE_TTL_MS = 60 * 1000

function ownerFromPath(p) {
  // /root/.claude/channels/telegram/routing.json → "telegram"
  const m = p.match(/\/channels\/([^/]+)\//)
  return m ? m[1] : 'bot'
}

function loadAllRoutingsMap() {
  const now = Date.now()
  if (_routingCache && now - _routingCacheAt < ROUTING_CACHE_TTL_MS) return _routingCache
  const map = {}
  for (const r of TG_ROUTING_FILES) {
    try {
      const data = JSON.parse(readFileSync(r.path, 'utf8'))
      const owner = data.ux?.owner || ownerFromPath(r.path)
      if (data.general?.session_id) {
        map[data.general.session_id] = { name: 'General', owner }
      }
      for (const [thread, t] of Object.entries(data.topics || {})) {
        if (!t.session_id || t.session_id === '_BRIDGE_PLACEHOLDER_') continue
        map[t.session_id] = { name: t.name || `Topic ${thread}`, owner }
      }
    } catch {}
  }
  _routingCache = map
  _routingCacheAt = now
  return map
}

// Read first user-type message from JSONL (look for {type:"user"} or
// message.role==="user"). Returns short preview or null.
function readFirstUserPreview(jsonlPath, maxBytes = 32768) {
  try {
    const fd = require('fs').openSync(jsonlPath, 'r')
    const buf = Buffer.alloc(maxBytes)
    const n = require('fs').readSync(fd, buf, 0, maxBytes, 0)
    require('fs').closeSync(fd)
    const head = buf.slice(0, n).toString('utf8')
    for (const line of head.split('\n')) {
      if (!line.trim()) continue
      let obj
      try { obj = JSON.parse(line) } catch { continue }
      const role = obj.message?.role || obj.role || obj.type
      if (role !== 'user') continue
      const content = obj.message?.content || obj.content
      let txt = ''
      if (typeof content === 'string') {
        txt = content
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part === 'string') txt += part + ' '
          else if (part && typeof part.text === 'string') txt += part.text + ' '
        }
      }
      txt = txt.replace(/\s+/g, ' ').trim()
      // skip channel-tag system prompts (start with <channel ...> or look like meta)
      if (txt.startsWith('<channel ') || txt.startsWith('<system-reminder>')) {
        const after = txt.replace(/<[^>]+>/g, '').trim()
        if (!after) continue
        txt = after
      }
      if (txt.length > 80) txt = txt.slice(0, 77) + '...'
      return txt || null
    }
    return null
  } catch { return null }
}

// Pick an emoji based on where the session was launched from.
// Default — VS Code (🖥). Other entrypoints get specific emoji.
function pickEmoji(session) {
  const cwd = (session.cwd || '')
  const entrypoint = session.entrypoint || ''

  // Specific non-VSCode origins (rare cases)
  if (cwd.startsWith('/root/open-design'))          return '🎨'  // Open Design app
  if (entrypoint === 'sdk-cli' && cwd.includes('/.claude-mem')) return '🧠'  // claude-mem agent (usually filtered)
  // Telegram-bot-worker sessions are already filtered via routing.json mapping,
  // but if one leaks through, mark it:
  if (entrypoint === 'sdk-cli' && cwd === '/root')  return '✉️'  // TG worker (heuristic — TG bot spawns sdk-cli with cwd=/root)

  // Default: assume VS Code (this is the dominant case)
  return '🖥'
}

function sessionDisplayName(session) {
  const map = loadAllRoutingsMap()
  const sessionId = session.session_id || session
  if (map[sessionId]) {
    const r = map[sessionId]
    return `${r.name} (TG/${r.owner})`
  }
  // Priority: ai-title (matches VS Code Sidebar) > project_slug > cwd basename
  const emoji = pickEmoji(session)
  if (session.ai_title) {
    return `${emoji} ${session.ai_title}`
  }
  if (session.project_slug) {
    return `${emoji} ${session.project_slug}`
  }
  const cwd = session.cwd
  if (cwd === '/root' || !cwd) {
    return session.entrypoint === 'claude-vscode' ? `${emoji} VS Code` : 'home'
  }
  const parts = cwd.split('/').filter(Boolean)
  const tail = parts.length ? parts[parts.length - 1] : '/'
  return `${emoji} ${tail}`
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// Format /list output for Telegram with HTML parse_mode.
// opts: { page: number (1-based), perPage: number, totalCount: number, indexOffset: number }
function formatSessionsList(sessions, opts = {}) {
  if (sessions.length === 0) {
    return 'Нет VS Code сессий в <code>~/.claude/projects/</code> (TG-сессии скрыты).'
  }
  const map = loadAllRoutingsMap()
  const page = opts.page || 1
  const perPage = opts.perPage || sessions.length
  const totalCount = opts.totalCount || sessions.length
  const indexOffset = opts.indexOffset || 0
  const totalPages = Math.max(1, Math.ceil(totalCount / perPage))
  const lines = []
  lines.push(`<b>VS Code сессии</b> · стр. ${page}/${totalPages} · всего: ${totalCount}`)
  lines.push('')
  sessions.forEach((s, i) => {
    const name = escapeHtml(sessionDisplayName(s))
    const absIdx = indexOffset + i + 1
    lines.push(`<b>${absIdx}.</b> ${name}`)
    // Preview only when there's no ai-title and no claude-mem slug.
    if (!s.ai_title && !s.project_slug) {
      const jsonlPath = require('path').join(require('os').homedir(), '.claude', 'projects', s.slug, `${s.session_id}.jsonl`)
      const preview = readFirstUserPreview(jsonlPath, 131072)
      if (preview) {
        lines.push(`   <i>"${escapeHtml(preview)}"</i>`)
      }
    }
    // Hide cwd if /root (it's the default), otherwise show it.
    const cwdShown = (s.cwd && s.cwd !== '/root') ? `<code>${escapeHtml(s.cwd)}</code> · ` : ''
    lines.push(`   ${cwdShown}${humanBytes(s.size_bytes)} · ${relTime(s.mtime_ms)} назад`)
  })
  lines.push('')
  lines.push(`Подключиться: <code>/connect &lt;N&gt;</code> или <code>/connect &lt;prefix&gt;</code>`)
  if (totalPages > 1) {
    const nav = []
    if (page > 1) nav.push(`<code>/list ${page - 1}</code>`)
    if (page < totalPages) nav.push(`<code>/list ${page + 1}</code>`)
    if (nav.length) lines.push(`Страницы: ${nav.join(' · ')}`)
  }
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

// Build inline keyboard with:
//   row 0..1 — session selector buttons (numbers, 5 per row), absolute index over all pages
//   row last — page navigation
// opts: { includeAgents, slice, indexOffset } — slice is the visible page of sessions.
function buildPageKeyboard(page, totalPages, opts = {}) {
  const prefix = opts.includeAgents ? 'list-all' : 'list'
  const slice = opts.slice || []
  const indexOffset = opts.indexOffset || 0
  const rows = []
  // Selector buttons (5 per row), absolute number = indexOffset + localIdx + 1
  const perRow = 5
  for (let i = 0; i < slice.length; i += perRow) {
    const row = []
    for (let j = 0; j < perRow && i + j < slice.length; j++) {
      const s = slice[i + j]
      const absNum = indexOffset + i + j + 1
      row.push({ text: String(absNum), callback_data: `con:${s.session_id}` })
    }
    rows.push(row)
  }
  // Navigation row (only if >1 page)
  if (totalPages > 1) {
    const nav = []
    if (page > 1)          nav.push({ text: '« 1',     callback_data: `${prefix}:page=1` })
    if (page > 1)          nav.push({ text: '‹',       callback_data: `${prefix}:page=${page - 1}` })
    nav.push({ text: `${page}/${totalPages}`, callback_data: `${prefix}:noop` })
    if (page < totalPages) nav.push({ text: '›',       callback_data: `${prefix}:page=${page + 1}` })
    if (page < totalPages) nav.push({ text: `${totalPages} »`, callback_data: `${prefix}:page=${totalPages}` })
    rows.push(nav)
  }
  if (rows.length === 0) return null
  return { inline_keyboard: rows }
}

// Build the /list page payload for a given page number. Used by both
// the initial /list command and by callback_query handlers.
// opts: { includeAgents: bool }
function buildListPage(page = 1, perPage = 10, opts = {}) {
  const includeAgents = !!opts.includeAgents
  const all = scanSessions({
    excludeTgRouted: true,
    excludeAgents: !includeAgents,
    limit: 5000,
  })
  const totalCount = all.length
  const totalPages = Math.max(1, Math.ceil(totalCount / perPage))
  if (page > totalPages) page = totalPages
  if (page < 1) page = 1
  const offset = (page - 1) * perPage
  const slice = all.slice(offset, offset + perPage)
  const text = formatSessionsList(slice, { page, perPage, totalCount, indexOffset: offset })
  const reply_markup = buildPageKeyboard(page, totalPages, { includeAgents, slice, indexOffset: offset })
  return { text, reply_markup, page, totalPages, slice }
}

// Quick-action keyboard shown under "🟢 Подключено" message.
function buildConnectedKeyboard() {
  return {
    inline_keyboard: [[
      { text: '📋 Сменить',     callback_data: 'quick:list' },
      { text: 'ℹ Статус',       callback_data: 'quick:status' },
      { text: '⏹ Отвязать',    callback_data: 'quick:disconnect' },
    ]],
  }
}

// Quick-action keyboard shown under "⚪ Отключено" message.
function buildDisconnectedKeyboard() {
  return {
    inline_keyboard: [[
      { text: '📋 Список сессий', callback_data: 'quick:list' },
      { text: 'ℹ Статус',         callback_data: 'quick:status' },
    ]],
  }
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
  pickEmoji,
  buildPageKeyboard,
  buildListPage,
  buildConnectedKeyboard,
  buildDisconnectedKeyboard,
  STATE_FILE,
}
