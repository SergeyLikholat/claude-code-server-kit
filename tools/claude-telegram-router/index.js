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
const modelMod = require('./model')

const ROUTING_FILE = join(STATE_DIR, 'routing.json')
const ENV_FILE = join(STATE_DIR, '.env')
const PID_FILE = join(STATE_DIR, 'bot.pid')
// Каталог локов — свой на каждый инстанс. Общий каталог означал бы, что топики
// разных людей с совпадающим thread_id блокируют друг друга.
const LOCK_DIR = process.env.TG_ROUTER_LOCK_DIR || '/run/claude-telegram'

// Префикс строк в journal: у каждого роутера свой, иначе в общем логе не видно,
// чей это инстанс (все три пишут в один journald).
const LOG_LABEL = process.env.TG_ROUTER_LABEL || 'tg-router'

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
  // If voice/audio was pre-transcribed locally, the body already carries the
  // text — DO NOT expose attachment_file_id / attachment_kind / mime in the
  // channel tag. Otherwise Claude tries to download_attachment and process the
  // raw audio bytes, which blows up the context. The transcript is enough.
  const hasTranscript = !!(attachment && attachment.transcript)
  const showAttachmentMeta = !!attachment && !hasTranscript
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
    showAttachmentMeta ? ['attachment_kind', attachment.kind] : null,
    showAttachmentMeta ? ['attachment_file_id', attachment.file_id] : null,
    showAttachmentMeta && attachment.mime ? ['attachment_mime', attachment.mime] : null,
    showAttachmentMeta && attachment.name ? ['attachment_name', safeName(attachment.name)] : null,
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
    const m = await bot.api.sendMessage(chat_id, '⌛ Ок, думаю…', opts)
    return m.message_id
  } catch {
    return null
  }
}

// Move the status line back to the bottom of the topic. Editing in place keeps
// it wherever it was first posted, so once narration starts streaming it
// scrolls out of view and the user loses sight of elapsed time and whether the
// run is still alive. Delete + repost is the only way Telegram lets a message
// change position. Returns the new message id (or the old one on failure).
async function refloatStatus(bot, chat_id, threadId, messageId, elapsedMs) {
  if (!messageId) return messageId
  const opts = threadId != null ? { message_thread_id: Number(threadId) } : {}
  try {
    const m = await bot.api.sendMessage(chat_id, `⏳ работаю, прошло ${formatDuration(elapsedMs)}…`, opts)
    // Only drop the old one once the new one exists — a failed send must not
    // leave the turn with no status at all.
    await bot.api.deleteMessage(chat_id, messageId).catch(() => {})
    return m.message_id
  } catch (err) {
    console.error('tg-router: status refloat failed:', err?.description || err?.message || err)
    return messageId
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

// Classify a failed worker by scanning stderr+stdout for known signatures.
// Returns { icon, title, hint } — both shown to the user as a humanized error.
function classifyWorkerError(code, stderr, stdout) {
  const blob = `${stderr || ''}\n${stdout || ''}`.toLowerCase()
  // Context overflow — most actionable, suggest /compact.
  if (blob.includes('prompt is too long') || blob.includes('context_length_exceeded') ||
      blob.includes('context window') || blob.includes('exceeds the model')) {
    return {
      icon: '🔴',
      title: 'контекст переполнен',
      hint: 'История сессии превысила лимит модели. Нужен /compact (выполни через кнопку «Compact» или подключись к новой сессии).',
    }
  }
  // API throttling / overload.
  if (blob.includes('rate_limit_exceeded') || blob.includes('rate limit') ||
      blob.includes('too many requests') || blob.includes('429')) {
    return {
      icon: '⏳',
      title: 'rate limit',
      hint: 'Anthropic API ограничил тебя по частоте запросов. Подожди 1-2 минуты и попробуй снова.',
    }
  }
  if (blob.includes('overload') || blob.includes('overloaded_error') ||
      blob.includes('529') || blob.includes('503') || blob.includes('502') || blob.includes('500')) {
    return {
      icon: '🚧',
      title: 'модель перегружена',
      hint: 'Anthropic API временно перегружен (5xx). Попробуй через минуту.',
    }
  }
  // Network/connectivity.
  if (blob.includes('econnreset') || blob.includes('etimedout') || blob.includes('econnrefused') ||
      blob.includes('network') || blob.includes('fetch failed') || blob.includes('dns')) {
    return {
      icon: '🌐',
      title: 'сетевая ошибка',
      hint: 'Не смог достучаться до Anthropic API. Проверь интернет на сервере или попробуй позже.',
    }
  }
  // Auth.
  if (blob.includes('unauthorized') || blob.includes('forbidden') || blob.includes('401') ||
      blob.includes('403') || blob.includes('authentication') || blob.includes('api key')) {
    return {
      icon: '🔐',
      title: 'проблема авторизации',
      hint: 'Anthropic вернул 401/403. Проверь .credentials.json или OAuth — возможно сессия истекла.',
    }
  }
  // Permission / file system.
  if (blob.includes('eacces') || blob.includes('permission denied')) {
    return {
      icon: '⛔',
      title: 'нет прав файла',
      hint: 'Worker не смог прочитать/записать файл (permission). Проверь права в директории сессии.',
    }
  }
  // Generic.
  const tail = (stderr || stdout || '').slice(-200).trim()
  return {
    icon: '⚠️',
    title: `воркер упал (code ${code})`,
    hint: tail ? tail : 'см. journalctl -u tg-router.service',
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
    let text
    if (outcome.ok) {
      text = mode === 'keep'
        ? `⏳ работаю, прошло ${formatDuration(outcome.durationMs)}…`
        : `✅ готово за ${formatDuration(outcome.durationMs)}`
    } else if (outcome.timedOut) {
      text = `⏱ <b>таймаут</b> — воркер убит через ${formatDuration(outcome.durationMs)}.\nЗапрос длился слишком долго. Попробуй разбить на части или сократить.`
    } else {
      const err = classifyWorkerError(outcome.code, outcome.errSnippet, outcome.stdoutSnippet)
      text = `${err.icon} <b>${err.title}</b>\n${err.hint}`
    }
    await bot.api.editMessageText(chat_id, messageId, text, { parse_mode: 'HTML' }).catch(() => {})
  } catch {}
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// -- Follow-up buffer --------------------------------------------------------
// Lets the user keep typing while a worker runs instead of being told "в очереди".
// Messages that arrive mid-run are appended here; the active withLock holder
// drains them and runs another worker pass, so the model picks them up without
// the user re-sending anything.
//
// Why a buffer and not true mid-turn injection: even with the CLI's
// --input-format stream-json (verified on 2.1.220), an extra user message
// becomes its own sequential turn — it cannot mutate a turn already in flight.
// Queueing is therefore inherent, and doing it here keeps the one-shot spawn
// model (and its crash/heal handling) intact.
const pendingFollowups = new Map()   // lockPath -> [{ text, at }]
const MAX_PENDING = 20

function pushFollowup(lockPath, text) {
  const list = pendingFollowups.get(lockPath) || []
  if (list.length >= MAX_PENDING) return false
  list.push({ text, at: Date.now() })
  pendingFollowups.set(lockPath, list)
  return true
}

function drainFollowups(lockPath) {
  const list = pendingFollowups.get(lockPath) || []
  pendingFollowups.delete(lockPath)
  return list
}

function hasFollowups(lockPath) {
  return (pendingFollowups.get(lockPath) || []).length > 0
}

// Handles on in-flight workers, so the "перебить" button can cut a pass short
// and let the buffered follow-ups start immediately instead of waiting out a
// long run the user has already superseded.
const activeWorkers = new Map()   // lockPath -> { handle, interrupted }

function lockPathFor(threadId) {
  return join(LOCK_DIR, `topic-${threadId || 'general'}.lock`)
}

// Returns true if there was a live worker to interrupt.
function interruptWorker(lockPath) {
  const entry = activeWorkers.get(lockPath)
  if (!entry || !entry.handle) return false
  entry.interrupted = true
  try { entry.handle.kill() } catch (err) {
    console.error('tg-router: interrupt kill failed:', err.message)
    return false
  }
  console.error(`tg-router: interrupted worker pid=${entry.handle.pid}`)
  return true
}

function wasInterrupted(lockPath) {
  return !!(activeWorkers.get(lockPath) || {}).interrupted
}

// Inline button offered alongside "➕ принято", so a long pass can be cut short.
function buildFollowupKeyboard(threadId) {
  return {
    inline_keyboard: [[
      { text: '⚡ Перебить сейчас', callback_data: `fu-int:${threadId || 'general'}` },
    ]],
  }
}

// -- Intermediate narration streamer (bridged mode) --------------------------
// In bridged mode Claude cannot call the Telegram reply tool, so its progress
// narration only lands in the session JSONL. Poll that file while the worker
// runs and forward each new assistant text block as it appears.
//
// Dedup strategy: track sent uuids in a per-turn Set, and only consider records
// whose timestamp is at/after the turn start. The timestamp gate makes this
// safe even when the tail-read window doesn't reach the turn's first record.
//
// Returns { stop() } — stop() drains one final time, then clears the interval.
function startIntermediateStreamer(bot, chat_id, threadId, topic, ux, onSent) {
  const pollMs = Math.max(5000, ux.stream_poll_ms || 15000)
  const MIN_CHARS = 12          // skip trivial "ok"-tier fragments
  const MAX = 3900
  const startedAtIso = new Date().toISOString()
  const sentUuids = new Set()
  const apiErrors = []
  let stopped = false
  let draining = false

  const jsonlPath = require('./dispatch').sessionJsonlPath(
    topic.project_dir || '/root', topic.session_id)

  async function drain() {
    if (draining) return
    draining = true
    let didSend = false
    try {
      const fresh = bridge.findAssistantMessagesAfter(jsonlPath, startedAtIso, sentUuids)
      for (const msg of fresh) {
        sentUuids.add(msg.uuid)
        // Artifacts never reach the chat verbatim, but an API error must not
        // vanish silently — remember it so the turn can report the failure.
        if (msg.kind) {
          if (msg.kind === 'api_error') {
            apiErrors.push(String(msg.text || '').trim())
            console.error('tg-router: API error artifact in session:', String(msg.text || '').slice(0, 120))
          }
          continue
        }
        const body = String(msg.text || '').trim()
        if (body.length < MIN_CHARS) continue
        const html = bridge.markdownToTelegramHtml(body)
        const tgOpts = {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          message_thread_id: threadId != null ? Number(threadId) : undefined,
        }
        const chunks = html.length <= MAX
          ? [html]
          : bridge.splitForTelegram(html, MAX - 50)
        for (const chunk of chunks) {
          await bot.api.sendMessage(chat_id, chunk, tgOpts).catch(async () => {
            const plainOpts = { ...tgOpts }
            delete plainOpts.parse_mode
            await bot.api.sendMessage(chat_id, chunk.replace(/<[^>]+>/g, ''), plainOpts)
              .catch(() => {})
          })
        }
        didSend = true
        // Keep the final auto-pull from re-sending what we already streamed.
        bridge.setLastPulledUuid(chat_id, threadId, msg.uuid)
      }
    } catch (err) {
      console.error('tg-router: streamer drain failed:', err.message || err)
    } finally {
      draining = false
    }
    // Once per batch, not per message — narration is chatty and each refloat
    // costs a delete + a send.
    if (didSend && onSent) {
      try { await onSent() } catch (err) {
        console.error('tg-router: onSent hook failed:', err.message || err)
      }
    }
  }

  const interval = setInterval(() => { if (!stopped) drain() }, pollMs)

  return {
    async stop() {
      stopped = true
      clearInterval(interval)
      // Worker just exited — flush whatever landed after the last poll.
      await drain().catch(() => {})
    },
    apiErrors() { return apiErrors },
  }
}

// -- Main dispatch for a single message -------------------------------------
async function handleInbound(bot, ctx, text, attachment) {
  const botUsername = bot.botInfo?.username

  // DIAG: одна строка на каждое входящее. Это единственный способ узнать
  // thread_id ещё не заведённого топика — без него новый топик в routing.json
  // не прописать. Метка инстанса из env, чтобы в общем journal было видно,
  // чей это роутер.
  try {
    const chat = ctx.chat || {}
    const from = ctx.from || {}
    const m = ctx.message || {}
    const topicName = m.is_topic_message && m.reply_to_message?.forum_topic_created?.name
    console.error(`${LOG_LABEL}: [diag] chat_id=${chat.id} chat_type=${chat.type} chat_title="${chat.title || ''}" thread_id=${m.message_thread_id ?? 'null'} topic="${topicName || ''}" user_id=${from.id} username=${from.username || ''} text="${(text || '').slice(0, 80).replace(/\n/g, ' ')}"`)
  } catch {}

  const result = gate(ctx, botUsername)

  if (result.action === 'drop') {
    console.error(`${LOG_LABEL}: [diag] DROP chat_id=${ctx.chat?.id} reason=gate-rejected`)
    return
  }
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

  // ack reaction on the user message (instant signal) — media handlers already
  // set it before starting download/transcribe, skip to avoid double-set.
  if (ux.ack_reaction && !ctx.__acked) {
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

  const lockPath = lockPathFor(threadId)

  const prompt = `${buildChannelTag({ ctx, threadId, imagePath: attachment?.kind === 'photo' ? attachment.path : undefined, attachment: attachment && attachment.kind !== 'photo' ? attachment : undefined })}\n${text || ''}`

  // A worker is already running for this topic: hand the message to it instead
  // of blocking. The active holder drains the buffer and runs another pass, so
  // the user can keep adding context to work in progress.
  if (isLockBusy(lockPath)) {
    const opts = threadId != null ? { message_thread_id: Number(threadId) } : {}
    const accepted = pushFollowup(lockPath, prompt)
    bot.api.sendMessage(
      chat_id,
      accepted
        ? '➕ <i>принято — учту в текущей задаче</i>'
        : '⚠️ <i>слишком много дополнений в очереди, подожди текущую задачу</i>',
      accepted
        ? { ...opts, parse_mode: 'HTML', reply_markup: buildFollowupKeyboard(threadId) }
        : { ...opts, parse_mode: 'HTML' },
    ).catch(() => {})
    return
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

    const isBridged = topic.mode === 'vscode_bridge'
    // Bridged sessions run long-horizon agentic work (Opus 5 can iterate for
    // tens of minutes). Give them a 60-minute floor regardless of the shared
    // ux.worker_timeout_ms, which is tuned for short one-shot topic replies.
    const BRIDGED_TIMEOUT_FLOOR_MS = 60 * 60 * 1000
    const timeoutMs = isBridged
      ? Math.max(ux.worker_timeout_ms || 0, BRIDGED_TIMEOUT_FLOOR_MS)
      : (ux.worker_timeout_ms || 600000)

    // Stream intermediate assistant narration to TG while the worker runs, so
    // the user sees reasoning-in-progress instead of silence until the end.
    const streamer = isBridged && ux.stream_intermediate !== false
      ? startIntermediateStreamer(bot, chat_id, threadId, topic, ux, async () => {
          // Narration just pushed the status line up — bring it back down so
          // elapsed time stays visible at the bottom of the topic.
          if (statusId) {
            statusId = await refloatStatus(bot, chat_id, threadId, statusId, Date.now() - startedAt)
          }
        })
      : null

    let outcome
    let currentPrompt = prompt
    let passes = 0
    const MAX_PASSES = 12          // backstop against an endless follow-up chain
    try {
     // Run the turn, then keep running while the user has added more context.
     // Each pass is a normal one-shot worker on the same session, so follow-ups
     // land as ordinary sequential turns with full history.
     while (true) {
      passes++
      activeWorkers.set(lockPath, { handle: null, interrupted: false })
      const res = await runClaudeWorker({
        project_dir: topic.project_dir || '/root',
        session_id: topic.session_id,
        prompt: currentPrompt,
        timeout_ms: timeoutMs,
        bridged: isBridged,
        model: modelMod.resolveModelFlag(topic.session_id,
          require('./dispatch').sessionJsonlPath(topic.project_dir || '/root', topic.session_id)),
        onSpawn: (handle) => {
          const entry = activeWorkers.get(lockPath)
          if (entry) entry.handle = handle
        },
      })
      // A user-requested kill is not a failure: it means "drop this, use my
      // addition instead". Report it as ok so the loop proceeds to the buffer
      // and closeStatus doesn't paint it as an error.
      const interrupted = wasInterrupted(lockPath)
      activeWorkers.delete(lockPath)
      outcome = {
        ok: interrupted ? true : (res.code === 0 && !res.killed),
        code: res.code,
        timedOut: res.killed && !interrupted,
        interrupted,
        durationMs: res.durationMs,
        errSnippet: interrupted ? '' : (res.stderr || '').slice(-500),
        stdoutSnippet: (res.stdout || '').slice(-500),
      }
      if (interrupted) {
        console.error(`tg-router: pass ${passes} interrupted by user, draining follow-ups`)
      }
      if (res.code === 0) {
        console.error(`tg-router: [worker ok] topic=${topic.name || 'general'} dur=${res.durationMs}ms${res.healed ? ' (auto-healed)' : ''}`)
      } else {
        console.error(`tg-router: [worker FAIL] topic=${topic.name || 'general'} code=${res.code} killed=${res.killed}\n${res.stderr}`)
      }
      // If session was auto-healed, notify the user out-of-band.
      if (res.healed && res.healedInfo && res.healedInfo.healed) {
        try {
          const dropped = res.healedInfo.droppedLines || 0
          const bak = res.healedInfo.backupPath
          const opts2 = threadId != null ? { message_thread_id: Number(threadId) } : {}
          opts2.parse_mode = 'HTML'
          await bot.api.sendMessage(
            chat_id,
            `♻️ <i>Сессия была в half-state (брошенный tool_use), автоматически восстановлена.</i>\n` +
            `Удалено хвостовых записей: <b>${dropped}</b>. Backup: <code>${bak}</code>`,
            opts2,
          )
        } catch (e) {
          console.error('tg-router: heal notify failed:', e?.description || e?.message)
        }
      }

      // Did the user add context while this pass ran? If so, feed it straight
      // back in. Stop on failure — replaying follow-ups onto a broken session
      // would just multiply the error.
      if (!outcome.ok || !hasFollowups(lockPath) || passes >= MAX_PASSES) {
        // Never leave a buffer behind: a stale follow-up would otherwise be
        // replayed into some later, unrelated turn. Drop it and say so, so the
        // user knows their addition needs re-sending.
        if (hasFollowups(lockPath)) {
          const dropped = drainFollowups(lockPath)
          const reason = passes >= MAX_PASSES
            ? `цепочка дополнений достигла лимита (${MAX_PASSES} проходов)`
            : 'предыдущий проход упал'
          console.error(`tg-router: dropping ${dropped.length} follow-up(s): ${reason}`)
          const dOpts = threadId != null ? { message_thread_id: Number(threadId) } : {}
          bot.api.sendMessage(
            chat_id,
            `⚠️ <i>Не обработал ${dropped.length} дополнени${dropped.length === 1 ? 'е' : 'я'} — ${reason}. Отправь заново.</i>`,
            { ...dOpts, parse_mode: 'HTML' },
          ).catch(() => {})
        }
        break
      }
      const followups = drainFollowups(lockPath)
      // On interrupt the killed pass produced no answer, so its request has to
      // be restated — otherwise the next pass only sees the addition. Relying
      // on session history is not safe: an early SIGKILL can land before the
      // user turn is flushed (measured: killed at 1s → JSONL not even created,
      // at 3s → turn present), which would lose the task entirely.
      // A normally-completed pass needs no restating — its answer is history.
      // Frame the restatement explicitly. The task also sits in history (when
      // the kill was late enough to flush it), so a bare concatenation reads as
      // "asked twice" and invites redoing partially-completed work. Naming it a
      // restart of a discarded pass removes that ambiguity.
      const restated = outcome.interrupted
        ? [
            '[Предыдущий проход по этой задаче прерван пользователем, его результат отброшен.',
            'Начни заново с учётом дополнения ниже. Исходная задача:]',
            '',
            currentPrompt,
            '',
            '[Дополнение:]',
          ].join('\n')
        : null
      currentPrompt = [
        ...(restated ? [restated] : []),
        ...followups.map(f => f.text),
      ].join('\n\n')
      console.error(`tg-router: draining ${followups.length} follow-up(s), pass ${passes + 1}`)
      // Say it out loud: without this the next pass starts silently (only a
      // typing indicator) and reads as "everything finished".
      const fuOpts = threadId != null ? { message_thread_id: Number(threadId) } : {}
      const n = followups.length
      await bot.api.sendMessage(
        chat_id,
        `➕ <i>обрабатываю ${n === 1 ? 'дополнение' : `дополнения (${n})`}…</i>`,
        { ...fuOpts, parse_mode: 'HTML' },
      ).catch(() => {})
      // That marker pushed the status up too — keep it pinned to the bottom.
      if (statusId) {
        statusId = await refloatStatus(bot, chat_id, threadId, statusId, Date.now() - startedAt)
      }
      bot.api.sendChatAction(chat_id, 'typing', fuOpts).catch(() => {})
     }
    } catch (err) {
      outcome = { ok: false, code: -1, timedOut: false, durationMs: Date.now() - startedAt, errSnippet: err.message }
    } finally {
      clearInterval(typingInt)
      clearInterval(tickInt)
      if (streamer) await streamer.stop()
      await statusPromise
      // Safety net for a silent failure: the CLI can answer with an API error
      // yet still exit 0, so closeStatus would paint "✅ готово" over nothing.
      // When the worker claims success but the turn only produced API errors,
      // say so — the raw text stays filtered, this is the readable version.
      if (streamer && outcome && outcome.ok) {
        const errs = streamer.apiErrors()
        if (errs.length) {
          // closeStatus runs errSnippet through classifyWorkerError itself, so
          // handing it the raw text yields the right "🚧 модель перегружена".
          outcome = { ...outcome, ok: false, code: 0, errSnippet: errs.join('\n').slice(-500) }
          console.error('tg-router: worker exited 0 but answered with API error — reporting as failure')
        }
      }
      await closeStatus(bot, chat_id, statusId, ux, outcome)
    }
    // Bridged-mode post-turn actions:
    //   1. Auto-pull final assistant message from JSONL and send to TG (since
    //      Claude in bridged mode can't call mcp__plugin_telegram_telegram__reply).
    //   2. Send floating control panel below it.
    if (topic.mode === 'vscode_bridge' && outcome.ok) {
      const bridgeState = bridge.getBridge(chat_id, threadId)
      if (bridgeState) {
        // 1) Auto-pull final assistant
        try {
          const jsonlPath = require('path').join(
            require('os').homedir(), '.claude', 'projects',
            bridgeState.project_dir.replace(/[^a-zA-Z0-9]/g, '-'),
            `${bridgeState.session_id}.jsonl`
          )
          const latest = bridge.findLastAssistantMessage(jsonlPath)
          if (latest && latest.uuid && latest.uuid !== bridgeState.last_pulled_uuid) {
            bridge.setLastPulledUuid(chat_id, threadId, latest.uuid)
            const htmlBody = bridge.markdownToTelegramHtml(latest.text)
            const MAX = 3900
            const tgOpts = { parse_mode: 'HTML', disable_web_page_preview: true, message_thread_id: threadId != null ? Number(threadId) : undefined }
            try {
              if (htmlBody.length <= MAX) {
                await bot.api.sendMessage(chat_id, htmlBody, tgOpts)
              } else {
                // chunk on natural boundaries (paragraph → sentence → space)
                const chunks = bridge.splitForTelegram(htmlBody, MAX - 50)
                for (const chunk of chunks) {
                  await bot.api.sendMessage(chat_id, chunk, tgOpts)
                    .catch(async () => {
                      const plainOpts = { ...tgOpts }
                      delete plainOpts.parse_mode
                      await bot.api.sendMessage(chat_id, chunk.replace(/<[^>]+>/g, ''), plainOpts).catch(() => {})
                    })
                }
              }
            } catch (err) {
              console.error('tg-router: auto-pull HTML send failed, fallback plain:', err?.description || err?.message)
              const plainOpts = { message_thread_id: threadId != null ? Number(threadId) : undefined }
              await bot.api.sendMessage(chat_id, latest.text.slice(0, 4096), plainOpts).catch(() => {})
            }
          }
        } catch (err) {
          console.error('tg-router: auto-pull failed:', err.message)
        }
        // 2) Floating control panel
        const prevPanelId = bridge.getLastPanelMessageId(chat_id, threadId)
        if (prevPanelId) {
          await bot.api.deleteMessage(chat_id, prevPanelId).catch(() => {})
        }
        const panelOpts = threadId != null ? { message_thread_id: Number(threadId) } : {}
        panelOpts.reply_markup = bridge.buildControlPanelKeyboard(topic.session_id, topic.project_dir || '/root')
        panelOpts.parse_mode = 'HTML'
        try {
          const sent = await bot.api.sendMessage(chat_id, '🎛 <i>управление сессией</i>', panelOpts)
          bridge.setLastPanelMessageId(chat_id, threadId, sent.message_id)
        } catch (err) {
          console.error('tg-router: control panel send failed:', err?.description || err?.message)
        }
      }
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

// Set ack reaction immediately, before any long download/transcribe step.
// Reads routing to get the emoji; marks ctx so handleInbound doesn't re-set.
function earlyAck(bot, ctx) {
  try {
    const routing = loadRouting()
    const threadId = ctx.message.message_thread_id ?? null
    const topic = resolveTopic(routing, threadId)
    const ux = { ...(routing.ux || {}), ...(topic.ux || {}) }
    if (!ux.ack_reaction) return
    bot.api.setMessageReaction(String(ctx.chat.id), ctx.message.message_id,
      [{ type: 'emoji', emoji: ux.ack_reaction }]).catch(() => {})
    ctx.__acked = true
  } catch (err) {
    console.error('tg-router: earlyAck failed:', err.message || err)
  }
}

bot.on('message:text', fireAndForget(async ctx => {
  await handleInbound(bot, ctx, ctx.message.text, null)
}))

bot.on('message:photo', fireAndForget(async ctx => {
  earlyAck(bot, ctx)
  const caption = ctx.message.caption ?? '(photo)'
  let attachment = null
  try { attachment = await handlePhoto(bot, ctx) } catch (err) {
    console.error('tg-router: photo download failed:', err.message)
  }
  await handleInbound(bot, ctx, caption, attachment)
}))

bot.on('message:voice', fireAndForget(async ctx => {
  earlyAck(bot, ctx)
  let attachment = null
  try { attachment = await handleVoice(bot, ctx) } catch (err) {
    console.error('tg-router: voice download failed:', err.message)
  }
  // Use the locally-transcribed text as the message body so Claude gets plain
  // text (saves tokens — no need to call download_attachment + transcribe).
  const caption = ctx.message.caption ?? (attachment?.transcript
    ? `(voice → transcribed)\n${attachment.transcript}`
    : '(voice message)')
  await handleInbound(bot, ctx, caption, attachment)
}))

bot.on('message:document', fireAndForget(async ctx => {
  earlyAck(bot, ctx)
  const caption = ctx.message.caption ?? `(document: ${ctx.message.document.file_name || 'file'})`
  let attachment = null
  try { attachment = await handleDocument(bot, ctx) } catch (err) {
    console.error('tg-router: doc download failed:', err.message)
  }
  await handleInbound(bot, ctx, caption, attachment)
}))

bot.on('message:audio', fireAndForget(async ctx => {
  earlyAck(bot, ctx)
  let attachment = null
  try { attachment = await handleAudio(bot, ctx) } catch (err) {
    console.error('tg-router: audio download failed:', err.message)
  }
  const caption = ctx.message.caption ?? (attachment?.transcript
    ? `(audio → transcribed)\n${attachment.transcript}`
    : '(audio)')
  await handleInbound(bot, ctx, caption, attachment)
}))

bot.on('message:video', fireAndForget(async ctx => {
  earlyAck(bot, ctx)
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
  // Parse: "fu-int:<threadId|general>" — cut the running pass short so the
  // buffered follow-ups run now instead of after a long turn the user has
  // already superseded.
  const fuIntMatch = data.match(/^fu-int:(.+)$/)
  if (fuIntMatch) {
    const key = fuIntMatch[1]
    // 'general' round-trips through lockPathFor's own fallback.
    const lockPath = lockPathFor(key === 'general' ? null : key)
    if (!hasFollowups(lockPath)) {
      await ctx.answerCallbackQuery({
        text: 'Дополнение уже подхвачено — перебивать нечего',
        show_alert: false,
      }).catch(() => {})
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
      return
    }
    const didKill = interruptWorker(lockPath)
    await ctx.answerCallbackQuery({
      text: didKill ? '⚡ Перебиваю — беру дополнение' : 'Текущая задача уже завершилась',
      show_alert: false,
    }).catch(() => {})
    // Drop the button so it can't be pressed twice for the same pass.
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
    if (didKill) {
      const opts = m.message_thread_id != null ? { message_thread_id: Number(m.message_thread_id) } : {}
      await bot.api.sendMessage(
        m.chat.id,
        '⚡ <i>Текущий проход прерван — работа по нему потеряна, беру дополнение.</i>',
        { ...opts, parse_mode: 'HTML' },
      ).catch(() => {})
    }
    return
  }
  // Parse: "model:<id>" | "model:__show" | "model:__reset" | "model:__close".
  // Scoped to the session the topic currently drives, not to the topic itself.
  const modelMatch = data.match(/^model:(.+)$/)
  if (modelMatch) {
    const chatId = String(m.chat.id)
    const threadId = m.message_thread_id ?? null
    const st = bridge.getBridge(chatId, threadId)
    const sessionId = st ? st.session_id : null
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: 'Топик не привязан к сессии', show_alert: true }).catch(() => {})
      return
    }
    const jsonl = require('./dispatch').sessionJsonlPath(st.project_dir || '/root', sessionId)
    const picked = modelMatch[1]

    // Expanded picker: full detail + the model list.
    const pickerBody = () => {
      const cur = modelMod.getModelSetting(sessionId)
      const d = modelMod.describe(sessionId, jsonl)
      return [
        '<b>Модель этой сессии</b>',
        '',
        `• сессия: <code>${sessionId.slice(0, 8)}</code>`,
        `• режим: <b>${modelMod.labelFor(cur)}</b>`,
        `• применяется: <code>${d.effective || 'дефолт CLI'}</code> — ${d.note}`,
        `• источник: ${modelMod.hasOverride(sessionId) ? 'закреплено за сессией' : 'глобальный дефолт'}`,
        '',
        'Выбери модель или вернись назад.',
      ].join('\n')
    }

    // Collapsed result: one line of truth + the normal session panel, so the
    // picker is never a dead end — choosing (or cancelling) lands you back in
    // the session menu instead of the same list of buttons.
    const collapsedBody = () => {
      const cur = modelMod.getModelSetting(sessionId)
      const d = modelMod.describe(sessionId, jsonl)
      return [
        `🧠 <b>Модель</b> · сессия <code>${sessionId.slice(0, 8)}</code>`,
        `${modelMod.labelFor(cur)} → <code>${d.effective || 'дефолт CLI'}</code> · ${d.note}`,
        '',
        'Применится со следующего сообщения.',
      ].join('\n')
    }

    const render = async (body, keyboard) => {
      try {
        await ctx.api.editMessageText(m.chat.id, m.message_id, body, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        })
      } catch (err) {
        if (!(err instanceof GrammyError && err.error_code === 400)) {
          console.error('tg-router: model picker edit failed:', err.message || err)
        }
      }
    }

    // Panel button: open the picker as a NEW message. Editing in place would
    // overwrite the assistant reply the panel is attached to.
    if (picked === '__show') {
      await ctx.answerCallbackQuery().catch(() => {})
      // If the panel is attached to our own collapsed model card, expand it in
      // place — otherwise the card and the picker would pile up as separate
      // messages every toggle.
      const isOwnCard = typeof m.text === 'string' && m.text.startsWith('🧠 Модель')
      if (isOwnCard) {
        await render(pickerBody(), modelMod.buildPickerKeyboard(sessionId))
        return
      }
      const sendOpts = { parse_mode: 'HTML', reply_markup: modelMod.buildPickerKeyboard(sessionId) }
      if (threadId != null) sendOpts.message_thread_id = Number(threadId)
      await ctx.api.sendMessage(m.chat.id, pickerBody(), sendOpts).catch(err => {
        console.error('tg-router: model picker send failed:', err.message || err)
      })
      return
    }

    // Back: collapse without changing anything.
    if (picked === '__close') {
      await ctx.answerCallbackQuery().catch(() => {})
      await render(collapsedBody(), bridge.buildModelCardKeyboard())
      return
    }

    let note
    if (picked === '__reset') {
      modelMod.clearModel(sessionId)
      note = `↩️ Сброшено к глобальному: ${modelMod.labelFor(modelMod.getModelSetting(sessionId))}`
    } else {
      modelMod.setModel(sessionId, picked)
      note = `✅ Модель: ${modelMod.labelFor(picked)}`
    }
    await ctx.answerCallbackQuery({ text: note }).catch(() => {})
    await render(collapsedBody(), bridge.buildModelCardKeyboard())
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
  // If session is huge (🔴 tier), prompt for confirmation/compact instead of connecting immediately.
  const conMatch = data.match(/^con:([a-f0-9-]{8,})$/i)
  if (conMatch) {
    const wantedId = conMatch[1]
    const all = bridge.scanSessions({ excludeTgRouted: true, excludeAgents: false, limit: 5000 })
    const session = all.find(s => s.session_id === wantedId)
    if (!session) {
      await ctx.answerCallbackQuery({ text: 'Сессия не найдена (возможно удалена)', show_alert: true }).catch(() => {})
      return
    }
    // Use real context usage (from last assistant message in JSONL) — same metric VS Code uses.
    const jsonlPathForUsage = require('path').join(require('os').homedir(), '.claude', 'projects', session.slug, `${session.session_id}.jsonl`)
    const usage = bridge.getSessionContextUsage(jsonlPathForUsage)
    const tier = bridge.contextUsageTier(usage?.percent)
    if (tier.needsCompact) {
      // Show confirmation with [compact+connect] [connect anyway] [cancel]
      const titleRaw = session.custom_title || session.ai_title || session.project_slug || session.session_id.slice(0, 8)
      const titleHtml = String(titleRaw).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const warnText = [
        `⚠️ <b>Сессия близка к лимиту контекста</b>`,
        '',
        `${titleHtml}`,
        `${tier.emoji} ${usage.percent}% (${(usage.tokens / 1000).toFixed(0)}K / ${(usage.limit / 1000).toFixed(0)}K токенов). Рекомендуется /compact.`,
        '',
        'Что делаем?',
      ].join('\n')
      const warnKeyboard = {
        inline_keyboard: [
          [{ text: '🗜 Compact и подключить', callback_data: `compact-con:${session.session_id}` }],
          [{ text: '🚀 Подключить как есть', callback_data: `force-con:${session.session_id}` }],
          [{ text: '✖ Отмена', callback_data: 'cancel-con' }],
        ],
      }
      try {
        await bot.api.editMessageText(m.chat.id, m.message_id, warnText, {
          parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: warnKeyboard,
        })
      } catch (err) {
        console.error('tg-router: tier warn edit failed:', err?.description || err?.message)
      }
      await ctx.answerCallbackQuery({ text: `${tier.emoji} ${tier.label}` }).catch(() => {})
      return
    }
    const chatId = String(m.chat.id)
    const threadId = m.message_thread_id ?? null
    bridge.setBridge(chatId, threadId, session.session_id, session.cwd)
    const titleRaw = session.custom_title || session.ai_title || session.project_slug || session.session_id.slice(0, 8)
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
  // Parse: "quick:new" — create a fresh empty bridged session (like "+ New" in VS Code Sidebar).
  if (data === 'quick:new') {
    const chatId = String(m.chat.id)
    const threadId = m.message_thread_id ?? null
    // Delete previous floating panel if any.
    const prevPanelId = bridge.getLastPanelMessageId(chatId, threadId)
    if (prevPanelId) {
      await bot.api.deleteMessage(chatId, prevPanelId).catch(() => {})
    }
    const newSessionId = bridge.createBridgeSession(chatId, threadId, '/root')
    const replyText = [
      '🟢 <b>Новая сессия создана</b>',
      `session: <code>${newSessionId.slice(0, 8)}</code>`,
      `project: <code>/root</code>`,
      '',
      'Пиши обычным текстом — это будет первое сообщение в новой пустой сессии.',
    ].join('\n')
    const baseOpts = { parse_mode: 'HTML', disable_web_page_preview: true }
    // For fresh sessions there's no assistant reply to pull yet — use slimmer keyboard.
    const tgOpts = { ...baseOpts, message_thread_id: threadId != null ? Number(threadId) : undefined, reply_markup: bridge.buildFreshConnectedKeyboard() }
    try {
      await bot.api.sendMessage(m.chat.id, replyText, tgOpts)
    } catch (err) {
      console.error('tg-router: quick:new send failed:', err?.description || err?.message)
    }
    await ctx.answerCallbackQuery({ text: `Создана новая сессия ${newSessionId.slice(0, 8)}` }).catch(() => {})
    return
  }
  // Parse: "quick:pull" — fetch latest assistant message from connected session.
  if (data === 'quick:pull') {
    const chatId = String(m.chat.id)
    const threadId = m.message_thread_id ?? null
    const state = bridge.getBridge(chatId, threadId)
    if (!state) {
      await ctx.answerCallbackQuery({ text: 'Не подключено к сессии', show_alert: true }).catch(() => {})
      return
    }
    const jsonlPath = require('path').join(require('os').homedir(), '.claude', 'projects',
      state.project_dir.replace(/[/_]/g, '-'), `${state.session_id}.jsonl`)
    const latest = bridge.findLastAssistantMessage(jsonlPath)
    if (!latest || !latest.uuid) {
      await ctx.answerCallbackQuery({
        text: latest?.isStreaming ? 'Сессия только запустилась' : 'Нет ответов в этой сессии',
        show_alert: false,
      }).catch(() => {})
      return
    }
    const baseOpts = { parse_mode: 'HTML', disable_web_page_preview: true }
    const tgOpts = { ...baseOpts, message_thread_id: threadId != null ? Number(threadId) : undefined }
    // Case A: same as last pulled → nothing new
    if (state.last_pulled_uuid && state.last_pulled_uuid === latest.uuid) {
      if (latest.isStreaming || latest.hasActivityAfter) {
        await ctx.answerCallbackQuery({ text: '🔄 Сессия работает, новый ответ ещё не готов' }).catch(() => {})
      } else {
        const ago = latest.timestamp ? new Date(latest.timestamp).toISOString().slice(11, 16) + ' UTC' : 'недавно'
        await ctx.answerCallbackQuery({
          text: `✅ Свежих ответов нет (последний был в ${ago})`,
          show_alert: false,
        }).catch(() => {})
      }
      return
    }
    // Case B: new answer — send it
    bridge.setLastPulledUuid(chatId, threadId, latest.uuid)
    // Telegram limit ~4096 chars per message; chunk if needed.
    // Convert Markdown → HTML so **bold**, `code`, ``` blocks render properly.
    const MAX = 3900
    const htmlBody = bridge.markdownToTelegramHtml(latest.text)
    const header = '<b>📥 Свежий ответ</b>\n\n'
    let trailer = ''
    if (latest.hasActivityAfter || latest.isStreaming) {
      trailer = '\n\n<i>⏳ Сессия продолжает работу — нажми ещё раз через минуту чтобы получить следующий ответ.</i>'
    }
    try {
      if (htmlBody.length <= MAX - header.length - trailer.length) {
        await bot.api.sendMessage(m.chat.id, header + htmlBody + trailer, tgOpts)
      } else {
        // Split on natural boundaries: paragraph → newline → sentence → word.
        const chunks = bridge.splitForTelegram(htmlBody, MAX - 50)
        for (let i = 0; i < chunks.length; i++) {
          const prefix = i === 0 ? header : ''
          const suffix = i === chunks.length - 1 ? trailer : '\n<i>(продолжение ниже)</i>'
          try {
            await bot.api.sendMessage(m.chat.id, prefix + chunks[i] + suffix, tgOpts)
          } catch (err) {
            // Fallback to plain text on HTML parse error mid-chunk
            console.error('tg-router: chunk HTML send failed, fallback to plain:', err?.description || err?.message)
            const plainOpts = { ...tgOpts }
            delete plainOpts.parse_mode
            await bot.api.sendMessage(m.chat.id, (prefix.replace(/<[^>]+>/g, '') + chunks[i].replace(/<[^>]+>/g, '') + suffix.replace(/<[^>]+>/g, '')), plainOpts).catch(() => {})
          }
        }
      }
    } catch (err) {
      console.error('tg-router: quick:pull send failed:', err?.description || err?.message)
      // Final fallback — strip all HTML, send as plain text
      try {
        const plainOpts = { ...tgOpts }
        delete plainOpts.parse_mode
        await bot.api.sendMessage(m.chat.id, '📥 Свежий ответ\n\n' + latest.text, plainOpts)
      } catch {}
    }
    // Floating control panel — same as after worker_ok (delete previous, send new)
    {
      const prevPanelId = bridge.getLastPanelMessageId(chatId, threadId)
      if (prevPanelId) {
        await bot.api.deleteMessage(chatId, prevPanelId).catch(() => {})
      }
      const panelOpts = threadId != null ? { message_thread_id: Number(threadId) } : {}
      panelOpts.reply_markup = bridge.buildControlPanelKeyboard(
        state.session_id, state.project_dir || '/root')
      panelOpts.parse_mode = 'HTML'
      try {
        const sent = await bot.api.sendMessage(chatId, '🎛 <i>управление сессией</i>', panelOpts)
        bridge.setLastPanelMessageId(chatId, threadId, sent.message_id)
      } catch (err) {
        console.error('tg-router: control panel after pull send failed:', err?.description || err?.message)
      }
    }
    await ctx.answerCallbackQuery().catch(() => {})
    return
  }
  // Parse: "force-con:<session_id>" — user chose to connect to a heavy session without compact.
  const forceConMatch = data.match(/^force-con:([a-f0-9-]{8,})$/i)
  if (forceConMatch) {
    const wantedId = forceConMatch[1]
    const all = bridge.scanSessions({ excludeTgRouted: true, excludeAgents: false, limit: 5000 })
    const session = all.find(s => s.session_id === wantedId)
    if (!session) {
      await ctx.answerCallbackQuery({ text: 'Сессия не найдена', show_alert: true }).catch(() => {})
      return
    }
    const chatId = String(m.chat.id)
    const threadId = m.message_thread_id ?? null
    bridge.setBridge(chatId, threadId, session.session_id, session.cwd)
    const titleRaw = session.custom_title || session.ai_title || session.project_slug || session.session_id.slice(0, 8)
    const titleHtml = String(titleRaw).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const replyText = [
      `🟢 <b>Подключено (heavy)</b>`,
      titleHtml,
      '',
      `Пиши обычным текстом — сообщения уйдут в эту сессию. Если ответ упадёт — попробуй <code>🗜 Compact</code>.`,
    ].join('\n')
    try {
      await bot.api.editMessageText(m.chat.id, m.message_id, replyText, {
        parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: bridge.buildConnectedKeyboard(),
      })
    } catch (err) {
      console.error('tg-router: force-con edit failed:', err?.description || err?.message)
    }
    await ctx.answerCallbackQuery({ text: 'Подключено без сжатия' }).catch(() => {})
    return
  }
  // Parse: "compact-con:<session_id>" — user chose to compact the session BEFORE connecting.
  const compactConMatch = data.match(/^compact-con:([a-f0-9-]{8,})$/i)
  if (compactConMatch) {
    const wantedId = compactConMatch[1]
    const all = bridge.scanSessions({ excludeTgRouted: true, excludeAgents: false, limit: 5000 })
    const session = all.find(s => s.session_id === wantedId)
    if (!session) {
      await ctx.answerCallbackQuery({ text: 'Сессия не найдена', show_alert: true }).catch(() => {})
      return
    }
    // Bind first so the auto-pull after spawn sends compact result into the topic.
    const chatId = String(m.chat.id)
    const threadId = m.message_thread_id ?? null
    bridge.setBridge(chatId, threadId, session.session_id, session.cwd)
    // Edit message to "compacting..." status
    try {
      await bot.api.editMessageText(m.chat.id, m.message_id,
        `🗜 <b>Compact в процессе…</b>\nЭто может занять 1-3 минуты. Когда закончится, я отвечу в этом топике.`,
        { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: [] } })
    } catch {}
    await ctx.answerCallbackQuery({ text: 'Запускаю compact' }).catch(() => {})
    const tgOpts = { parse_mode: 'HTML', disable_web_page_preview: true, message_thread_id: threadId != null ? Number(threadId) : undefined }
    ;(async () => {
      try {
        const dispatchMod = require('./dispatch')
        const result = await dispatchMod.compactViaTruncate(
          session.cwd || '/root', session.session_id,
          { tailBytes: 8 * 1024 * 1024,
            model: modelMod.resolveModelFlag(session.session_id,
              dispatchMod.sessionJsonlPath(session.cwd || '/root', session.session_id)) })
        if (!result.ok) {
          await bot.api.sendMessage(m.chat.id, `✖ Compact упал: ${result.error}. Подключение отменено.`, tgOpts).catch(() => {})
          bridge.clearBridge(chatId, threadId)
          return
        }
        bridge.setLastPulledUuid(chatId, threadId, null)
        const oldMb = (result.oldBytes / (1024 * 1024)).toFixed(1)
        const newMb = (result.newBytes / (1024 * 1024)).toFixed(2)
        const titleRaw = session.custom_title || session.ai_title || session.project_slug || session.session_id.slice(0, 8)
        const titleHtml = String(titleRaw).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        const confirmText = [
          `🟢 <b>Подключено (после compact)</b>`,
          titleHtml,
          ``,
          `Сжато: <b>${oldMb} МБ → ${newMb} МБ</b> (-${result.reduction}%). Бэкап: <code>${result.backup}</code>.`,
          ``,
          `Пиши обычным текстом — сессия продолжается с того же session_id, контекст сохранён в summary.`,
        ].join('\n')
        await bot.api.sendMessage(m.chat.id, confirmText, { ...tgOpts, reply_markup: bridge.buildConnectedKeyboard() }).catch(() => {})
      } catch (err) {
        console.error('tg-router: compact-con failed:', err.message)
        await bot.api.sendMessage(m.chat.id, `✖ Compact crashed: ${err.message}`, tgOpts).catch(() => {})
        bridge.clearBridge(chatId, threadId)
      }
    })()
    return
  }
  // Parse: "cancel-con" — user cancelled the heavy-session prompt.
  if (data === 'cancel-con') {
    try {
      await bot.api.editMessageText(m.chat.id, m.message_id, '✖ Подключение отменено. Используй <code>/list</code> для нового выбора.',
        { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: [] } })
    } catch {}
    await ctx.answerCallbackQuery({ text: 'Отменено' }).catch(() => {})
    return
  }
  // Parse: "quick:list" | "quick:status" | "quick:disconnect" | "quick:compact"
  const quickMatch = data.match(/^quick:(list|status|disconnect|compact)$/)
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
    if (action === 'compact') {
      const state = bridge.getBridge(chatId, threadId)
      if (!state) {
        await ctx.answerCallbackQuery({ text: 'Нет активной сессии', show_alert: true }).catch(() => {})
        return
      }
      await ctx.answerCallbackQuery({ text: '🗜 Запускаю compact (1-3 мин)' }).catch(() => {})
      const tgOpts = { parse_mode: 'HTML', disable_web_page_preview: true, message_thread_id: threadId != null ? Number(threadId) : undefined }
      try {
        await bot.api.sendMessage(m.chat.id, '🗜 <b>Compact в процессе…</b>\nСжимаю историю сессии: 1) генерирую summary, 2) переписываю JSONL. 1-3 минуты.', tgOpts)
      } catch {}
      ;(async () => {
        try {
          const dispatchMod = require('./dispatch')
          // Truncated-JSONL hack: build a tmp session with only the last ~8MB of conversation,
          // ask claude on that tmp session for a summary, write isCompactSummary into the
          // original JSONL.
          const result = await dispatchMod.compactViaTruncate(
            state.project_dir || '/root', state.session_id,
            { tailBytes: 8 * 1024 * 1024,
              model: modelMod.resolveModelFlag(state.session_id,
                dispatchMod.sessionJsonlPath(state.project_dir || '/root', state.session_id)) })
          if (!result.ok) {
            await bot.api.sendMessage(m.chat.id, `✖ Compact упал: ${result.error}`, tgOpts).catch(() => {})
            return
          }
          bridge.setLastPulledUuid(chatId, threadId, null)
          const oldMb = (result.oldBytes / (1024 * 1024)).toFixed(1)
          const newMb = (result.newBytes / (1024 * 1024)).toFixed(2)
          const confirmText = [
            `🗜 <b>Compact завершён</b>`,
            ``,
            `Сессия сжата: <b>${oldMb} МБ → ${newMb} МБ</b> (-${result.reduction}%).`,
            `Та же session_id, контекст сохранён в виде summary (${result.summaryLen} символов).`,
            `Бэкап: <code>${result.backup}</code>.`,
            ``,
            `Можешь продолжать писать в эту же сессию.`,
          ].join('\n')
          await bot.api.sendMessage(m.chat.id, confirmText, tgOpts).catch(() => {})
        } catch (err) {
          console.error('tg-router: quick-compact failed:', err.message)
          await bot.api.sendMessage(m.chat.id, `✖ Compact crashed: ${err.message}`, tgOpts).catch(() => {})
        }
      })()
      return
    }
    if (action === 'disconnect') {
      const prev = bridge.getBridge(chatId, threadId)
      if (!prev) {
        await ctx.answerCallbackQuery({ text: 'Уже отключено', show_alert: false }).catch(() => {})
        return
      }
      // Delete floating control panel if it exists (no need for it after disconnect).
      const prevPanelId = bridge.getLastPanelMessageId(chatId, threadId)
      if (prevPanelId) {
        await bot.api.deleteMessage(chatId, prevPanelId).catch(() => {})
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
    // Publish the command list so Telegram autocompletes them when typing "/".
    // Without this the commands work but are effectively undiscoverable.
    bot.api.setMyCommands([
      { command: 'status',     description: 'состояние сессии и модель' },
      { command: 'model',      description: 'показать/сменить модель сессии' },
      { command: 'list',       description: 'список сессий Claude Code' },
      { command: 'connect',    description: 'подключить топик к сессии' },
      { command: 'disconnect', description: 'отвязать топик от сессии' },
      { command: 'digest',     description: 'сгенерировать дайджест' },
      { command: 'reset',      description: 'ротировать сессию' },
      { command: 'rollback',   description: 'откатить на предыдущую сессию' },
      { command: 'help',       description: 'справка по командам' },
    ]).catch(err => console.error('tg-router: setMyCommands failed:', err.message || err))
  },
}).catch(err => {
  console.error('tg-router: fatal start error:', err.message || err)
  process.exit(3)
})
