// Опциональная транскрипция голосовых/аудио через локальный parakeet-server.
// Если PARAKEET_URL не задан — возвращаем null и upstream-обработчики
// отправляют файл Claude как есть (без текста).

const { readFile } = require('fs/promises')
const { basename } = require('path')

const PARAKEET_URL = process.env.PARAKEET_URL || ''
const TIMEOUT_MS = parseInt(process.env.PARAKEET_TIMEOUT_MS || '60000', 10)

async function transcribeIfConfigured(filePath) {
  if (!PARAKEET_URL) return null

  const buf = await readFile(filePath)
  const blob = new Blob([buf])
  const form = new FormData()
  form.append('audio', blob, basename(filePath))

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(PARAKEET_URL, { method: 'POST', body: form, signal: ac.signal })
    if (!res.ok) {
      process.stderr.write(`tg-router: parakeet HTTP ${res.status}\n`)
      return null
    }
    const data = await res.json()
    const text = (data && typeof data.text === 'string') ? data.text.trim() : ''
    return text || null
  } catch (err) {
    process.stderr.write(`tg-router: parakeet error: ${err.message}\n`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

module.exports = { transcribeIfConfigured, PARAKEET_URL }
