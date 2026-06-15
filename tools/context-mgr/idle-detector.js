// Проверяет можно ли безопасно запустить background-операцию над сессией:
// - последнее изменение JSONL > N минут назад
// - нет lock-файла роутера (роутер не спавнит worker'а прямо сейчас)

const fs = require('fs')
const path = require('path')

function jsonlMtime(jsonlPath) {
  try { return fs.statSync(jsonlPath).mtimeMs }
  catch { return 0 }
}

function isLockBusy(lockDir, threadId) {
  // tg-router2 пишет lockfile вида /run/claude-telegram/topic-<threadId>.lock
  // Если такого файла нет — worker не запущен.
  const lockFile = path.join(lockDir, `topic-${threadId}.lock`)
  if (!fs.existsSync(lockFile)) return false
  try {
    const pid = parseInt(fs.readFileSync(lockFile, 'utf8').trim(), 10)
    if (!pid || pid <= 1) return false
    // Сигнал 0 — проверка живости процесса без его убийства.
    try { process.kill(pid, 0); return true }
    catch { return false }  // процесс мёртв, лок — мусор
  } catch { return false }
}

function isIdle(opts) {
  const { jsonlPath, lockDir, threadId, idleMinutes = 30 } = opts
  if (isLockBusy(lockDir, threadId)) return { idle: false, reason: 'worker-active' }
  const mtime = jsonlMtime(jsonlPath)
  if (!mtime) return { idle: true, reason: 'no-jsonl-yet' }
  const ageMin = (Date.now() - mtime) / 60000
  if (ageMin < idleMinutes) return { idle: false, reason: `recent-activity-${Math.round(ageMin)}min` }
  return { idle: true, reason: `idle-${Math.round(ageMin)}min` }
}

module.exports = { isIdle, isLockBusy, jsonlMtime }
