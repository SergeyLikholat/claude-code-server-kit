// Генерация дайджеста сессии через headless `claude --model sonnet`.
// Подход:
//   1. Берём JSONL текущей сессии.
//   2. Готовим временный промпт с инструкцией сжатия + ссылкой на JSONL.
//   3. Спавним claude в одноразовой сессии (без --session-id / --resume —
//      каждый digest run = свежий процесс claude, который читает JSONL
//      и выдаёт markdown).
//   4. Результат пишем в vault: `obsidian/projects/<slug>/digests/<ts>_<kind>.md`.
//   5. Парсим хвост (JSON-блок Entities) — отдадим extractor'у.
//
// Виды дайджестов:
//   - hard-reset  → пишется как полный архивный snapshot прежней сессии
//   - background  → накопительный лёгкий snapshot без сброса сессии
//   - daily       → ночной snapshot (через cron daily-snapshot)
//   - baseline    → первый прогон при установке
//
// Все режимы используют одну и ту же модель и базовый промпт, отличаются
// только хвостовой инструкцией и kind в имени файла.

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const DIGEST_PROMPT_HEADER = `Ты сжимаешь историю Telegram-сессии ассистента с пользователем. На вход — JSONL-файл с user/assistant парами. Сделай markdown-сводку строго по схеме ниже. Цель — чтобы следующая сессия ассистента прочитала эту сводку и продолжила разговор не теряя ничего важного.

# Правила
- Пиши на русском.
- Указывай конкретные имена, даты, факты — не общие слова.
- Эмоциональный контекст важен не меньше фактов (это бот для личных тем).
- Используй wiki-links \`[[имя-сущности]]\` для людей, тем, решений — это пойдёт в Obsidian-граф.
- В конце обязателен блок \`\`\`json Entities\`\`\` (см. ниже).
- Не выдумывай. Если чего-то в JSONL нет — не пиши.

# Схема дайджеста

\`\`\`markdown
---
date: <ISO date>
project: <topic-slug>
type: <kind>
turns: <число>
size_mb: <число>
session_id: <uuid>
---

# <Topic name> — дайджест <YYYY-MM-DD>

## Контекст
2-3 предложения: о чём сессия в целом, какой период покрывает.

## Ключевые факты
- факт 1 (со ссылками \`[[wiki]]\`)
- факт 2
- ...

## Открытые вопросы
- что обсудили но не решили
- что ждёт следующего хода
(пропустить раздел если ничего нет)

## Решения и действия
- решение / действие — когда — статус
(пропустить раздел если ничего нет)

## Эмоциональный контекст
Состояние пользователя: тон, настроение, что его сейчас беспокоит / радует.
Что ассистенту важно помнить об эмоциональной картине при следующем разговоре.

## Entities

\\\`\\\`\\\`json
{
  "topics": ["имя темы 1", "имя темы 2"],
  "people": ["имя человека 1", "имя человека 2"],
  "decisions": [
    { "what": "что", "when": "YYYY-MM-DD", "status": "done|pending|cancelled" }
  ]
}
\\\`\\\`\\\`
\`\`\`
`

function buildDigestPrompt({ jsonlPath, topicName, projectDir, sessionId, kind, stats }) {
  return `${DIGEST_PROMPT_HEADER}

# Что сжать
JSONL-файл: ${jsonlPath}
Топик: ${topicName}
Project dir: ${projectDir}
Session id: ${sessionId}
Размер: ${stats.size_mb.toFixed(2)} МБ, turns: ${stats.turns}
Тип дайджеста: ${kind}

# Задание
Прочитай файл целиком (можно через Read tool с offset/limit или Bash tail/sed — но дай покрытие всей сессии, не только начала). Сделай сводку по схеме выше. Не комментируй процесс — выдай только markdown.

Frontmatter заполни актуальными значениями (date=сегодня, project=basename(projectDir), type=${kind}, turns=${stats.turns}, size_mb=${stats.size_mb.toFixed(2)}, session_id=${sessionId}).
`
}

// Найти бинарь claude — копируем подход dispatch.js
function findClaudeBin() {
  const candidates = [
    process.env.CLAUDE_BIN,
    '/usr/local/bin/claude',
    '/usr/bin/claude',
    '/root/.bun/bin/claude',
    '/root/.local/bin/claude',
  ].filter(Boolean)
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); return c } catch {}
  }
  try {
    const extDir = '/root/.vscode-server/extensions'
    const entries = fs.readdirSync(extDir)
      .filter(n => /^anthropic\.claude-code-.*-linux-x64$/.test(n))
      .map(n => {
        const p = path.join(extDir, n, 'resources', 'native-binary', 'claude')
        try { fs.accessSync(p, fs.constants.X_OK); return { p, mtime: fs.statSync(p).mtimeMs } }
        catch { return null }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
    if (entries.length) return entries[0].p
  } catch {}
  throw new Error('claude binary not found')
}

// Запустить headless-claude с заданным промптом, дождаться результата.
// Возвращает stdout (= ответ модели = markdown).
function spawnDigestWorker({ prompt, model, timeoutMs = 600000 }) {
  const bin = findClaudeBin()
  // --print = одноразовый non-interactive прогон.
  // --allowedTools — узкий whitelist (только чтение JSONL).
  // Намеренно НЕ используем --permission-mode bypassPermissions — это
  // запрещено правилами проекта. acceptEdits даёт автоматическое
  // подтверждение Edit-операций (для нашего сценария они не нужны, но
  // лучше иметь fallback чем blocking prompt).
  const args = [
    '--print',
    '--model', model,
    '--allowedTools', 'Read,Glob,Grep',
    '--permission-mode', 'acceptEdits',
  ]
  const res = spawnSync(bin, args, {
    input: prompt,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 50 * 1024 * 1024,
  })
  if (res.error) throw new Error(`claude spawn error: ${res.error.message}`)
  if (res.status !== 0) throw new Error(`claude exit ${res.status}: ${(res.stderr || '').slice(0, 500)}`)
  return res.stdout
}

// Убрать преамбулу модели и обёртку ```markdown ... ```.
// Модель иногда пишет «Теперь у меня достаточно данных...» перед дайджестом
// и заворачивает всё в fenced-блок. Нам нужен чистый markdown начиная
// с frontmatter (---) или с первого заголовка.
function cleanDigestOutput(raw) {
  if (!raw) return raw
  let s = raw.trim()

  // 1. Если ответ обёрнут в ```markdown ... ``` — развернуть.
  //    Берём всё после первой строки ```markdown и срезаем ПОСЛЕДНИЙ
  //    закрывающий ``` (обёртки), сохраняя вложенный ```json Entities.
  const fenceOpen = s.match(/```(?:markdown|md)[ \t]*\n/)
  if (fenceOpen) {
    s = s.slice(s.indexOf(fenceOpen[0]) + fenceOpen[0].length)
    const lastClose = s.lastIndexOf('\n```')
    if (lastClose >= 0 && !s.slice(lastClose + 4).trim()) {
      s = s.slice(0, lastClose)
    }
    s = s.trim()
  }

  // 2. Срезать преамбулу до начала реального контента: ищем либо frontmatter
  //    (--- с date:/project: внутри), либо первый '# ' заголовок.
  const lines = s.split('\n')
  let startIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      const peek = lines.slice(i + 1, i + 7).join('\n')
      if (/\b(date|project|type|session_id):/i.test(peek)) { startIdx = i; break }
    }
    if (lines[i].startsWith('# ')) { startIdx = i; break }
  }
  if (startIdx > 0) s = lines.slice(startIdx).join('\n')

  return s.trim()
}

// Извлечь Entities JSON-блок из markdown. Возвращает {topics,people,decisions} или null.
function parseEntities(markdown) {
  if (!markdown) return null
  const m = markdown.match(/```json\s*([\s\S]*?)```\s*$/m)
  if (!m) return null
  try {
    const obj = JSON.parse(m[1].trim())
    return {
      topics: Array.isArray(obj.topics) ? obj.topics : [],
      people: Array.isArray(obj.people) ? obj.people : [],
      decisions: Array.isArray(obj.decisions) ? obj.decisions : [],
    }
  } catch { return null }
}

// Записать дайджест в vault, вернуть путь
function writeDigestFile(vaultDir, vaultSlug, kind, markdown) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const isDaily = kind === 'daily'
  const subdir = isDaily ? 'daily' : ''
  const fname = isDaily
    ? `${new Date().toISOString().slice(0, 10)}.md`
    : `${ts}_${kind}.md`
  const dir = path.join(vaultDir, 'projects', vaultSlug, 'digests', subdir)
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, fname)
  fs.writeFileSync(target, markdown)
  return target
}

// ===========================================================================
// Публичные API: generateDigest / runBackgroundDigest / runDailyDigest
// runHardReset реализован в rotation.js и вызывает generateDigest внутри.
// ===========================================================================

async function generateDigest({ cfg, topic, threadId, jsonlPath: jp, stats, kind }) {
  const vaultSlug = (() => {
    if (!topic.project_dir) return 'general'
    const parts = topic.project_dir.split('/').filter(Boolean)
    return parts.length ? parts[parts.length - 1] : 'general'
  })()
  const prompt = buildDigestPrompt({
    jsonlPath: jp,
    topicName: topic.name || 'General',
    projectDir: topic.project_dir,
    sessionId: topic.session_id,
    kind,
    stats,
  })
  const model = cfg.model || 'sonnet'
  const raw = spawnDigestWorker({ prompt, model })
  const markdown = cleanDigestOutput(raw)
  const filePath = writeDigestFile(cfg.paths.vault_dir, vaultSlug, kind, markdown)
  const entities = parseEntities(markdown)
  return { filePath, markdown, entities, vaultSlug }
}

async function runBackgroundDigest(ctx) {
  const out = await generateDigest({ ...ctx, kind: 'background' })
  // Background не трогает JSONL — только vault и extractor (если есть)
  try {
    const { applyEntities } = require('./obsidian-writer')
    if (out.entities) applyEntities(ctx.cfg, out.vaultSlug, out.entities, out.filePath)
  } catch {}
  return { kind: 'background', file: out.filePath, entities_count: out.entities ? out.entities.topics.length + out.entities.people.length : 0 }
}

async function runDailyDigest(ctx) {
  const out = await generateDigest({ ...ctx, kind: 'daily' })
  try {
    const { applyEntities } = require('./obsidian-writer')
    if (out.entities) applyEntities(ctx.cfg, out.vaultSlug, out.entities, out.filePath)
  } catch {}
  return { kind: 'daily', file: out.filePath, entities_count: out.entities ? out.entities.topics.length + out.entities.people.length : 0 }
}

async function runBaselineDigest(ctx) {
  const out = await generateDigest({ ...ctx, kind: 'baseline' })
  try {
    const { applyEntities } = require('./obsidian-writer')
    if (out.entities) applyEntities(ctx.cfg, out.vaultSlug, out.entities, out.filePath)
  } catch {}
  return { kind: 'baseline', file: out.filePath, entities_count: out.entities ? out.entities.topics.length + out.entities.people.length : 0 }
}

module.exports = {
  generateDigest, runBackgroundDigest, runDailyDigest, runBaselineDigest,
  parseEntities, cleanDigestOutput, buildDigestPrompt, findClaudeBin, spawnDigestWorker,
}
