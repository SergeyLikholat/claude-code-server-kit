// Slash-command dispatcher. Router calls this BEFORE spawning a worker.
// Returns { handled: true, reply?: string } if it ran a command.
//
// Extended to support VS Code Bridge commands (mode=vscode_bridge topic):
//   /list      — show recent sessions registry
//   /connect N — bind topic to session N (or by session_id prefix)
//   /disconnect — release topic from bridged session
//   /status    — existing behavior; also shows bridge state when in bridge mode

const { readFileSync, statSync, existsSync } = require('fs')
const { sessionJsonlPath } = require('./dispatch')
const bridge = require('./bridge')

const AVAILABLE_COMMANDS = [
  '/help', '/status', '/digest', '/reset', '/rollback',
  // bridge:
  '/list', '/connect', '/disconnect',
]

function isCommand(text) {
  if (!text) return false
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return false
  const head = trimmed.split(/\s+/, 1)[0]
  return AVAILABLE_COMMANDS.includes(head)
}

function parseCommand(text) {
  const parts = text.trim().split(/\s+/)
  return { cmd: parts[0], args: parts.slice(1) }
}

function humanBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function countLines(path) {
  try {
    const buf = readFileSync(path)
    let n = 0
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++
    return n
  } catch { return 0 }
}

function cmdHelp(isBridge) {
  const lines = [
    'Доступные команды:',
    '/status — размер сессии и контекст',
    '/digest — сгенерировать дайджест (без ротации)',
    '/reset — ротировать сессию (дайджест + чистая сессия)',
    '/rollback — откатить на предыдущую сессию',
    '/help — эта справка',
  ]
  if (isBridge) {
    lines.push('')
    lines.push('VS Code Bridge:')
    lines.push('/list — показать последние сессии Claude Code')
    lines.push('/connect <N|prefix> — подключить топик к выбранной сессии')
    lines.push('/disconnect — отключить топик от сессии')
  }
  return lines.join('\n')
}

function cmdStatus(topic, ctx) {
  const isBridge = topic.mode === 'vscode_bridge'
  if (isBridge) {
    const chatId = ctx?.chat?.id != null ? String(ctx.chat.id) : null
    const threadId = ctx?.message?.message_thread_id ?? null
    const state = chatId ? bridge.getBridge(chatId, threadId) : null
    if (!state) {
      return [
        '🔌 **VS Code Live** — статус: не подключено',
        '',
        'Используй `/list` для списка сессий, потом `/connect <N>` для подключения.',
      ].join('\n')
    }
    const jsonl = sessionJsonlPath(state.project_dir, state.session_id)
    if (!existsSync(jsonl)) {
      return `🔌 **VS Code Live** — подключено к \`${state.session_id.slice(0, 8)}\`, но JSONL-файл не найден. Возможно сессия была удалена. Попробуй \`/list\` и переподключи.`
    }
    const size = statSync(jsonl).size
    const turns = countLines(jsonl)
    return [
      `🟢 **VS Code Live** — подключено`,
      `• session: \`${state.session_id}\``,
      `• project: ${state.project_dir}`,
      `• размер: ${humanBytes(size)} · turns: ${turns}`,
      `• подключено с: ${state.connected_at}`,
    ].join('\n')
  }
  // Standard status for non-bridge topics
  const jsonl = sessionJsonlPath(topic.project_dir, topic.session_id)
  if (!existsSync(jsonl)) {
    return `📊 Сессия ещё не создана (session_id=${topic.session_id}). Первое сообщение создаст её.`
  }
  const size = statSync(jsonl).size
  const turns = countLines(jsonl)
  const statePath = `${topic.project_dir}/context/.state.json`
  let lastDigest = '—'
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    if (state.last_digest_ts) lastDigest = state.last_digest_ts
  } catch {}
  return [
    `📊 ${topic.name || 'General'}`,
    `• размер jsonl: ${humanBytes(size)}`,
    `• turns: ${turns}`,
    `• session_id: ${topic.session_id}`,
    `• последний digest: ${lastDigest}`,
  ].join('\n')
}

function cmdList(topic) {
  if (topic.mode !== 'vscode_bridge') {
    return '⚠️ `/list` работает только в топике с режимом vscode_bridge.'
  }
  const sessions = bridge.scanSessions(15)
  return bridge.formatSessionsList(sessions)
}

function cmdConnect(topic, ctx, args) {
  if (topic.mode !== 'vscode_bridge') {
    return '⚠️ `/connect` работает только в топике с режимом vscode_bridge.'
  }
  const query = (args || []).join(' ').trim()
  if (!query) {
    return 'Использование: `/connect <номер>` или `/connect <session_id_prefix>`. Сначала `/list` чтобы увидеть варианты.'
  }
  const sessions = bridge.scanSessions(15)
  const res = bridge.resolveSessionByQuery(sessions, query)
  if (!res.ok) {
    return `⚠️ ${res.error}`
  }
  const s = res.session
  const chatId = String(ctx.chat.id)
  const threadId = ctx.message.message_thread_id ?? null
  bridge.setBridge(chatId, threadId, s.session_id, s.cwd)
  return [
    `🟢 Подключено к сессии \`${s.session_id.slice(0, 8)}\``,
    `• project: ${s.cwd}`,
    `• size: ${humanBytes(s.size_bytes)}`,
    '',
    'Дальше пиши обычным текстом — сообщения уйдут в эту сессию.',
    'Чтобы переключиться: `/connect <другой N>`. Чтобы отвязаться: `/disconnect`.',
  ].join('\n')
}

function cmdDisconnect(topic, ctx) {
  if (topic.mode !== 'vscode_bridge') {
    return '⚠️ `/disconnect` работает только в топике с режимом vscode_bridge.'
  }
  const chatId = String(ctx.chat.id)
  const threadId = ctx.message.message_thread_id ?? null
  const prev = bridge.getBridge(chatId, threadId)
  if (!prev) {
    return '⚪ Топик и так не подключён к сессии.'
  }
  bridge.clearBridge(chatId, threadId)
  return `⚪ Отключено от сессии \`${prev.session_id.slice(0, 8)}\` (${prev.project_dir}).`
}

function cmdNotImpl(name) {
  return `🚧 \`${name}\` пока не подключён. В ближайшей итерации будет.`
}

// Main entry called from index.js dispatch pipeline.
// Returns { handled, reply } — if handled, caller skips worker spawn.
// New deps: ctx (Telegram context, needed by bridge commands for chat/thread IDs)
function runCommand(text, topic, deps = {}) {
  if (!isCommand(text)) return { handled: false }
  const { cmd, args } = parseCommand(text)
  const ctx = deps.ctx
  let reply
  try {
    switch (cmd) {
      case '/help':       reply = cmdHelp(topic.mode === 'vscode_bridge'); break
      case '/status':     reply = cmdStatus(topic, ctx); break
      case '/digest':     reply = deps.runDigest ? deps.runDigest(topic) : cmdNotImpl(cmd); break
      case '/reset':      reply = deps.runReset  ? deps.runReset(topic)  : cmdNotImpl(cmd); break
      case '/rollback':   reply = deps.runRollback ? deps.runRollback(topic) : cmdNotImpl(cmd); break
      case '/list':       reply = cmdList(topic); break
      case '/connect':    reply = cmdConnect(topic, ctx, args); break
      case '/disconnect': reply = cmdDisconnect(topic, ctx); break
      default: return { handled: false }
    }
  } catch (err) {
    reply = `⚠️ ошибка команды ${cmd}: ${err.message}`
  }
  return { handled: true, reply }
}

module.exports = { runCommand, isCommand, parseCommand, AVAILABLE_COMMANDS }
