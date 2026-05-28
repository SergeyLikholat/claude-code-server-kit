// Slash-command dispatcher. Router calls this BEFORE spawning a worker.
// Returns { handled: true, reply?: string } if it ran a command.
// MVP wiring: /status and /help work directly; /digest, /reset, /rollback
// are stubs that return a "not yet implemented" response until context-mgr
// and digest modules are wired in (see context-mgr.js).

const { readFileSync, statSync, existsSync } = require('fs')
const { sessionJsonlPath } = require('./dispatch')

const AVAILABLE_COMMANDS = ['/help', '/status', '/digest', '/reset', '/rollback']

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

function cmdHelp() {
  return [
    'Доступные команды:',
    '/status — размер сессии и контекст',
    '/digest — сгенерировать дайджест (без ротации)',
    '/reset — ротировать сессию (дайджест + чистая сессия)',
    '/rollback — откатить на предыдущую сессию',
    '/help — эта справка',
  ].join('\n')
}

function cmdStatus(topic) {
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

function cmdNotImpl(name) {
  return `🚧 \`${name}\` пока не подключён. В ближайшей итерации будет.`
}

// Main entry called from index.js dispatch pipeline.
// Returns { handled, reply } — if handled, caller skips worker spawn.
function runCommand(text, topic, deps = {}) {
  if (!isCommand(text)) return { handled: false }
  const { cmd } = parseCommand(text)
  let reply
  try {
    switch (cmd) {
      case '/help':     reply = cmdHelp(); break
      case '/status':   reply = cmdStatus(topic); break
      case '/digest':   reply = deps.runDigest ? deps.runDigest(topic) : cmdNotImpl(cmd); break
      case '/reset':    reply = deps.runReset  ? deps.runReset(topic)  : cmdNotImpl(cmd); break
      case '/rollback': reply = deps.runRollback ? deps.runRollback(topic) : cmdNotImpl(cmd); break
      default: return { handled: false }
    }
  } catch (err) {
    reply = `⚠️ ошибка команды ${cmd}: ${err.message}`
  }
  return { handled: true, reply }
}

module.exports = { runCommand, isCommand, parseCommand, AVAILABLE_COMMANDS }
