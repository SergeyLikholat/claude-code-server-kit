// Главный модуль автономного контекст-менеджера.
//
// На каждый тик (cron */5):
//   1. Читает routing.json Клары
//   2. Для каждого топика вычисляет stats JSONL (size, turns)
//   3. Применяет topic_overrides из config
//   4. Решает action: hard-reset | background-digest | nothing
//   5. Делегирует digest/rotation/extract/write
//   6. Логирует результат в logs/<YYYY-MM-DD>.jsonl
//
// Принцип: пользователь ничего не видит и не делает. Уведомление в чат —
// только при hard-reset, одно мягкое сообщение.

const fs = require('fs')
const path = require('path')
const { isIdle } = require('./idle-detector')

const CONFIG_PATH = path.join(__dirname, 'config.json')

function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  // Дефолты на случай если поле отсутствует
  cfg.limits = cfg.limits || {}
  cfg.paths = cfg.paths || {}
  cfg.idle_threshold_minutes = cfg.idle_threshold_minutes || 30
  cfg.keep_rotations = cfg.keep_rotations || 3
  cfg.topic_overrides = cfg.topic_overrides || {}
  return cfg
}

function loadRouting(routingPath) {
  return JSON.parse(fs.readFileSync(routingPath, 'utf8'))
}

// Слаг как делает claude-code: каждый non-alphanumeric → '-'
function projectSlug(dir) {
  return dir.replace(/[^a-zA-Z0-9]/g, '-')
}

function jsonlPath(claudeProjects, projectDir, sessionId) {
  return path.join(claudeProjects, projectSlug(projectDir), `${sessionId}.jsonl`)
}

function jsonlStats(filePath) {
  try {
    const st = fs.statSync(filePath)
    // turns = количество строк (каждая запись = один JSON-объект на строке)
    const buf = fs.readFileSync(filePath)
    let turns = 0
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) turns++
    return {
      exists: true,
      size_mb: st.size / (1024 * 1024),
      size_bytes: st.size,
      turns,
      mtime_ms: st.mtimeMs,
    }
  } catch {
    return { exists: false, size_mb: 0, size_bytes: 0, turns: 0, mtime_ms: 0 }
  }
}

// Объединяет глобальные limits с per-topic override
function effectiveLimits(cfg, threadId) {
  const base = { ...cfg.limits }
  const override = cfg.topic_overrides?.[String(threadId)]?.limits
  return override ? { ...base, ...override } : base
}

// Главное правило: какое действие нужно для топика
function decideAction(stats, limits, idleResult) {
  if (!stats.exists) return { action: 'skip', reason: 'no-jsonl' }
  const hardSize  = stats.size_mb >= (limits.hard_size_mb || Infinity)
  const hardTurns = stats.turns   >= (limits.hard_turns   || Infinity)
  const softSize  = stats.size_mb >= (limits.soft_size_mb || Infinity)
  const softTurns = stats.turns   >= (limits.soft_turns   || Infinity)

  if (hardSize || hardTurns) {
    return {
      action: 'hard-reset',
      reason: hardSize ? `size>=${limits.hard_size_mb}MB` : `turns>=${limits.hard_turns}`,
    }
  }
  if (softSize || softTurns) {
    if (!idleResult.idle) {
      return { action: 'wait-idle', reason: `soft-but-busy: ${idleResult.reason}` }
    }
    return {
      action: 'background-digest',
      reason: softSize ? `size>=${limits.soft_size_mb}MB` : `turns>=${limits.soft_turns}`,
    }
  }
  return { action: 'nothing', reason: 'under-limits' }
}

// Не повторяем background-digest чаще раза в сутки на топик
function recentBackgroundDigestExists(vaultDir, topicSlug) {
  const dir = path.join(vaultDir, 'projects', topicSlug, 'digests')
  if (!fs.existsSync(dir)) return false
  const today = new Date().toISOString().slice(0, 10)  // YYYY-MM-DD
  try {
    return fs.readdirSync(dir).some(f =>
      f.includes(today) && (f.includes('background') || f.includes('daily'))
    )
  } catch { return false }
}

// Имя топика → slug папки в vault. Берём project_dir и обрезаем до последнего сегмента.
function topicVaultSlug(topic) {
  if (!topic.project_dir) return 'general'
  const parts = topic.project_dir.split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : 'general'
}

function appendLog(cfg, entry) {
  const day = new Date().toISOString().slice(0, 10)
  const file = path.join(cfg.paths.logs_dir, `${day}.jsonl`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
}

// Главная функция: один тик монитора.
// Возвращает массив { topic, action, reason, stats, result? }
async function monitorTick(opts = {}) {
  const cfg = loadConfig()
  const routing = loadRouting(cfg.paths.routing)
  const dryRun = !!opts.dryRun
  const results = []

  // Lazy-load ротатора/диджестера — чтобы не падать на cli.js status, если их ещё нет
  let runHardReset = null
  let runBackgroundDigest = null
  try { runHardReset = require('./rotation').runHardReset } catch {}
  try { runBackgroundDigest = require('./digest').runBackgroundDigest } catch {}

  const topics = routing.topics || {}
  // Также проверяем general — у него тоже есть session_id и он может расти
  const everything = { ...topics }
  if (routing.general?.session_id) {
    everything._general = { ...routing.general, threadId: null, _isGeneral: true }
  }

  // Фаза 1: собрать решения по всем топикам (без выполнения).
  const plans = []
  for (const [threadKey, topic] of Object.entries(everything)) {
    const threadId = topic._isGeneral ? null : threadKey
    const jsonl = jsonlPath(cfg.paths.claude_projects, topic.project_dir, topic.session_id)
    const stats = jsonlStats(jsonl)
    const limits = effectiveLimits(cfg, threadId)
    const idleResult = isIdle({
      jsonlPath: jsonl,
      lockDir: cfg.paths.lock_dir,
      threadId: threadId ?? 'general',
      idleMinutes: cfg.idle_threshold_minutes,
    })
    const decision = decideAction(stats, limits, idleResult)
    const vaultSlug = topicVaultSlug(topic)

    // Дедупликация: один background-digest в сутки на топик
    if (decision.action === 'background-digest'
        && recentBackgroundDigestExists(cfg.paths.vault_dir, vaultSlug)) {
      decision.action = 'nothing'
      decision.reason = 'background-already-done-today'
    }

    plans.push({ threadId, topic, jsonl, stats, limits, idleResult, decision, vaultSlug })
  }

  // Фаза 2: ВЫПОЛНЯЕМ МАКСИМУМ ОДНО тяжёлое действие за тик.
  // Каждый digest 24МБ-сессии = ~4 минуты; несколько подряд не влезут
  // в systemd TimeoutStartSec. Cron гоняет каждые 5 минут — за несколько
  // тиков система разгребёт все топики. Приоритет: hard-reset > background.
  // hard-reset критичнее (сессия уже за hard-лимитом, бьёт по latency).
  const heavy = (a) => a === 'hard-reset' || a === 'background-digest'
  const priority = (a) => (a === 'hard-reset' ? 2 : a === 'background-digest' ? 1 : 0)
  const actionable = plans
    .filter(p => heavy(p.decision.action))
    .sort((a, b) => priority(b.decision.action) - priority(a.decision.action))
  const chosen = dryRun ? null : actionable[0]

  for (const p of plans) {
    const result = {
      threadId: p.threadId, name: p.topic.name || 'General', project_dir: p.topic.project_dir,
      session_id: p.topic.session_id, vault_slug: p.vaultSlug,
      stats: { size_mb: +p.stats.size_mb.toFixed(2), turns: p.stats.turns, exists: p.stats.exists },
      limits: { soft_size_mb: p.limits.soft_size_mb, hard_size_mb: p.limits.hard_size_mb, soft_turns: p.limits.soft_turns, hard_turns: p.limits.hard_turns },
      idle: p.idleResult,
      action: p.decision.action, reason: p.decision.reason,
    }

    if (chosen && p === chosen) {
      if (p.decision.action === 'hard-reset' && runHardReset) {
        try { result.outcome = await runHardReset({ cfg, topic: p.topic, threadId: p.threadId, jsonlPath: p.jsonl, stats: p.stats }) }
        catch (err) { result.outcome = { error: err.message } }
      } else if (p.decision.action === 'background-digest' && runBackgroundDigest) {
        try { result.outcome = await runBackgroundDigest({ cfg, topic: p.topic, threadId: p.threadId, jsonlPath: p.jsonl, stats: p.stats }) }
        catch (err) { result.outcome = { error: err.message } }
      }
    } else if (!dryRun && heavy(p.decision.action)) {
      // Тяжёлое действие отложено на следующий тик
      result.deferred = true
    }

    appendLog(cfg, { event: 'monitor-tick', ...result })
    results.push(result)
  }

  return results
}

module.exports = {
  loadConfig, loadRouting, projectSlug, jsonlPath, jsonlStats,
  effectiveLimits, decideAction, monitorTick, topicVaultSlug, appendLog,
}
