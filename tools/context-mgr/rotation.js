// Ротация сессии (hard-reset):
//   1. generateDigest({kind:'hardreset'}) — синхронно, ждём markdown
//   2. extractor применяет entities в vault
//   3. mv старый JSONL → archive/<ts>_<sessionId>.jsonl
//   4. Новый UUID
//   5. ATOMIC update routing.json (через temp+rename)
//   6. Записать "first message" в новый JSONL — невидимый для пользователя
//      system-message с дайджестом, чтобы бот продолжила помнить главное
//   7. keep_rotations: 3 — почистить старые архивы
//   8. notify.js — мягкое сообщение в чат
//   9. Лог в monitor

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { generateDigest } = require('./digest')

function projectSlug(dir) {
  return dir.replace(/[^a-zA-Z0-9]/g, '-')
}

// Атомарная запись JSON: tmp + fsync + rename
function atomicWriteJson(filePath, obj) {
  const tmp = filePath + '.tmp.' + process.pid + '.' + Date.now()
  const fd = fs.openSync(tmp, 'w', 0o600)
  try {
    fs.writeSync(fd, JSON.stringify(obj, null, 2))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, filePath)
}

// Сохранить старую сессию в archive/
function archiveOldJsonl(claudeProjects, projectDir, sessionId) {
  const slug = projectSlug(projectDir)
  const src = path.join(claudeProjects, slug, `${sessionId}.jsonl`)
  if (!fs.existsSync(src)) return null
  const archiveDir = path.join(claudeProjects, slug, 'archive')
  fs.mkdirSync(archiveDir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dst = path.join(archiveDir, `${ts}_${sessionId}.jsonl`)
  fs.renameSync(src, dst)
  return dst
}

// Очистка старых архивов — оставляем keepRotations последних по mtime
function pruneArchives(claudeProjects, projectDir, keepRotations) {
  const slug = projectSlug(projectDir)
  const archiveDir = path.join(claudeProjects, slug, 'archive')
  if (!fs.existsSync(archiveDir)) return []
  const files = fs.readdirSync(archiveDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => {
      const fp = path.join(archiveDir, f)
      return { fp, mtime: fs.statSync(fp).mtimeMs }
    })
    .sort((a, b) => b.mtime - a.mtime)
  const toRemove = files.slice(keepRotations)
  for (const f of toRemove) {
    try { fs.unlinkSync(f.fp) } catch {}
  }
  return toRemove.map(f => f.fp)
}

// Обновить routing.json — заменить session_id для топика (или general)
function rotateRoutingSessionId(routingPath, threadId, oldId, newId) {
  const raw = fs.readFileSync(routingPath, 'utf8')
  const routing = JSON.parse(raw)
  if (threadId === null || threadId === undefined) {
    if (routing.general?.session_id !== oldId) {
      throw new Error(`routing.general.session_id != ${oldId} (got ${routing.general?.session_id})`)
    }
    routing.general.session_id = newId
  } else {
    const key = String(threadId)
    if (!routing.topics?.[key]) throw new Error(`topic ${key} not in routing.json`)
    if (routing.topics[key].session_id !== oldId) {
      throw new Error(`topic ${key} session_id != ${oldId} (got ${routing.topics[key].session_id})`)
    }
    routing.topics[key].session_id = newId
  }
  atomicWriteJson(routingPath, routing)
}

// Создать минимальный JSONL для свежей сессии и записать туда
// system-message с дайджестом. Это первое сообщение, которое claude увидит
// при следующем --resume — он будет считать его частью контекста, но в TG
// его никто не отправит (Telegram-роутер прокидывает только пользовательские
// сообщения).
//
// Формат записи в JSONL — мимикрия под то что пишет claude-code сам:
//   { "type": "user", "message": { "role": "user", "content": [...] }, ... }
// Простейший вариант — добавить системный markdown как user-message с
// префиксом "<previous_session_summary>" — модель понимает что это контекст.
function primeNewSession(claudeProjects, projectDir, newSessionId, digestMarkdown) {
  const slug = projectSlug(projectDir)
  const dir = path.join(claudeProjects, slug)
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, `${newSessionId}.jsonl`)

  const primeContent = `<previous_session_summary>
Эта сессия — продолжение более длинной сессии ассистента с пользователем. Старая сессия была упакована, потому что выросла за лимит. Ниже — её сжатое содержание. ПОМНИ это, но не упоминай пользователю что был дайджест/упаковка — просто продолжай разговор как обычно, опираясь на эту память.

${digestMarkdown}
</previous_session_summary>`

  const record = {
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    cwd: projectDir,
    sessionId: newSessionId,
    version: '1.0.0',
    type: 'user',
    message: {
      role: 'user',
      content: primeContent,
    },
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  }
  // Append (создать, если нет)
  fs.writeFileSync(target, JSON.stringify(record) + '\n')
}

// Главная функция: hard-reset одного топика.
async function runHardReset({ cfg, topic, threadId, jsonlPath, stats }) {
  const result = { kind: 'hard-reset', threadId, started_at: new Date().toISOString() }

  // 1. Digest
  const digest = await generateDigest({ cfg, topic, threadId, jsonlPath, stats, kind: 'hardreset' })
  result.digest_file = digest.filePath
  result.entities = digest.entities ? {
    topics: digest.entities.topics.length,
    people: digest.entities.people.length,
    decisions: digest.entities.decisions.length,
  } : null

  // 2. Extractor → obsidian (lazy require — на случай если ещё не написан)
  try {
    const { applyEntities } = require('./obsidian-writer')
    if (digest.entities) applyEntities(cfg, digest.vaultSlug, digest.entities, digest.filePath)
  } catch (err) {
    result.obsidian_writer_error = err.message
  }

  // 3. Archive old JSONL
  result.archived_to = archiveOldJsonl(cfg.paths.claude_projects, topic.project_dir, topic.session_id)

  // 4. New UUID
  const newSessionId = crypto.randomUUID()
  result.old_session_id = topic.session_id
  result.new_session_id = newSessionId

  // 5. Atomic update routing.json
  rotateRoutingSessionId(cfg.paths.routing, threadId, topic.session_id, newSessionId)

  // 6. Prime new session with digest as invisible system-message
  primeNewSession(cfg.paths.claude_projects, topic.project_dir, newSessionId, digest.markdown)

  // 7. Prune old archives
  result.pruned = pruneArchives(cfg.paths.claude_projects, topic.project_dir, cfg.keep_rotations || 3)

  // 8. Notify chat (если есть notify.js и notify.on_hard_reset)
  if (cfg.notify?.on_hard_reset) {
    try {
      const { sendSoftNotify } = require('./notify')
      await sendSoftNotify({ cfg, threadId, text: cfg.notify.soft_message })
      result.notified = true
    } catch (err) {
      result.notify_error = err.message
    }
  }

  result.finished_at = new Date().toISOString()
  return result
}

module.exports = {
  runHardReset, archiveOldJsonl, pruneArchives,
  rotateRoutingSessionId, atomicWriteJson, primeNewSession, projectSlug,
}
