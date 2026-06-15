// Отправка мягкого уведомления боту в нужный TG-топик после hard-reset.
// Использует тот же TELEGRAM_BOT_TOKEN что и tg-router2 (читаем из её .env).

const fs = require('fs')

function loadBotToken(envFile) {
  try {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^TELEGRAM_BOT_TOKEN=(.+)$/)
      if (m) return m[1].trim()
    }
  } catch {}
  return process.env.TELEGRAM_BOT_TOKEN || null
}

function loadChatId(routingPath) {
  try {
    const r = JSON.parse(fs.readFileSync(routingPath, 'utf8'))
    return r.chat_id || null
  } catch { return null }
}

async function sendSoftNotify({ cfg, threadId, text }) {
  const token = loadBotToken(cfg.paths.telegram_env)
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not found')
  const chatId = loadChatId(cfg.paths.routing)
  if (!chatId) throw new Error('chat_id not found in routing.json')

  const body = { chat_id: chatId, text }
  if (threadId !== null && threadId !== undefined) {
    body.message_thread_id = Number(threadId)
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`TG sendMessage ${res.status}: ${errText.slice(0, 200)}`)
  }
  return await res.json()
}

module.exports = { sendSoftNotify, loadBotToken, loadChatId }
