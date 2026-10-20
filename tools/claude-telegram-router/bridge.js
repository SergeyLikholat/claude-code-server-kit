// VS Code Live bridge — sessions registry scanner + per-topic state.
// Used by topic with mode="vscode_bridge" in routing.json.
//
// Sessions live as JSONL files under ~/.claude/projects/<slug>/<session_id>.jsonl
// where slug = projectDir with '/' and '_' replaced by '-'.
// We extract real cwd from the first JSONL line (each session writes a header
// record with cwd / timestamp / version).
//
// State persists in <STATE_DIR>/vscode_bridge.json as:
//   { "<chat_id>:<thread_id>": { session_id, project_dir, connected_at } }
//
// Everything user-specific here (state file, which sessions are visible, whose
// routing tables are consulted) resolves from env, so a second router instance
// serving a DIFFERENT person shares no state with this one. Defaults reproduce
// router1 (владелец) behaviour exactly.

const { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } = require('fs')
const { join, dirname } = require('path')
const { homedir } = require('os')
const modelMod = require('./model')
const { STATE_DIR } = require('./access')

const SESSIONS_ROOT = join(homedir(), '.claude', 'projects')
const STATE_FILE = process.env.TG_BRIDGE_STATE_FILE || join(STATE_DIR, 'vscode_bridge.json')

// Session visibility scope for /list. Both are CSV lists of path prefixes,
// matched against the session cwd and its slug form.
//   TG_SESSIONS_INCLUDE_PREFIX — whitelist; empty = "everything not excluded"
//   TG_SESSIONS_EXCLUDE_PREFIX — blacklist; default hides other people's trees
function envPrefixList(name, fallback) {
  const raw = process.env[name]
  const src = raw === undefined ? fallback : raw
  return String(src).split(',').map(s => s.trim()).filter(Boolean)
}

const SESSIONS_INCLUDE = envPrefixList('TG_SESSIONS_INCLUDE_PREFIX', '')
const SESSIONS_EXCLUDE = envPrefixList('TG_SESSIONS_EXCLUDE_PREFIX', '/root/projects_other')

// Как называется этот режим в текстах для пользователя. У владельца топик привязан
// к VS Code, у других пользователей VS Code нет — там уместнее «Беседы».
const BRIDGE_LABEL = process.env.TG_BRIDGE_LABEL || 'VS Code Live'

// Slug form of a path prefix — claude-code replaces every non-alphanumeric char
// with '-', so a prefix match on the slug also catches sessions whose JSONL
// header carries no cwd and only the directory name is known.
function slugPrefix(p) {
  return String(p).replace(/[^a-zA-Z0-9]/g, '-')
}

function isSessionInScope(s) {
  const cwd = String(s.cwd || '')
  const slug = String(s.slug || '')
  const matches = (p) => cwd.startsWith(p) || slug.startsWith(slugPrefix(p))
  if (SESSIONS_INCLUDE.length && !SESSIONS_INCLUDE.some(matches)) return false
  if (SESSIONS_EXCLUDE.some(matches)) return false
  return true
}

// ---- Sessions registry scanner ----

// Cheap pre-filter before JSON.parse. Two writers produce these JSONL files and
// they disagree on spacing: the VS Code extension emits compact `{"type":"user"`
// while headless turns (Telegram plugin daemon, `claude --print`) emit
// `{"type": "user"`. Matching only the compact form silently skipped every
// headless session.
function hasType(line, type) {
  return line.includes(`"type":"${type}"`) || line.includes(`"type": "${type}"`)
}

// Plain text of a `user` JSONL record, or null when the record is machinery
// rather than something a person typed — tool results, interrupt markers,
// background task notifications, resume stubs. Those must never become a
// session name.
const NON_PROMPT_PREFIXES = [
  '[Request interrupted',
  'Continue from where you left off',
  '<task-notification',
  '<local-command',
  '<command-name',
]
function userRecordText(obj) {
  const content = obj && obj.message && obj.message.content
  let txt = ''
  if (typeof content === 'string') {
    txt = content
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'string') txt += `${part} `
      else if (part && part.type === 'text' && typeof part.text === 'string') txt += `${part.text} `
    }
  }
  txt = txt.trim()
  if (!txt) return null
  if (NON_PROMPT_PREFIXES.some(p => txt.startsWith(p))) return null
  return txt
}

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
        if (obj.type === 'custom-title' && obj.customTitle) meta.customTitle = obj.customTitle
        if (obj.type === 'last-prompt' && obj.lastPrompt) meta.lastPrompt = obj.lastPrompt
        if (meta.cwd && meta.slug && meta.entrypoint && meta.aiTitle && meta.customTitle) break
      }
      // 2) If no title found in head, scan last ~256 KB — VS Code appends
      //    ai-title / custom-title / last-prompt records over the session
      //    lifetime, latest wins. last-prompt matters because an untitled
      //    session is labelled by its latest prompt in the VS Code Sidebar —
      //    mirror that here or the same session carries two different names.
      if (!meta.aiTitle || !meta.customTitle || !meta.lastPrompt) {
        const stat = fsmod.fstatSync(fd)
        // 256 KB covers almost every session. A handful of big ones push the
        // last title/prompt record just past that window (a single tool result
        // can be hundreds of KB), so escalate once to 2 MB rather than
        // mislabelling the session — the second read only happens for sessions
        // the cheap pass failed on.
        for (const window of [262144, 2097152]) {
          const tailSize = Math.min(window, stat.size)
          if (tailSize <= headN) break  // nothing beyond the head block
          const tailBuf = Buffer.alloc(tailSize)
          const tailStart = stat.size - tailSize
          const tailN = fsmod.readSync(fd, tailBuf, 0, tailSize, tailStart)
          const tail = tailBuf.slice(0, tailN).toString('utf8')
          // Find latest ai-title / custom-title / last-prompt records by
          // scanning backwards — first hit going backwards IS the latest.
          const lines = tail.split('\n')
          for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i]
            const isAi = !meta.aiTitle && hasType(line, 'ai-title')
            const isCustom = !meta.customTitle && hasType(line, 'custom-title')
            const isPrompt = !meta.lastPrompt && hasType(line, 'last-prompt')
            // Headless turns (Telegram plugin daemon, `claude --print`) write a
            // last-prompt record that carries only a leafUuid, no text. Falling
            // back to the newest user turn reconstructs the same label.
            const isUser = !meta.lastPrompt && !meta.lastUserText && hasType(line, 'user')
            if (!isAi && !isCustom && !isPrompt && !isUser) continue
            try {
              const obj = JSON.parse(line)
              if (isAi && obj.type === 'ai-title' && obj.aiTitle) meta.aiTitle = obj.aiTitle
              if (isCustom && obj.type === 'custom-title' && obj.customTitle) meta.customTitle = obj.customTitle
              if (isPrompt && obj.type === 'last-prompt' && obj.lastPrompt) meta.lastPrompt = obj.lastPrompt
              if (isUser && obj.type === 'user') {
                const txt = userRecordText(obj)
                if (txt) meta.lastUserText = txt
              }
            } catch {}
            if (meta.aiTitle && meta.customTitle && meta.lastPrompt) break
          }
          // A name is all we need — stop as soon as the session has one.
          if (meta.customTitle || meta.aiTitle || meta.lastPrompt || meta.lastUserText) break
          if (tailSize >= stat.size) break  // whole file already scanned
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

// Heuristic: identify auto-spawned/background utility sessions that should not
// be shown in /list (claude-mem observers, context-mgr workers, etc).
function isAgentSession(s) {
  if (!s) return false
  const cwd = s.cwd || ''
  const slug = s.slug || ''
  // claude-mem observer sessions
  if (cwd.includes('/.claude-mem/') || cwd.includes('/observer-sessions') || cwd.includes('/claude-mem/observer')) return true
  if (slug.includes('claude-mem') || slug.includes('observer-sessions')) return true
  // context-mgr utility sessions (background TG-history compressors etc)
  if (cwd.includes('/_infra/context-mgr') || cwd.includes('/.infra/context-mgr')) return true
  if (cwd.endsWith('/context-mgr')) return true
  // Разовые прогоны `claude --print`: проверка гипотезы, замер поведения CLI,
  // отладка хука. Это не диалоги, но на диске они лежат такими же сессиями и
  // всплывали в /list вперемешку с рабочими — список превращался в кашу, а в
  // Sidebar их не было, потому что VS Code показывает только открытый проект.
  // Договорённость: такие прогоны живут в песочнице и в список не попадают.
  if (cwd.includes('/claude-ops/sandbox') || slug.includes('claude-ops-sandbox')) return true
  // Временные каталоги сессий (scratchpad Claude Code, /tmp) — тоже не диалоги.
  if (cwd.startsWith('/tmp/') || slug.startsWith('-tmp-')) return true
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
          ai_title: meta.aiTitle,        // VS Code Sidebar auto-title (e.g. "Plan n8n stylist editor refactoring")
          custom_title: meta.customTitle, // manual rename from the VS Code Sidebar — wins over ai_title
          // latest user prompt — what the Sidebar shows for untitled sessions.
          // lastUserText is the reconstruction for headless turns, whose
          // last-prompt record stores only a leafUuid.
          last_prompt: meta.lastPrompt || meta.lastUserText,
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
  // Показывать только рабочие пространства ЭТОГО пользователя. Для router1 это
  // «всё, кроме /root/projects_other/*» (боты user3, router2); для router2 —
  // наоборот, только /root/projects_other/user2. Задаётся env.
  filtered = filtered.filter(isSessionInScope)
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

// Model context limits in tokens. Sonnet 4.x and Opus 4.x = 1M; Haiku 4.x = 200K.
function getModelLimit(modelName) {
  if (!modelName) return 1_000_000
  const m = modelName.toLowerCase()
  if (m.includes('haiku')) return 200_000
  return 1_000_000
}

// Read the last assistant `usage` block from the JSONL — this is the authoritative
// metric Claude itself reports for the conversation's working-context size.
// Returns null if no assistant message with usage exists yet.
function getSessionContextUsage(jsonlPath) {
  const fs = require('fs')
  try {
    const stat = fs.statSync(jsonlPath)
    // Scan last ~512KB — recent assistant messages live near the end.
    const tailSize = Math.min(512 * 1024, stat.size)
    const fd = fs.openSync(jsonlPath, 'r')
    let tail
    try {
      const buf = Buffer.alloc(tailSize)
      const n = fs.readSync(fd, buf, 0, tailSize, stat.size - tailSize)
      tail = buf.slice(0, n).toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
    const lines = tail.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line.includes('"usage"')) continue
      if (!line.includes('"type":"assistant"')) continue
      try {
        const obj = JSON.parse(line)
        const usage = obj.message?.usage
        if (!usage) continue
        const input = usage.input_tokens || 0
        const cacheRead = usage.cache_read_input_tokens || 0
        const cacheCreate = usage.cache_creation_input_tokens || 0
        const total = input + cacheRead + cacheCreate
        if (total === 0) continue
        const model = obj.message?.model
        const limit = getModelLimit(model)
        const percent = Math.round((total / limit) * 100)
        return { tokens: total, limit, percent, model }
      } catch {}
    }
    return null
  } catch { return null }
}

// Visual context-usage tier — based on actual tokens reported by Anthropic API.
// Mirrors VS Code Claude's own "context too full, /compact?" hint.
function contextUsageTier(percent) {
  if (percent == null)      return { emoji: '⚪', label: 'unknown', needsCompact: false }
  if (percent < 50)         return { emoji: '🟢', label: 'lite', needsCompact: false }
  if (percent < 70)         return { emoji: '🟡', label: 'warm', needsCompact: false }
  if (percent < 85)         return { emoji: '🟠', label: 'high', needsCompact: false }
  return { emoji: '🔴', label: 'critical', needsCompact: true }
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

// Routing tables consulted to label a session as "already owned by a TG topic".
// Format: CSV of "path:owner". Each router should list only the tables whose
// topic names its own user is allowed to see — otherwise /list leaks another
// person's topic names.
const TG_ROUTING_FILES = (
  process.env.TG_ROUTING_FILES ||
  '/root/.claude/channels/telegram/routing.json:владелец,/root/.claude/channels/telegram2/routing.json:router2'
)
  .split(',')
  .map(entry => entry.trim())
  .filter(Boolean)
  .map(entry => {
    const idx = entry.lastIndexOf(':')
    return idx > 0
      ? { path: entry.slice(0, idx), owner: entry.slice(idx + 1) }
      : { path: entry, owner: '?' }
  })

let _routingCache = null
let _routingCacheAt = 0
const ROUTING_CACHE_TTL_MS = 60 * 1000

function loadAllRoutingsMap() {
  const now = Date.now()
  if (_routingCache && now - _routingCacheAt < ROUTING_CACHE_TTL_MS) return _routingCache
  const map = {}
  for (const r of TG_ROUTING_FILES) {
    try {
      const data = JSON.parse(readFileSync(r.path, 'utf8'))
      if (data.general?.session_id) {
        map[data.general.session_id] = { name: 'General', owner: r.owner }
      }
      for (const [thread, t] of Object.entries(data.topics || {})) {
        if (!t.session_id || t.session_id === '_BRIDGE_PLACEHOLDER_') continue
        map[t.session_id] = { name: t.name || `Topic ${thread}`, owner: r.owner }
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

// Turn a raw `last-prompt` record into a one-line session label. The stored
// prompt still carries the machinery the harness wrapped around it — the
// <channel …> envelope Telegram adds, system-reminder blocks, slash-command
// wrappers — none of which belong in a session name.
const TITLE_MAX_LEN = 60
function cleanPromptForTitle(raw) {
  if (!raw || typeof raw !== 'string') return null
  const txt = raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/<command-(message|name|args)>[\s\S]*?<\/command-\1>/g, ' ')
    .replace(/<channel[^>]*>/g, ' ')
    .replace(/<\/?[a-z-]+>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!txt) return null
  return txt.length > TITLE_MAX_LEN ? `${txt.slice(0, TITLE_MAX_LEN - 3)}...` : txt
}

function sessionDisplayName(session) {
  const map = loadAllRoutingsMap()
  const sessionId = session.session_id || session
  if (map[sessionId]) {
    const r = map[sessionId]
    return `${r.name} (TG/${r.owner})`
  }
  // Priority: custom-title > ai-title > last-prompt > project_slug > cwd basename.
  // This is exactly the VS Code Sidebar's own order — a manual rename wins over
  // the auto-title, and an untitled session is labelled by its latest prompt.
  // Deviating here is what made the same session carry two different names in
  // the two lists.
  const emoji = pickEmoji(session)
  if (session.custom_title) {
    return `${emoji} ${session.custom_title}`
  }
  if (session.ai_title) {
    return `${emoji} ${session.ai_title}`
  }
  const prompt = cleanPromptForTitle(session.last_prompt)
  if (prompt) {
    return `${emoji} ${prompt}`
  }
  if (session.project_slug) {
    return `${emoji} ${session.project_slug}`
  }
  const cwd = session.cwd
  if (cwd === '/root' || !cwd) {
    if (session.entrypoint === 'claude-vscode') return `${emoji} VS Code`
    // Anything else with cwd=/root and no title — most likely a fresh session
    // created from Telegram (sdk-cli entrypoint). Show as "Новая (TG)" so it's
    // distinguishable from VS Code-launched ones.
    return `📱 Новая (TG)`
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
    return `Нет доступных сессий «${BRIDGE_LABEL}» (сессии, уже привязанные к топикам, скрыты).`
  }
  const map = loadAllRoutingsMap()
  const page = opts.page || 1
  const perPage = opts.perPage || sessions.length
  const totalCount = opts.totalCount || sessions.length
  const indexOffset = opts.indexOffset || 0
  const totalPages = Math.max(1, Math.ceil(totalCount / perPage))
  const lines = []
  lines.push(`<b>Сессии · ${BRIDGE_LABEL}</b> · стр. ${page}/${totalPages} · всего: ${totalCount}`)
  lines.push('')
  // Each session is one <blockquote> card: title in regular font, metrics in
  // monospace <code>. Separators between cards are plain unicode lines.
  const SEPARATOR = '─────────'
  sessions.forEach((s, i) => {
    const name = sessionDisplayName(s)
    const absIdx = indexOffset + i + 1
    if (i > 0) lines.push(SEPARATOR)
    const blockLines = []
    blockLines.push(`${escapeHtml(`${absIdx}. ${name}`)}`)
    if (!s.custom_title && !s.ai_title && !s.last_prompt && !s.project_slug) {
      const jsonlPath = require('path').join(require('os').homedir(), '.claude', 'projects', s.slug, `${s.session_id}.jsonl`)
      const preview = readFirstUserPreview(jsonlPath, 131072)
      if (preview) {
        blockLines.push(escapeHtml(`"${preview}"`))
      }
    }
    const cwdShown = (s.cwd && s.cwd !== '/root') ? `${s.cwd} · ` : ''
    const jsonlPath = require('path').join(require('os').homedir(), '.claude', 'projects', s.slug, `${s.session_id}.jsonl`)
    const usage = getSessionContextUsage(jsonlPath)
    const tier = contextUsageTier(usage?.percent)
    // Show the model only when the session is explicitly pinned — sessions on
    // the global default stay quiet so the list doesn't turn into noise.
    const modelBadge = modelMod.badgeFor(s.session_id)
    const modelPart = modelBadge ? `🧠 ${modelBadge} · ` : ''
    const metricsText = `${tier.emoji} ${cwdShown}${modelPart}${usage ? `${usage.percent}% · ` : ''}${humanBytes(s.size_bytes)} · ${relTime(s.mtime_ms)} назад`
    blockLines.push(`<code>${escapeHtml(metricsText)}</code>`)
    lines.push(`<blockquote>${blockLines.join('\n')}</blockquote>`)
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
  // Top row — "new session" shortcut (always visible, like "+ New session" in VS Code Sidebar)
  rows.push([{ text: '➕ Новая сессия', callback_data: 'quick:new' }])
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

// Quick-action keyboard shown under "🟢 Подключено" message (for existing sessions).
function buildConnectedKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📥 Свежий ответ', callback_data: 'quick:pull' }],
      [
        { text: '📋 Сменить', callback_data: 'quick:list' },
        { text: '🧠 Модель',  callback_data: 'model:__show' },
      ],
      [{ text: '➕ Новая сессия', callback_data: 'quick:new' }],
    ],
  }
}

// Keyboard for "🟢 Новая сессия создана" — no pull button, no status.
function buildFreshConnectedKeyboard() {
  return {
    inline_keyboard: [[
      { text: '📋 Сменить', callback_data: 'quick:list' },
      { text: '🧠 Модель',  callback_data: 'model:__show' },
    ]],
  }
}

// Extract a textual content string from an assistant message record.
// Returns the text content joined; returns '' if no text parts.
function extractAssistantText(obj) {
  if (!obj) return ''
  const content = obj.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const part of content) {
    if (part && part.type === 'text' && typeof part.text === 'string') {
      out += (out ? '\n' : '') + part.text
    }
  }
  return out
}

// Assistant text records that are runtime artifacts, not something the user
// should ever see in Telegram:
//   - no-op fillers a turn emits when it has nothing to say
//   - raw API/transport errors — closeStatus() already surfaces these as a
//     human-readable notice, so forwarding them duplicates the message
//   - interrupt markers
// Skipping these is what keeps "nothing to report" turns silent instead of
// posting 'No response requested.' into the topic.
const INTERNAL_ARTIFACT_PATTERNS = [
  /^no response (requested|needed)\.?$/i,
  /^\(?\s*no response\s*\)?\.?$/i,
  /^api error:/i,
  /^\[?request interrupted/i,
  /^execution error\b/i,
  /^\(no content\)$/i,
]

function isInternalArtifact(text) {
  const t = String(text || '').trim()
  if (!t) return true
  return INTERNAL_ARTIFACT_PATTERNS.some((re) => re.test(t))
}

// Distinguish artifact kinds. 'api_error' is filtered from the chat like the
// rest, but it is *signal*, not noise — the caller has to make sure the user
// still learns that Anthropic failed, just without the raw duplicate.
function artifactKind(text) {
  const t = String(text || '').trim()
  if (!t) return 'empty'
  if (/^api error:/i.test(t)) return 'api_error'
  if (!isInternalArtifact(t)) return null
  return 'noop'
}

// Find the latest assistant message with textual content in the JSONL.
// Returns { uuid, text, timestamp, hasActivityAfter, isStreaming } or null.
//   hasActivityAfter — true if there are user/tool_use records after this assistant
//                      (means a new turn is being processed)
//   isStreaming      — true if the file mtime is within 30s (means actively writing)
function findLastAssistantMessage(jsonlPath) {
  const fsmod = require('fs')
  try {
    const stat = fsmod.statSync(jsonlPath)
    const sizeNow = stat.size
    const mtimeMs = stat.mtimeMs
    const isStreaming = (Date.now() - mtimeMs) < 30_000

    // Read last ~2 MB or whole file if smaller. Claude per-turn JSONL records
    // are usually <100 KB each, so 2 MB covers many recent turns.
    const tailSize = Math.min(2 * 1024 * 1024, sizeNow)
    const fd = fsmod.openSync(jsonlPath, 'r')
    let tail
    try {
      const buf = Buffer.alloc(tailSize)
      const n = fsmod.readSync(fd, buf, 0, tailSize, sizeNow - tailSize)
      tail = buf.slice(0, n).toString('utf8')
    } finally {
      fsmod.closeSync(fd)
    }
    // If we read mid-line at the start, drop the first (probably-broken) line.
    if (sizeNow > tailSize) {
      const nl = tail.indexOf('\n')
      if (nl >= 0) tail = tail.slice(nl + 1)
    }
    const lines = tail.split('\n')

    // Scan from end to find the latest assistant with text.
    let lastAssistantIdx = -1
    let lastAssistantObj = null
    let lastAssistantText = ''
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line.includes('"type":"assistant"')) continue
      let obj
      try { obj = JSON.parse(line) } catch { continue }
      if (obj.type !== 'assistant') continue
      const text = extractAssistantText(obj)
      if (!text) continue
      // Keep scanning past runtime artifacts. If the turn produced nothing but
      // artifacts we land on an older real message, whose uuid then matches
      // last_pulled_uuid — so the caller stays silent rather than posting noise.
      if (isInternalArtifact(text)) continue
      lastAssistantIdx = i
      lastAssistantObj = obj
      lastAssistantText = text
      break
    }
    if (!lastAssistantObj) return { uuid: null, text: null, isStreaming, hasActivityAfter: false }

    // hasActivityAfter — does any line after lastAssistantIdx contain user/tool_use?
    let hasActivityAfter = false
    for (let j = lastAssistantIdx + 1; j < lines.length; j++) {
      const l = lines[j]
      if (!l.trim()) continue
      if (l.includes('"type":"user"') || l.includes('"type":"tool_use"')) {
        hasActivityAfter = true
        break
      }
    }

    return {
      uuid: lastAssistantObj.uuid || null,
      text: lastAssistantText,
      timestamp: lastAssistantObj.timestamp || null,
      hasActivityAfter,
      isStreaming,
    }
  } catch (err) {
    return { uuid: null, text: null, isStreaming: false, hasActivityAfter: false, error: err.message }
  }
}

// Collect assistant text records written at/after `sinceIso` that aren't in
// `skipUuids`, oldest-first. Used to stream in-progress narration to Telegram
// while a bridged worker is still running.
//
// The timestamp gate (not a uuid cursor) is deliberate: the tail-read window
// may not reach the turn's first record on very large sessions, and a missing
// cursor would otherwise dump the whole window.
function findAssistantMessagesAfter(jsonlPath, sinceIso, skipUuids) {
  const fsmod = require('fs')
  const out = []
  try {
    const stat = fsmod.statSync(jsonlPath)
    const sizeNow = stat.size
    const tailSize = Math.min(2 * 1024 * 1024, sizeNow)
    const fd = fsmod.openSync(jsonlPath, 'r')
    let tail
    try {
      const buf = Buffer.alloc(tailSize)
      const n = fsmod.readSync(fd, buf, 0, tailSize, sizeNow - tailSize)
      tail = buf.slice(0, n).toString('utf8')
    } finally {
      fsmod.closeSync(fd)
    }
    // Drop a possibly-truncated first line when we didn't read from offset 0.
    if (sizeNow > tailSize) {
      const nl = tail.indexOf('\n')
      if (nl >= 0) tail = tail.slice(nl + 1)
    }
    for (const line of tail.split('\n')) {
      if (!line.includes('"type":"assistant"')) continue
      let obj
      try { obj = JSON.parse(line) } catch { continue }   // partial trailing write
      if (obj.type !== 'assistant') continue
      const uuid = obj.uuid
      if (!uuid || (skipUuids && skipUuids.has(uuid))) continue
      const ts = obj.timestamp
      if (!ts || ts < sinceIso) continue
      const text = extractAssistantText(obj)
      if (!text) continue
      // Return artifacts too, tagged — the caller drops noise but still has to
      // react to 'api_error'. Filtering them out here would hide the failure.
      out.push({ uuid, text, timestamp: ts, kind: artifactKind(text) })
    }
  } catch (err) {
    return out
  }
  return out
}

// Convert Claude-style Markdown to Telegram HTML, safely handling code blocks
// (so ** inside code doesn't become bold). Supports:
//   ```lang\n...code...``` → <pre><code class="language-lang">...</code></pre>
//   `code` → <code>code</code>
//   **bold** → <b>bold</b>
//   *italic* / _italic_ → <i>...</i>
//   [text](url) → <a href="url">text</a>
function markdownToTelegramHtml(input) {
  if (!input) return ''
  // Step 1: extract fenced code blocks first, replace with placeholders so
  // inline conversions don't touch their content.
  const fences = []
  let text = input.replace(/```(\w*)\n?([\s\S]*?)```/g, (m, lang, code) => {
    const idx = fences.length
    fences.push({ lang, code })
    return `FENCE${idx}`
  })
  // Step 2: extract inline code so ** inside `` doesn't get bolded.
  const inlines = []
  text = text.replace(/`([^`\n]+)`/g, (m, code) => {
    const idx = inlines.length
    inlines.push(code)
    return `INLINE${idx}`
  })
  // Step 3: HTML-escape the remaining text (before adding our own tags).
  text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  // Step 4: Markdown headers (line-based) — emulate via decoration + bold.
  //   # H1   → ━━━ HEADER ━━━ (UPPER)
  //   ## H2  → ▎ Header
  //   ### H3 → ▸ Header
  //   ####+  → plain bold
  text = text.replace(/^(#{1,6})\s+(.+?)\s*$/gm, (m, hashes, content) => {
    const level = hashes.length
    if (level === 1) return `<b>━━━ ${content.toUpperCase()} ━━━</b>`
    if (level === 2) return `<b>▎ ${content}</b>`
    if (level === 3) return `<b>▸ ${content}</b>`
    return `<b>${content}</b>`
  })
  // Step 5: links — [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    const u = url.replace(/"/g, '%22')
    return `<a href="${u}">${label}</a>`
  })
  // Step 6: bold (**...** must come before *italic* to avoid conflict).
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
  // Step 6: italic — single * or _ around non-empty text
  text = text.replace(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/g, '<i>$1</i>')
  text = text.replace(/(?<![_\w])_([^_\n]+)_(?![_\w])/g, '<i>$1</i>')
  // Step 7: restore inline code (escape its content)
  text = text.replace(/INLINE(\d+)/g, (m, idx) => {
    const code = inlines[Number(idx)]
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    return `<code>${code}</code>`
  })
  // Step 8: restore fenced code blocks
  text = text.replace(/FENCE(\d+)/g, (m, idx) => {
    const { lang, code } = fences[Number(idx)]
    const escaped = code
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    if (lang) {
      return `<pre><code class="language-${lang}">${escaped}</code></pre>`
    }
    return `<pre>${escaped}</pre>`
  })
  return text
}

// Update the last_pulled_uuid for a bridge.
function setLastPulledUuid(chatId, threadId, uuid) {
  const state = readState()
  const key = bridgeKey(chatId, threadId)
  if (!state[key]) return
  state[key].last_pulled_uuid = uuid
  state[key].last_pulled_at = new Date().toISOString()
  writeState(state)
}

// Quick-action keyboard shown under "⚪ Отключено" message.
function buildDisconnectedKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '➕ Новая сессия', callback_data: 'quick:new' }],
      [
        { text: '📋 Список сессий', callback_data: 'quick:list' },
        { text: 'ℹ Статус',         callback_data: 'quick:status' },
      ],
    ],
  }
}

// Compact "floating control panel" shown at the bottom of the bridged topic
// after every Claude turn — gives quick access to switch session or disconnect
// without scrolling back up to the "🟢 Подключено" message.
function buildModelCardKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🧠 Изменить модель', callback_data: 'model:__show' }],
      [
        { text: '📋 Сменить',      callback_data: 'quick:list' },
        { text: '📥 Свежий ответ', callback_data: 'quick:pull' },
      ],
    ],
  }
}

// Percent of context used by a session, or null when it can't be determined.
function sessionUsagePercent(sessionId, projectDir) {
  if (!sessionId) return null
  try {
    const path = join(SESSIONS_ROOT, projectSlugFor(projectDir || '/root'), `${sessionId}.jsonl`)
    const usage = getSessionContextUsage(path)
    return usage ? usage.percent : null
  } catch { return null }
}

function projectSlugFor(dir) {
  return String(dir).replace(/[/_]/g, '-')
}

// Floating panel shown after every answer. Compact is a heavy, destructive
// action — it only earns a slot once the context is actually filling up
// (>=70%), otherwise it just crowds the panel on every single reply.
function buildControlPanelKeyboard(sessionId = null, projectDir = null) {
  const percent = sessionUsagePercent(sessionId, projectDir)
  const rows = [
    [
      { text: '📋 Сменить', callback_data: 'quick:list' },
      { text: '🧠 Модель',  callback_data: 'model:__show' },
    ],
  ]
  // «Отвязать» убрана из всех панелей намеренно: владелец ей не пользуется, а
  // место под каждым ответом дорогое. Отвязка осталась командой /disconnect;
  // обработчик quick:disconnect тоже жив — кнопки в старых сообщениях чата
  // никуда не делись и должны продолжать работать.
  if (percent != null && percent >= 70) {
    rows.push([
      { text: `🗜 Compact (${percent}%)`, callback_data: 'quick:compact' },
      { text: '➕ Новая сессия',          callback_data: 'quick:new' },
    ])
  } else {
    rows.push([{ text: '➕ Новая сессия', callback_data: 'quick:new' }])
  }
  return { inline_keyboard: rows }
}

// Create a new empty bridged session — generates a fresh UUID, binds the topic
// to it, does NOT touch the JSONL (it'll be created on first message via
// `claude --session-id <new>`). Returns the new session_id.
function createBridgeSession(chatId, threadId, projectDir = '/root') {
  // RFC 4122 UUID v4 generator (no external dep)
  const crypto = require('crypto')
  const bytes = crypto.randomBytes(16)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  setBridge(chatId, threadId, uuid, projectDir)
  return uuid
}

// Track the message_id of the last floating control panel so we can delete it
// before sending a new one (keeps the chat clean — only one panel at a time).
function setLastPanelMessageId(chatId, threadId, messageId) {
  const state = readState()
  const key = bridgeKey(chatId, threadId)
  if (!state[key]) return
  state[key].last_panel_message_id = messageId
  writeState(state)
}

function getLastPanelMessageId(chatId, threadId) {
  const state = readState()
  return state[bridgeKey(chatId, threadId)]?.last_panel_message_id || null
}

// Split long text into chunks of at most `maxSize` chars, preferring natural
// boundaries. For each chunk, search the tail [maxSize-window..maxSize] for a
// boundary; the best wins by priority. If none found, fall back to hard cut.
// Priority (highest → lowest): "\n\n", "\n", ". " "! " "? ", " ", hard cut.
function splitForTelegram(text, maxSize) {
  if (!text || text.length <= maxSize) return [text]
  const out = []
  let i = 0
  const window = Math.min(400, Math.floor(maxSize / 4))
  while (i < text.length) {
    const remaining = text.length - i
    if (remaining <= maxSize) {
      out.push(text.slice(i))
      break
    }
    const tailStart = i + maxSize - window
    const tailEnd = i + maxSize
    let cut = -1
    // 1) paragraph
    const p = text.lastIndexOf('\n\n', tailEnd)
    if (p >= tailStart) cut = p + 2
    // 2) newline
    if (cut < 0) {
      const n = text.lastIndexOf('\n', tailEnd)
      if (n >= tailStart) cut = n + 1
    }
    // 3) sentence terminator followed by space/newline
    if (cut < 0) {
      let best = -1
      for (const term of ['. ', '! ', '? ', '."', '!"', '?"']) {
        const k = text.lastIndexOf(term, tailEnd)
        if (k >= tailStart && k > best) best = k + term.length
      }
      if (best >= 0) cut = best
    }
    // 4) word boundary
    if (cut < 0) {
      const s = text.lastIndexOf(' ', tailEnd)
      if (s >= tailStart) cut = s + 1
    }
    // 5) hard cut
    if (cut < 0 || cut <= i) cut = tailEnd
    out.push(text.slice(i, cut))
    i = cut
  }
  return out
}

function clearLastPanelMessageId(chatId, threadId) {
  const state = readState()
  const key = bridgeKey(chatId, threadId)
  if (!state[key]) return
  delete state[key].last_panel_message_id
  writeState(state)
}

module.exports = {
  BRIDGE_LABEL,
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
  findLastAssistantMessage,
  findAssistantMessagesAfter,
  isInternalArtifact,
  artifactKind,
  setLastPulledUuid,
  extractAssistantText,
  markdownToTelegramHtml,
  splitForTelegram,
  buildControlPanelKeyboard,
  buildModelCardKeyboard,
  buildFreshConnectedKeyboard,
  contextUsageTier,
  getSessionContextUsage,
  setLastPanelMessageId,
  getLastPanelMessageId,
  clearLastPanelMessageId,
  createBridgeSession,
  STATE_FILE,
}
