#!/usr/bin/env node
// tg-router: single Telegram long-poll consumer + per-topic parallel claude workers.
// Replaces the monolithic `claude --channels plugin:telegram@...` daemon.

const { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } = require('fs')
const { join } = require('path')
const { homedir } = require('os')
const { Bot, GrammyError } = require('grammy')

const { gate, checkApprovals, STATE_DIR } = require('./access')
const { handlePhoto, handleVoice, handleDocument, handleAudio, handleVideo } = require('./attachments')
const { withLock, isLockBusy } = require('./lock')
const { runClaudeWorker } = require('./dispatch')
const { runCommand, isCommand } = require('./commands')
const bridge = require('./bridge')
const { transcribeIfConfigured } = require('./transcribe')

const ROUTING_FILE = join(STATE_DIR, 'routing.json')
const ENV_FILE = join(STATE_DIR, '.env')
const PID_FILE = join(STATE_DIR, 'bot.pid')
const LOCK_DIR = '/run/claude-telegram'

// -- Env loading (mirror plugin behavior) ------------------------------------
try {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
if (!TOKEN) {
  console.error(`tg-router: TELEGRAM_BOT_TOKEN required (set in ${ENV_FILE})`)
  process.exit(1)
}

// -- Claim bot.pid so plugin-in-worker knows we own polling -----------------
mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
mkdirSync(LOCK_DIR, { recursive: true })
try {
  const holder = parseInt(readFileSync(PID_FILE, 'utf8'), 10)
  if (holder > 1 && holder !== process.pid) {
    try {
      process.kill(holder, 0)
      console.error(`tg-router: another poller alive (pid=${holder}) — refusing to start`)
      process.exit(2)
    } catch {
      console.error(`tg-router: cleaning stale bot.pid (dead pid=${holder})`)
    }
  }
} catch {}
writeFileSync(PID_FILE, String(process.pid))
process.on('exit', () => {
  try {
    if (parseInt(readFileSync(PID_FILE, 'utf8'), 10) === process.pid) unlinkSync(PID_FILE)
  } catch {}
})

// -- Routing.json (re-read on each dispatch for hot-reload) -----------------
function loadRouting() {
  return JSON.parse(readFileSync(ROUTING_FILE, 'utf8'))
}

function resolveTopic(routing, threadId) {
  const key = threadId != null ? String(threadId) : null
  if (key && routing.topics[key]) {
    return { ...routing.topics[key], threadId: key }
  }
  return { ...(routing.general || {}), name: 'General', threadId: null }
}

// -- Channel tag builder (same format plugin produces) ----------------------
function safeName(s) { return s == null ? undefined : String(s).replace(/[<>\[\]\r\n;]/g, '_') }

function buildChannelTag({ ctx, threadId, imagePath, attachment }) {
  const chat_id = String(ctx.chat.id)
  const from = ctx.from
  const msgId = ctx.message.message_id
  const isTopic = ctx.message.is_topic_message === true
  const attrs = [
    ['source', 'plugin:telegram:telegram'],
    ['chat_id', chat_id],
    ['message_id', String(msgId)],
    ['user', from.username || String(from.id)],
    ['user_id', String(from.id)],
    threadId != null ? ['message_thread_id', String(threadId)] : null,
    isTopic ? ['is_topic_message', 'true'] : null,
    ['ts', new Date(ctx.message.date * 1000).toISOString()],
    imagePath ? ['image_path', imagePath] : null,
    attachment ? ['attachment_kind', attachment.kind] : null,
    attachment ? ['attachment_file_id', attachment.file_id] : null,
    attachment?.mime ? ['attachment_mime', attachment.mime] : null,
    attachment?.name ? ['attachment_name', safeName(attachment.name)] : null,
  ].filter(Boolean)
  const body = attrs.map(([k, v]) => `${k}="${String(v).replace(/"/g, '&quot;')}"`).join(' ')
  return `<channel ${body}>`
}

// -- Status message lifecycle (v1 timer-based UX) ---------------------------
function formatDuration(ms) {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s} сек`
  const m = Math.floor(s / 60), r = s % 60
  return `${m}м ${r}с`
}

async function openStatus(bot, chat_id, threadId, ux) {
  await sleep(ux.initial_status_delay_ms || 2500)
  const opts = threadId != null ? { message_thread_id: Number(threadId) } : {}
  try {
    const m = await bot.api.sendMessage(chat_id, '⌛ понял, думаю…', opts)
    return m.message_id
  } catch {
    return null
  }
}

async function tickStatus(bot, chat_id, messageId, elapsedMs) {
  if (!messageId) return
  try {
    await bot.api.editMessageText(chat_id, messageId, `⏳ работаю, прошло ${formatDuration(elapsedMs)}…`)
  } catch (err) {
    if (!(err instanceof GrammyError && err.error_code === 400)) {
      // 400 «message not modified» — ignore; anything else — log
      console.error('tg-router: tick edit failed:', err.message || err)
    }
  }
}

async function closeStatus(bot, chat_id, messageId, ux, outcome) {
  if (!messageId) return
  const mode = ux.on_finish || 'mark_done'
  try {
    if (mode === 'delete') {
      await bot.api.deleteMessage(chat_id, messageId).catch(() => {})
      return
    }
    const text =
      outcome.ok
        ? (mode === 'keep' ? `⏳ работаю, прошло ${formatDuration(outcome.durationMs)}…` : `✅ готово за ${formatDuration(outcome.durationMs)}`)
        : outcome.timedOut
          ? `⏱ таймаут — воркер убит через ${formatDuration(outcome.durationMs)}`
          : `⚠️ воркер упал (code ${outcome.code}): ${outcome.errSnippet || 'см. журнал'}`
    await bot.api.editMessageText(chat_id, messageId, text).catch(() => {})
  } catch {}
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// -- Main dispatch for a single message -------------------------------------
async function handleInbound(bot, ctx, text, attachment) {
  const botUsername = bot.botInfo?.username
  const result = gate(ctx, botUsername)

  if (result.action === 'drop') return
  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    await ctx.reply(`${lead} — run in Claude Code:\n\n/telegram:access pair ${result.code}`).catch(() => {})
    return
  }

  const routing = loadRouting()
  const threadId = ctx.message.message_thread_id ?? null
  const topic = resolveTopic(routing, threadId)
  const ux = { ...(routing.ux || {}), ...(topic.ux || {}) }
  const chat_id = String(ctx.chat.id)
  const msgId = ctx.message.message_id

  // ack reaction on the user message (instant signal)
  if (ux.ack_reaction) {
    bot.api.setMessageReaction(chat_id, msgId, [{ type: 'emoji', emoji: ux.ack_reaction }])
      .catch(() => {})
  }

  // slash-command intercept: runs synchronously, no worker spawn
  if (text && isCommand(text)) {
    const { handled, reply, reply_markup } = runCommand(text, topic, { ctx })
    if (handled) {
      const baseOpts = threadId != null ? { message_thread_id: Number(threadId) } : {}
      const htmlOpts = { ...baseOpts, parse_mode: 'HTML', disable_web_page_preview: true }
      if (reply_markup) htmlOpts.reply_markup = reply_markup
      await bot.api.sendMessage(chat_id, reply || '(ok)', htmlOpts).catch(err => {
        // Fallback to plain text if HTML parsing fails (e.g. mismatched tags)
        console.error('tg-router: HTML parse failed, falling back to plain:', err?.description || err?.message || err)
        const plainOpts = { ...baseOpts }
        if (reply_markup) plainOpts.reply_markup = reply_markup
        return bot.api.sendMessage(chat_id, reply || '(ok)', plainOpts).catch(() => {})
      })
      return
    }
  }

  // VS Code Live bridge override: for topic.mode === 'vscode_bridge',
  // route the message to the session selected via /connect, not the placeholder
  // session_id from routing.json.
  if (topic.mode === 'vscode_bridge') {
    const state = bridge.getBridge(chat_id, threadId)
    if (!state) {
      const opts = threadId != null ? { message_thread_id: Number(threadId) } : {}
      await bot.api.sendMessage(chat_id,
        '🔌 Сессия не выбрана. Используй `/list` чтобы увидеть доступные сессии, потом `/connect <N>` для подключения.',
        opts).catch(() => {})
      return
    }
    topic.project_dir = state.project_dir
    topic.session_id = state.session_id
  }

  const lockPath = join(LOCK_DIR, `topic-${threadId || 'general'}.lock`)
  const queued = isLockBusy(lockPath)
  if (queued) {
    const opts = threadId != null ? { message_thread_id: Number(threadId) } : {}
    bot.api.sendMessage(chat_id, '⏳ задача в очереди — подожди, закончу текущую.', opts).catch(() => {})
  }

  await withLock(lockPath, async () => {
    // typing heartbeat (every 4s while worker runs)
    const typingInt = setInterval(() => {
      const opts = threadId != null ? { message_thread_id: Number(threadId) } : {}
      bot.api.sendChatAction(chat_id, 'typing', opts).catch(() => {})
    }, 4000)
    // immediate first typing
    bot.api.sendChatAction(chat_id, 'typing', threadId != null ? { message_thread_id: Number(threadId) } : {})
      .catch(() => {})

    // status message (opens after delay; if worker is fast, may not open at all)
    let statusId = null
    const startedAt = Date.now()
    const statusPromise = openStatus(bot, chat_id, threadId, ux).then(id => { statusId = id })

    // progress ticks
    const tickInt = setInterval(() => {
      if (statusId) tickStatus(bot, chat_id, statusId, Date.now() - startedAt)
    }, ux.progress_tick_ms || 30000)

    const prompt = `${buildChannelTag({ ctx, threadId, imagePath: attachment?.kind === 'photo' ? attachment.path : undefined, attachment: attachment && attachment.kind !== 'photo' ? attachment : undefined })}\n${text || ''}`

    let outcome
    try {
      const res = await runClaudeWorker({
        project_dir: topic.project_dir || '/root',
        session_id: topic.session_id,
        prompt,
        timeout_ms: ux.worker_timeout_ms || 600000,
      })
      outcome = {
        ok: res.code === 0 && !res.killed,
        code: res.code,
        timedOut: res.killed,
        durationMs: res.durationMs,
        errSnippet: (res.stderr || '').slice(-200),
      }
      if (res.code === 0) {
        console.error(`tg-router: [worker ok] topic=${topic.name || 'general'} dur=${res.durationMs}ms`)
      } else {
        console.error(`tg-router: [worker FAIL] topic=${topic.name || 'general'} code=${res.code} killed=${res.killed}\n${res.stderr}`)
      }
    } catch (err) {
      outcome = { ok: false, code: -1, timedOut: false, durationMs: Date.now() - startedAt, errSnippet: err.message }
    } finally {
      clearInterval(typingInt)
      clearInterval(tickInt)
      await statusPromise
      await closeStatus(bot, chat_id, statusId, ux, outcome)
    }
  })
}

// -- Bot setup --------------------------------------------------------------
const bot = new Bot(TOKEN)

bot.catch(err => {
  console.error('tg-router: handler error (polling continues):', err.error)
})

// Fire-and-forget per update so grammy's middleware chain doesn't serialize
// updates across topics. Per-topic serialization is enforced inside
// handleInbound via withLock on the topic's lockfile.
function fireAndForget(fn) {
  return ctx => {
    Promise.resolve()
      .then(() => fn(ctx))
      .catch(err => console.error('tg-router: handler error:', err.message || err))
  }
}

bot.on('message:text', fireAndForget(async ctx => {
  await handleInbound(bot, ctx, ctx.message.text, null)
}))

bot.on('message:photo', fireAndForget(async ctx => {
  const caption = ctx.message.caption ?? '(photo)'
  let attachment = null
  try { attachment = await handlePhoto(bot, ctx) } catch (err) {
    console.error('tg-router: photo download failed:', err.message)
  }
  await handleInbound(bot, ctx, caption, attachment)
}))

bot.on('message:voice', fireAndForget(async ctx => {
  let caption = ctx.message.caption ?? '(voice message)'
  let attachment = null
  try { attachment = await handleVoice(bot, ctx) } catch (err) {
    console.error('tg-router: voice download failed:', err.message)
  }
  if (attachment) {
    const text = await transcribeIfConfigured(attachment.path).catch(() => null)
    if (text) {
      caption = `(voice transcript)\n${text}`
      attachment.transcript = text
    }
  }
  await handleInbound(bot, ctx, caption, attachment)
}))

bot.on('message:document', fireAndForget(async ctx => {
  const caption = ctx.message.caption ?? `(document: ${ctx.message.document.file_name || 'file'})`
  let attachment = null
  try { attachment = await handleDocument(bot, ctx) } catch (err) {
    console.error('tg-router: doc download failed:', err.message)
  }
  await handleInbound(bot, ctx, caption, attachment)
}))

bot.on('message:audio', fireAndForget(async ctx => {
  let caption = ctx.message.caption ?? '(audio)'
  let attachment = null
  try { attachment = await handleAudio(bot, ctx) } catch (err) {
    console.error('tg-router: audio download failed:', err.message)
  }
  if (attachment) {
    const text = await transcribeIfConfigured(attachment.path).catch(() => null)
    if (text) {
      caption = `(audio transcript)\n${text}`
      attachment.transcript = text
    }
  }
  await handleInbound(bot, ctx, caption, attachment)
}))

bot.on('message:video', fireAndForget(async ctx => {
  const caption = ctx.message.caption ?? '(video)'
  let attachment = null
  try { attachment = await handleVideo(bot, ctx) } catch (err) {
    console.error('tg-router: video download failed:', err.message)
  }
  await handleInbound(bot, ctx, caption, attachment)
}))

// -- Callback queries (inline keyboard clicks) ------------------------------
bot.on('callback_query:data', fireAndForget(async ctx => {
  const botUsername = bot.botInfo?.username
  const gateResult = gate(ctx, botUsername)
  if (gateResult.action === 'drop') {
    await ctx.answerCallbackQuery({ text: 'нет доступа', show_alert: false }).catch(() => {})
    return
  }
  const data = ctx.callbackQuery.data || ''
  const m = ctx.callbackQuery.message
  if (!m) {
    await ctx.answerCallbackQuery().catch(() => {})
    return
  }
  // Parse: "list[-all]:page=N" | "list[-all]:noop"
  const m2 = data.match(/^(list|list-all):(page=(\d+)|noop)$/)
  if (m2) {
    const includeAgents = m2[1] === 'list-all'
    if (m2[2] === 'noop') {
      await ctx.answerCallbackQuery().catch(() => {})
      return
    }
    const page = parseInt(m2[3], 10)
    const { text, reply_markup } = bridge.buildListPage(page, 10, { includeAgents })
    try {
      await bot.api.editMessageText(m.chat.id, m.message_id, text, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup,
      })
    } catch (err) {
      const desc = err?.description || ''
      if (!desc.includes('not modified')) {
        console.error('tg-router: edit list page failed:', desc || err?.message)
      }
    }
    await ctx.answerCallbackQuery().catch(() => {})
    return
  }
  // Parse: "con:<session_id>" — direct selection from number button
  const conMatch = data.match(/^con:([a-f0-9-]{8,})$/i)
  if (conMatch) {
    const wantedId = conMatch[1]
    const all = bridge.scanSessions({ excludeTgRouted: true, excludeAgents: false, limit: 5000 })
    const session = all.find(s => s.session_id === wantedId)
    if (!session) {
      await ctx.answerCallbackQuery({ text: 'Сессия не найдена (возможно удалена)', show_alert: true }).catch(() => {})
      return
    }
    const chatId = String(m.chat.id)
    const threadId = m.message_thread_id ?? null
    bridge.setBridge(chatId, threadId, session.session_id, session.cwd)
    const titleRaw = session.ai_title || session.project_slug || session.session_id.slice(0, 8)
    const titleHtml = String(titleRaw).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const replyText = [
      `🟢 <b>Подключено</b>`,
      titleHtml,
      '',
      `Пиши обычным текстом — сообщения уйдут в эту сессию.`,
    ].join('\n')
    try {
      await bot.api.editMessageText(m.chat.id, m.message_id, replyText, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: bridge.buildConnectedKeyboard(),
      })
    } catch (err) {
      console.error('tg-router: edit on connect failed:', err?.description || err?.message)
    }
    await ctx.answerCallbackQuery({ text: `Подключено: ${String(titleRaw).slice(0, 60)}` }).catch(() => {})
    return
  }
  // Parse: "quick:list" | "quick:status" | "quick:disconnect" — buttons under "Подключено"/"Отключено".
  const quickMatch = data.match(/^quick:(list|status|disconnect)$/)
  if (quickMatch) {
    const action = quickMatch[1]
    const chatId = String(m.chat.id)
    const threadId = m.message_thread_id ?? null
    const baseOpts = { parse_mode: 'HTML', disable_web_page_preview: true }
    if (action === 'list') {
      const { text, reply_markup } = bridge.buildListPage(1)
      try {
        await bot.api.sendMessage(m.chat.id, text, {
          ...baseOpts,
          reply_markup,
          message_thread_id: threadId != null ? Number(threadId) : undefined,
        })
      } catch (err) {
        console.error('tg-router: quick list send failed:', err?.description || err?.message)
      }
      await ctx.answerCallbackQuery().catch(() => {})
      return
    }
    if (action === 'status') {
      const state = bridge.getBridge(chatId, threadId)
      const text = state
        ? [`🟢 <b>Подключено</b>`,
            `session: <code>${state.session_id.slice(0, 8)}</code>`,
            `project: <code>${state.project_dir}</code>`,
            `since: ${state.connected_at}`].join('\n')
        : `🔌 Не подключено к сессии.`
      try {
        await bot.api.sendMessage(m.chat.id, text, {
          ...baseOpts,
          message_thread_id: threadId != null ? Number(threadId) : undefined,
        })
      } catch (err) {
        console.error('tg-router: quick status send failed:', err?.description || err?.message)
      }
      await ctx.answerCallbackQuery().catch(() => {})
      return
    }
    if (action === 'disconnect') {
      const prev = bridge.getBridge(chatId, threadId)
      if (!prev) {
        await ctx.answerCallbackQuery({ text: 'Уже отключено', show_alert: false }).catch(() => {})
        return
      }
      bridge.clearBridge(chatId, threadId)
      const text = `⚪ Отключено от сессии <code>${prev.session_id.slice(0, 8)}</code> (<code>${prev.project_dir}</code>).`
      try {
        await bot.api.editMessageText(m.chat.id, m.message_id, text, {
          ...baseOpts,
          reply_markup: bridge.buildDisconnectedKeyboard(),
        })
      } catch (err) {
        // Fallback to new message if edit failed
        await bot.api.sendMessage(m.chat.id, text, {
          ...baseOpts,
          reply_markup: bridge.buildDisconnectedKeyboard(),
          message_thread_id: threadId != null ? Number(threadId) : undefined,
        }).catch(() => {})
      }
      await ctx.answerCallbackQuery({ text: 'Отключено' }).catch(() => {})
      return
    }
  }
  // Unknown callback — silently ack
  await ctx.answerCallbackQuery().catch(() => {})
}))

// Periodic: send pairing approvals
setInterval(() => checkApprovals(bot), 5000)

process.on('SIGTERM', () => { console.error('tg-router: SIGTERM, stopping'); bot.stop().finally(() => process.exit(0)) })
process.on('SIGINT',  () => { console.error('tg-router: SIGINT, stopping');  bot.stop().finally(() => process.exit(0)) })

// Start polling (drop_pending_updates=false — we want messages sent while we were down)
bot.start({
  drop_pending_updates: false,
  onStart: info => {
    console.error(`tg-router: started @${info.username} (pid=${process.pid})`)
  },
}).catch(err => {
  console.error('tg-router: fatal start error:', err.message || err)
  process.exit(3)
})
