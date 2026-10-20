'use strict'

/**
 * Сторона роутера для моста подтверждений (см. perm-mcp.js).
 *
 * Воркер кладёт вопрос файлом `<id>.req.json`, роутер показывает его кнопками в
 * том же топике, откуда пришла задача, и записывает `<id>.res.json`. Каталог
 * лежит внутри TELEGRAM_STATE_DIR, поэтому контуры владельца и user2
 * разделяются тем же механизмом, что и всё остальное, — без отдельной логики.
 */

const { readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync, existsSync, renameSync } = require('fs')
const { join } = require('path')

const STATE_DIR = process.env.TELEGRAM_STATE_DIR || '/root/.claude/channels/telegram'
const PERM_DIR = process.env.TG_PERM_DIR || join(STATE_DIR, 'permissions')
const SCAN_MS = 700
// Сколько ждём ответа. Должно быть заметно меньше таймаута воркера, иначе
// воркера убьют раньше, чем истечёт ожидание, и Claude не увидит отказ.
const WAIT_MS = Number(process.env.TG_PERM_TIMEOUT_MS || 5 * 60 * 1000)

function permDir() {
  mkdirSync(PERM_DIR, { recursive: true })
  return PERM_DIR
}

function reqPath(id) { return join(PERM_DIR, `${id}.req.json`) }
function resPath(id) { return join(PERM_DIR, `${id}.res.json`) }
function turnAllowPath(turnId) { return join(PERM_DIR, `turn-${turnId}.allow`) }

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Короткая человеческая формулировка того, что именно просят сделать. Полный
// JSON инструмента в сообщении не нужен: решение принимают по «что и куда»,
// а простыня из content'а сделает кнопку нечитаемой.
function describeRequest(toolName, input) {
  const i = input || {}
  const clip = (s, n) => {
    const t = String(s).replace(/\s+/g, ' ').trim()
    return t.length > n ? `${t.slice(0, n - 1)}…` : t
  }
  switch (toolName) {
    case 'Bash':
      return { what: 'выполнить команду', detail: clip(i.command || '', 300) }
    case 'Write':
      return { what: 'создать / перезаписать файл', detail: clip(i.file_path || '', 200) }
    case 'Edit':
    case 'MultiEdit':
      return { what: 'изменить файл', detail: clip(i.file_path || '', 200) }
    case 'NotebookEdit':
      return { what: 'изменить блокнот', detail: clip(i.notebook_path || '', 200) }
    case 'WebFetch':
      return { what: 'сходить по ссылке', detail: clip(i.url || '', 200) }
    default: {
      const guess = i.file_path || i.path || i.command || i.url || ''
      return { what: `вызвать ${toolName}`, detail: clip(guess || JSON.stringify(i), 300) }
    }
  }
}

function buildMessage(req) {
  const { what, detail } = describeRequest(req.tool_name, req.input)
  const lines = []
  lines.push('🔐 <b>Нужно разрешение</b>')
  lines.push('')
  lines.push(`Claude просит ${escapeHtml(what)}:`)
  if (detail) lines.push(`<code>${escapeHtml(detail)}</code>`)
  lines.push('')
  lines.push(`<i>инструмент: ${escapeHtml(req.tool_name)} · ждёт ${Math.round(WAIT_MS / 60000)} мин</i>`)
  return lines.join('\n')
}

function buildKeyboard(id) {
  return {
    inline_keyboard: [
      [
        { text: '✅ Разрешить', callback_data: `perm:${id}:allow` },
        { text: '⛔ Отклонить', callback_data: `perm:${id}:deny` },
      ],
      [{ text: '✅ Разрешить всё в этой задаче', callback_data: `perm:${id}:turn` }],
    ],
  }
}

function readRequest(id) {
  try { return JSON.parse(readFileSync(reqPath(id), 'utf8')) } catch { return null }
}

function writeResponse(id, payload) {
  const tmp = `${resPath(id)}.tmp`
  writeFileSync(tmp, JSON.stringify(payload))
  renameSync(tmp, resPath(id))
}

// id → { chat_id, message_id, turn_id } для запросов, по которым уже показана
// карточка. Живёт в памяти: после рестарта роутера незакрытые запросы всё равно
// истекут по таймауту на стороне воркера.
const posted = new Map()

function startPermissionWatcher(bot, logLabel = 'tg-router') {
  permDir()
  setInterval(async () => {
    let files = []
    try { files = readdirSync(PERM_DIR) } catch { return }

    for (const f of files) {
      if (!f.endsWith('.req.json')) continue
      const id = f.slice(0, -'.req.json'.length)
      if (posted.has(id)) continue
      const req = readRequest(id)
      if (!req) continue
      // Воркер уже разрешил всё в этой задаче — не тревожим кнопкой.
      if (req.turn_id && existsSync(turnAllowPath(req.turn_id))) continue
      posted.set(id, { chat_id: req.chat_id, message_id: null, turn_id: req.turn_id })
      try {
        const opts = { parse_mode: 'HTML', reply_markup: buildKeyboard(id) }
        if (req.thread_id) opts.message_thread_id = Number(req.thread_id)
        const sent = await bot.api.sendMessage(req.chat_id, buildMessage(req), opts)
        posted.get(id).message_id = sent.message_id
      } catch (err) {
        console.error(`${logLabel}: не смог показать запрос разрешения: ${err.message}`)
        posted.delete(id)
      }
    }

    // Запрос исчез, а карточка висит — воркер ушёл по таймауту или его перебили.
    for (const [id, card] of posted) {
      if (files.includes(`${id}.req.json`)) continue
      posted.delete(id)
      if (!card.message_id) continue
      try {
        await bot.api.editMessageText(card.chat_id, card.message_id,
          '🔐 <b>Запрос разрешения истёк</b>\n<i>ответа не было, операция не выполнена</i>',
          { parse_mode: 'HTML' })
      } catch {}
    }
  }, SCAN_MS)
}

// Обработка нажатия. Возвращает текст для всплывающего уведомления или null,
// если callback не наш.
async function handlePermissionCallback(ctx, data) {
  const m = /^perm:([0-9a-f-]{36}):(allow|deny|turn)$/.exec(data || '')
  if (!m) return null
  const [, id, action] = m
  const card = posted.get(id)
  const req = readRequest(id)

  if (!req) {
    posted.delete(id)
    await ctx.editMessageText('🔐 <b>Запрос уже неактуален</b>\n<i>воркер не ждёт ответа</i>',
      { parse_mode: 'HTML' }).catch(() => {})
    return 'Запрос уже закрыт'
  }

  let note
  if (action === 'deny') {
    writeResponse(id, { decision: 'deny', message: 'владелец отклонил операцию в Telegram.' })
    note = '⛔ Отклонено'
  } else {
    if (action === 'turn' && req.turn_id) {
      try { writeFileSync(turnAllowPath(req.turn_id), String(Date.now())) } catch {}
    }
    writeResponse(id, { decision: 'allow' })
    note = action === 'turn' ? '✅ Разрешено на всю задачу' : '✅ Разрешено'
  }

  const { what, detail } = describeRequest(req.tool_name, req.input)
  const body = [
    `🔐 <b>${note}</b>`,
    '',
    `${escapeHtml(what)}:`,
    detail ? `<code>${escapeHtml(detail)}</code>` : '',
  ].filter(Boolean).join('\n')
  await ctx.editMessageText(body, { parse_mode: 'HTML' }).catch(() => {})
  if (card) posted.delete(id)
  return note
}

// Освободить флаг «разрешено всё в задаче» — вызывается роутером, когда турн
// закончился, чтобы разрешение не утекло на следующий вопрос пользователя.
function clearTurnAllowance(turnId) {
  if (!turnId) return
  try { unlinkSync(turnAllowPath(turnId)) } catch {}
}

module.exports = {
  PERM_DIR,
  permDir,
  startPermissionWatcher,
  handlePermissionCallback,
  clearTurnAllowance,
  describeRequest,
  WAIT_MS,
}
