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
const modelMod = require('./model')

const AVAILABLE_COMMANDS = [
  '/help', '/status', '/digest', '/reset', '/rollback',
  // bridge:
  '/list', '/connect', '/disconnect',
  // model control:
  '/model',
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
    '/model — показать/сменить модель для этого топика',
    '/help — эта справка',
  ]
  if (isBridge) {
    lines.push('')
    lines.push(`${bridge.BRIDGE_LABEL}:`)
    lines.push('/list — показать последние сессии Claude Code')
    lines.push('/connect <N|prefix> — подключить топик к выбранной сессии')
    lines.push('/disconnect — отключить топик от сессии')
  }
  return lines.join('\n')
}

// One-line model summary appended to /status so the active model is never a
// mystery — that opacity is what let a topic burn limits on the wrong model.
function modelStatusLine(topic, ctx) {
  const sessionId = activeSessionId(topic, ctx)
  if (!sessionId) return null
  const d = modelMod.describe(sessionId, sessionJsonlPathFor(topic, ctx, sessionId))
  const eff = d.effective || 'дефолт CLI'
  return `• модель: ${eff} (${d.note}) — сменить: /model`
}

// JSONL path for the session a topic drives — needed to read the VS Code model.
function sessionJsonlPathFor(topic, ctx, sessionId) {
  let projectDir = topic.project_dir || '/root'
  if (topic.mode === 'vscode_bridge') {
    const chatId = ctx?.chat?.id != null ? String(ctx.chat.id) : null
    const threadId = ctx?.message?.message_thread_id ?? null
    const st = chatId ? bridge.getBridge(chatId, threadId) : null
    if (st) projectDir = st.project_dir || projectDir
  }
  return sessionJsonlPath(projectDir, sessionId)
}

function cmdStatus(topic, ctx) {
  const isBridge = topic.mode === 'vscode_bridge'
  if (isBridge) {
    const chatId = ctx?.chat?.id != null ? String(ctx.chat.id) : null
    const threadId = ctx?.message?.message_thread_id ?? null
    const state = chatId ? bridge.getBridge(chatId, threadId) : null
    if (!state) {
      return [
        `🔌 **${bridge.BRIDGE_LABEL}** — статус: не подключено`,
        '',
        'Используй `/list` для списка сессий, потом `/connect <N>` для подключения.',
      ].join('\n')
    }
    const jsonl = sessionJsonlPath(state.project_dir, state.session_id)
    if (!existsSync(jsonl)) {
      return `🔌 **${bridge.BRIDGE_LABEL}** — подключено к \`${state.session_id.slice(0, 8)}\`, но JSONL-файл не найден. Возможно сессия была удалена. Попробуй \`/list\` и переподключи.`
    }
    const size = statSync(jsonl).size
    const turns = countLines(jsonl)
    return [
      `🟢 **${bridge.BRIDGE_LABEL}** — подключено`,
      `• session: \`${state.session_id}\``,
      `• project: ${state.project_dir}`,
      `• размер: ${humanBytes(size)} · turns: ${turns}`,
      `• подключено с: ${state.connected_at}`,
      modelStatusLine(topic, ctx),
    ].filter(Boolean).join('\n')
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
    modelStatusLine(topic, ctx),
  ].filter(Boolean).join('\n')
}

function cmdList(topic, args) {
  if (topic.mode !== 'vscode_bridge') {
    return '⚠️ <code>/list</code> работает только в топике с режимом vscode_bridge.'
  }
  let page = 1
  let includeAgents = false
  for (const a of (args || [])) {
    const lower = String(a).toLowerCase()
    if (lower === 'all' || lower === 'agents') { includeAgents = true; continue }
    const n = parseInt(a, 10)
    if (!isNaN(n) && n >= 1) page = n
  }
  const { text, reply_markup } = bridge.buildListPage(page, 10, { includeAgents })
  return reply_markup ? { text, reply_markup } : text
}

function cmdConnect(topic, ctx, args) {
  if (topic.mode !== 'vscode_bridge') {
    return '⚠️ <code>/connect</code> работает только в топике с режимом vscode_bridge.'
  }
  const query = (args || []).join(' ').trim()
  if (!query) {
    return 'Использование: <code>/connect &lt;N&gt;</code> или <code>/connect &lt;session_id_prefix&gt;</code>. Сначала <code>/list</code> чтобы увидеть варианты.'
  }
  // Resolve over full session set (so absolute indices from /list pages work).
  const sessions = bridge.scanSessions({ excludeTgRouted: true, limit: 500 })
  const res = bridge.resolveSessionByQuery(sessions, query)
  if (!res.ok) {
    return `⚠️ ${res.error}`
  }
  const s = res.session
  const chatId = String(ctx.chat.id)
  const threadId = ctx.message.message_thread_id ?? null
  bridge.setBridge(chatId, threadId, s.session_id, s.cwd)
  const title = s.custom_title || s.ai_title || s.project_slug || s.session_id.slice(0, 8)
  const titleHtml = String(title).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return {
    text: [
      `🟢 <b>Подключено</b>`,
      titleHtml,
      '',
      'Пиши обычным текстом — сообщения уйдут в эту сессию.',
    ].join('\n'),
    reply_markup: bridge.buildConnectedKeyboard(),
  }
}

function cmdDisconnect(topic, ctx) {
  if (topic.mode !== 'vscode_bridge') {
    return '⚠️ <code>/disconnect</code> работает только в топике с режимом vscode_bridge.'
  }
  const chatId = String(ctx.chat.id)
  const threadId = ctx.message.message_thread_id ?? null
  const prev = bridge.getBridge(chatId, threadId)
  if (!prev) {
    return '⚪ Топик и так не подключён к сессии.'
  }
  bridge.clearBridge(chatId, threadId)
  return {
    text: `⚪ Отключено от сессии <code>${prev.session_id.slice(0, 8)}</code> (<code>${prev.project_dir}</code>).`,
    reply_markup: bridge.buildDisconnectedKeyboard(),
  }
}

function cmdNotImpl(name) {
  return `🚧 \`${name}\` пока не подключён. В ближайшей итерации будет.`
}

function activeSessionId(topic, ctx) {
  if (topic.mode === 'vscode_bridge') {
    const chatId = ctx?.chat?.id != null ? String(ctx.chat.id) : null
    if (!chatId) return null
    const threadId = ctx?.message?.message_thread_id ?? null
    const state = bridge.getBridge(chatId, threadId)
    return state ? state.session_id : null
  }
  return topic.session_id || null
}

// /model — inspect or pin the model for the SESSION this topic is driving.
//   /model              → current setting + picker buttons
//   /model <id>         → pin for this session
//   /model auto         → let the CLI resolve (the old, drifty behavior)
//   /model default      → drop the session pin, follow the global default
//   /model global <id>  → change the global default for unpinned sessions
function cmdModel(topic, ctx, args) {
  const sub = (args[0] || '').toLowerCase()

  if (sub === 'global') {
    const target = args[1]
    if (!target) return '⚠️ укажи модель: <code>/model global claude-opus-5</code>'
    modelMod.setGlobalDefault(target)
    return `🌐 Глобальный дефолт: <b>${modelMod.labelFor(target)}</b> (<code>${target}</code>)\n\nСессии без своей настройки теперь используют её.`
  }

  const sessionId = activeSessionId(topic, ctx)
  if (!sessionId) {
    return [
      '⚠️ Топик не привязан к сессии — не к чему привязывать модель.',
      '',
      'Сначала <code>/list</code> и <code>/connect &lt;N&gt;</code>.',
      'Сменить глобальный дефолт можно и так: <code>/model global &lt;id&gt;</code>.',
    ].join('\n')
  }
  const short = sessionId.slice(0, 8)

  if (sub === 'default' || sub === 'reset') {
    modelMod.clearModel(sessionId)
    const eff = modelMod.getModelSetting(sessionId)
    return `↩️ Настройка сессии <code>${short}</code> снята. Действует глобальный дефолт: <b>${modelMod.labelFor(eff)}</b> (<code>${eff}</code>)`
  }

  if (sub) {
    const target = args[0]
    modelMod.setModel(sessionId, target)
    const note = modelMod.MODEL_CHOICES.some(m => m.id === target)
      ? ''
      : '\n\n⚠️ Модель не из известного списка — если id неверный, воркер упадёт при следующем сообщении.'
    return `✅ Сессия <code>${short}</code> → <b>${modelMod.labelFor(target)}</b> (<code>${target}</code>)${note}`
  }

  // No args — show current state and a picker.
  const current = modelMod.getModelSetting(sessionId)
  const isOwn = modelMod.hasOverride(sessionId)
  const d = modelMod.describe(sessionId, sessionJsonlPathFor(topic, ctx, sessionId))
  const lines = [
    '<b>Модель этой сессии</b>',
    '',
    `• сессия: <code>${short}</code>`,
    `• режим: <b>${modelMod.labelFor(current)}</b>`,
    `• применяется: <code>${d.effective || 'дефолт CLI'}</code> — ${d.note}`,
    `• источник: ${isOwn ? 'закреплено за сессией' : 'глобальный дефолт'}`,
    `• глобальный дефолт: <code>${modelMod.getGlobalDefault()}</code>`,
  ]
  if (current === modelMod.FOLLOW) {
    lines.push('', 'Режим <b>Как в VS Code</b>: беру модель последнего ответа VS Code в этой сессии. Переключил на компьютере — Telegram подхватит после первого ответа там.')
  } else {
    lines.push('', 'Настройка живёт на сессии — переключишь топик на другую, у неё будет своя.')
  }
  lines.push('', 'Выбери модель или вернись назад.')
  if (current === modelMod.AUTO) {
    lines.push('', '⚠️ Режим <code>auto</code> — модель выбирает CLI, она может меняться сама.')
  }
  return { text: lines.join('\n'), reply_markup: modelMod.buildPickerKeyboard(sessionId) }
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
      case '/list':       reply = cmdList(topic, args); break
      case '/connect':    reply = cmdConnect(topic, ctx, args); break
      case '/disconnect': reply = cmdDisconnect(topic, ctx); break
      case '/model':      reply = cmdModel(topic, ctx, args); break
      default: return { handled: false }
    }
  } catch (err) {
    reply = `⚠️ ошибка команды ${cmd}: ${err.message}`
  }
  // Reply can be: string (plain text) or { text, reply_markup } (with inline keyboard)
  if (reply && typeof reply === 'object' && reply.text) {
    return { handled: true, reply: reply.text, reply_markup: reply.reply_markup }
  }
  return { handled: true, reply }
}

module.exports = { runCommand, isCommand, parseCommand, AVAILABLE_COMMANDS }
