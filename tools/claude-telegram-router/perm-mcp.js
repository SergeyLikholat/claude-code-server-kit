#!/usr/bin/env node
/**
 * Мост «разрешение на инструмент» → кнопка в Telegram.
 *
 * Claude Code умеет спрашивать разрешение не у терминала, а у MCP-инструмента
 * (--permission-prompt-tool). В headless-режиме спрашивать было не у кого,
 * поэтому воркер получал отказ и упирался в права. Этот сервер поднимается
 * внутри воркера, кладёт вопрос файлом, а роутер показывает его кнопками в
 * нужном топике и записывает ответ.
 *
 * Важно: через этот механизм проходит и защита каталога конфигурации
 * (`~/.claude`), которую не снимают ни allowedTools, ни правила в settings.json,
 * ни PreToolUse-хуки. Проверено на Bash/Write/Edit, включая settings.json.
 *
 * Протокол — JSON-RPC 2.0 построчно по stdio, минимальное подмножество MCP:
 * initialize / tools/list / tools/call. Зависимостей нет намеренно: сервер
 * стартует в каждом воркере, лишний require здесь стоит миллисекунд.
 *
 * Ответ инструменту отдаётся в формате, который ждёт Claude Code:
 *   {"behavior":"allow","updatedInput":{...}} | {"behavior":"deny","message":"..."}
 */

'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const PERM_DIR = process.env.TG_PERM_DIR
const CHAT_ID = process.env.TG_PERM_CHAT_ID
const THREAD_ID = process.env.TG_PERM_THREAD_ID || ''
const SESSION_ID = process.env.TG_PERM_SESSION || ''
const TURN_ID = process.env.TG_PERM_TURN || ''
const WAIT_MS = Number(process.env.TG_PERM_TIMEOUT_MS || 5 * 60 * 1000)
const POLL_MS = 400

const TOOL_NAME = 'approve'

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// «0 мин» в тексте отказа читается как сбой, а не как истёкшее ожидание.
function humanWait(ms) {
  if (ms < 60000) return `${Math.max(1, Math.round(ms / 1000))} сек`
  return `${Math.round(ms / 60000)} мин`
}

// Разрешение «на весь турн» — файл-флаг, чтобы одна задача не спрашивала
// по кнопке на каждую операцию подряд.
function turnAllowPath() {
  return TURN_ID ? path.join(PERM_DIR, `turn-${TURN_ID}.allow`) : null
}

function turnAllowed() {
  const p = turnAllowPath()
  return Boolean(p && fs.existsSync(p))
}

async function askUser(toolName, input, toolUseId) {
  if (!PERM_DIR || !CHAT_ID) {
    // Роутер не пробросил контекст — спросить некого. Отказ честнее, чем
    // молчаливое разрешение.
    return { behavior: 'deny', message: 'Канал подтверждений не настроен — некого спросить.' }
  }
  if (turnAllowed()) {
    return { behavior: 'allow', updatedInput: input }
  }

  const id = crypto.randomUUID()
  const reqPath = path.join(PERM_DIR, `${id}.req.json`)
  const resPath = path.join(PERM_DIR, `${id}.res.json`)
  try {
    fs.mkdirSync(PERM_DIR, { recursive: true })
    // Пишем через временный файл: роутер сканирует каталог по таймеру и не
    // должен успеть прочитать наполовину записанный запрос.
    const tmp = `${reqPath}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({
      id,
      chat_id: CHAT_ID,
      thread_id: THREAD_ID,
      session_id: SESSION_ID,
      turn_id: TURN_ID,
      tool_name: toolName,
      input,
      tool_use_id: toolUseId || null,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + WAIT_MS).toISOString(),
    }))
    fs.renameSync(tmp, reqPath)
  } catch (err) {
    return { behavior: 'deny', message: `Не удалось отправить запрос в Telegram: ${err.message}` }
  }

  const deadline = Date.now() + WAIT_MS
  try {
    while (Date.now() < deadline) {
      if (turnAllowed()) return { behavior: 'allow', updatedInput: input }
      let raw = null
      try { raw = fs.readFileSync(resPath, 'utf8') } catch {}
      if (raw) {
        let answer
        try { answer = JSON.parse(raw) } catch { answer = null }
        if (answer && answer.decision === 'allow') {
          return { behavior: 'allow', updatedInput: input }
        }
        return {
          behavior: 'deny',
          message: (answer && answer.message) || 'Отклонено в Telegram.',
        }
      }
      await sleep(POLL_MS)
    }
    return {
      behavior: 'deny',
      message: `Ответа в Telegram не было ${humanWait(WAIT_MS)} — операция не выполнена. `
        + 'Попроси разрешение ещё раз, если это всё ещё нужно.',
    }
  } finally {
    for (const p of [reqPath, resPath]) {
      try { fs.unlinkSync(p) } catch {}
    }
  }
}

async function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: {
      protocolVersion: (params && params.protocolVersion) || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'tgperm', version: '1.0.0' },
    }})
  }
  if (method === 'notifications/initialized' || id === undefined) return
  if (method === 'tools/list') {
    return send({ jsonrpc: '2.0', id, result: { tools: [{
      name: TOOL_NAME,
      description: 'Спросить у пользователя в Telegram разрешение на вызов инструмента',
      inputSchema: {
        type: 'object',
        properties: {
          tool_name: { type: 'string' },
          input: { type: 'object' },
          tool_use_id: { type: 'string' },
        },
        required: ['tool_name', 'input'],
      },
    }]}})
  }
  if (method === 'tools/call') {
    const args = (params && params.arguments) || {}
    let payload
    try {
      payload = await askUser(args.tool_name || '?', args.input || {}, args.tool_use_id)
    } catch (err) {
      payload = { behavior: 'deny', message: `Сбой моста подтверждений: ${err.message}` }
    }
    return send({ jsonrpc: '2.0', id, result: {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
    }})
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } })
}

let buf = ''
process.stdin.on('data', chunk => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    handle(msg)
  }
})
process.stdin.on('end', () => process.exit(0))
