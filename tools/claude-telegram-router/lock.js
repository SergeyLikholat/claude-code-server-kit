// Per-topic serialize: in-process mutex + file flock for cross-process safety.
// grammy callbacks are single-process, so in-process Promise chains are enough
// for MVP. File lock is added defense-in-depth (rotation/digest workers could
// spawn concurrently and touch the same jsonl).

const { openSync, closeSync, constants, existsSync, mkdirSync } = require('fs')
const { dirname } = require('path')

const inProcQueues = new Map()  // lockPath -> Promise chain tail

async function withLock(lockPath, fn) {
  mkdirSync(dirname(lockPath), { recursive: true })
  // Serialize in-process: chain on to prior promise for this lockPath.
  const prev = inProcQueues.get(lockPath) || Promise.resolve()
  let release
  const slot = new Promise(res => { release = res })
  inProcQueues.set(lockPath, slot)
  try { await prev } catch {}

  let fd = -1
  try {
    // Best-effort file flock. flock-style LOCK_EX not in node fs; use O_EXCL
    // on a separate lockfile to signal "in use". Non-blocking; skip if busy.
    try {
      fd = openSync(lockPath + '.busy', constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600)
    } catch {}
    const result = await fn()
    return result
  } finally {
    if (fd >= 0) {
      try { closeSync(fd) } catch {}
      try { require('fs').unlinkSync(lockPath + '.busy') } catch {}
    }
    release()
    // If this slot is still the tail, clear the map entry to avoid leak.
    if (inProcQueues.get(lockPath) === slot) inProcQueues.delete(lockPath)
  }
}

function isLockBusy(lockPath) {
  return inProcQueues.has(lockPath) || existsSync(lockPath + '.busy')
}

module.exports = { withLock, isLockBusy }
