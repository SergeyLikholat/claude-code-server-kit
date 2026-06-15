// Obsidian vault writer (v2 — хронология фактов, не пустые указатели).
//
// КЛЮЧЕВАЯ ИДЕЯ:
//   Потребитель vault — сама бот (бот). Topic-страница должна быть
//   накопленной ХРОНОЛОГИЕЙ темы: при каждом дайджесте, где упоминается
//   [[ферритин]], мы вытаскиваем из дайджеста именно факты про ферритин
//   и дописываем их на страницу ферритина с датой. Открыл узел графа —
//   видишь всю эволюцию темы во времени, без чтения всей сессии.
//
// На вход applyDigest получает:
//   - cfg
//   - vaultSlug проекта (например "health")
//   - digestFile = путь к markdown-дайджесту
//   - digestMarkdown = его содержимое (опц., иначе читаем с диска)
//
// Что делает:
//   1. Парсит дайджест на буллеты (строки с `-`), извлекает [[entity]].
//   2. Для каждой сущности (тема/человек) дописывает релевантные факты
//      на её страницу под датой дайджеста (накопительно, без дублей).
//   3. Обновляет README проекта и глобальный INDEX (recent-секции).
//
// Все auto-секции между HTML-маркерами — ручные правки вне них сохраняются.

const fs = require('fs')
const path = require('path')

// === канонизация имён (падежи/опечатки) =====================================
let _aliases = null
function loadAliases() {
  if (_aliases) return _aliases
  _aliases = {}
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'aliases.json'), 'utf8'))
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith('_')) continue
      _aliases[k.toLowerCase().trim()] = v
    }
  } catch {}
  return _aliases
}

// Привести имя сущности к каноническому виду через aliases.json.
function canonicalizeEntity(name) {
  const aliases = loadAliases()
  const key = String(name).toLowerCase().trim()
  return aliases[key] || name
}

// === slug / фильтры сущностей ===============================================
function slugify(s) {
  return String(s)
    .trim()
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/--+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}

// Мусорные «сущности» — даты, чистые числа, слишком короткие.
// Их не нужно превращать в topic-страницы (это события/значения, не темы).
function isJunkEntity(name) {
  const s = String(name).trim()
  if (s.length < 3) return true
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return true        // дата
  if (/^[\d\s.,%]+$/.test(s)) return true                // только числа/проценты
  if (/^\d{1,2}[\s.]/.test(s) && s.length < 12) return true
  return false
}

// === парсинг дайджеста =======================================================
// Извлечь дату из frontmatter дайджеста (date: YYYY-MM-DD).
function digestDate(markdown) {
  const m = markdown.match(/^date:\s*(\d{4}-\d{2}-\d{2})/m)
  return m ? m[1] : new Date().toISOString().slice(0, 10)
}

// Все wiki-ссылки [[entity]] в строке (без алиасов после |).
function wikiLinksIn(line) {
  const out = []
  const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g
  let m
  while ((m = re.exec(line)) !== null) {
    out.push(m[1].trim())
  }
  return out
}

// Распарсить дайджест: вернуть массив буллетов (фактов) с сущностями.
// Сущности факта = [[ссылки]] в самом буллете ПЛЮС [[ссылки]] из
// заголовка секции (###/##), под которым буллет находится. Так факт
// «принимала флуоксетин 2 месяца» под заголовком «### [[флуоксетин]] …»
// попадёт на страницу флуоксетина, даже если в буллете ссылки нет.
// Пропускаем frontmatter и блок Entities (JSON).
function parseDigestFacts(markdown) {
  const facts = []
  const lines = markdown.split('\n')
  let inEntities = false
  let inFrontmatter = false
  let fmCount = 0
  let headingEntities = []  // сущности текущего заголовка-секции
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (line.trim() === '---') { fmCount++; inFrontmatter = (fmCount < 2); continue }
    if (inFrontmatter) continue
    if (/^##\s+Entities/i.test(line)) { inEntities = true; continue }
    if (inEntities) continue
    // заголовок секции — обновляем контекст
    const heading = line.match(/^#{2,4}\s+(.*)$/)
    if (heading) {
      headingEntities = wikiLinksIn(line)
      continue
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/)
    if (!bullet) continue
    const text = bullet[1].trim()
    if (!text) continue
    // сущности = из буллета + из заголовка секции
    const entities = Array.from(new Set([...wikiLinksIn(line), ...headingEntities]))
    if (!entities.length) continue
    facts.push({ text, entities })
  }
  return facts
}

// === topic / person файлы (хронология) =======================================
const TL_START = '<!-- AUTO:TIMELINE-START -->'
const TL_END = '<!-- AUTO:TIMELINE-END -->'

function ensureEntityPage(filePath, entityName, kind, project) {
  if (fs.existsSync(filePath)) return
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const fm = [
    '---',
    `type: ${kind}`,
    project ? `project: ${project}` : null,
    `created: ${new Date().toISOString().slice(0, 10)}`,
    '---',
    '',
  ].filter(l => l !== null).join('\n')
  const body = [
    `# ${entityName}`,
    '',
    `_Хронология упоминаний (auto). Можно дописывать вручную выше или ниже auto-блока._`,
    '',
    '## Хронология',
    '',
    TL_START,
    TL_END,
    '',
  ].join('\n')
  fs.writeFileSync(filePath, fm + body)
}

// Дописать факты под датой в timeline страницы сущности.
// Группируем по дате: одна дата-секция (### YYYY-MM-DD) на дайджест.
// Дедуп: если такой факт уже есть под этой датой — не дублируем.
function appendTimelineFacts(filePath, date, digestRel, facts) {
  if (!fs.existsSync(filePath)) return
  let content = fs.readFileSync(filePath, 'utf8')
  const s = content.indexOf(TL_START)
  const e = content.indexOf(TL_END)
  if (s < 0 || e < 0 || e < s) return

  const before = content.slice(0, s + TL_START.length)
  let middle = content.slice(s + TL_START.length, e)
  const after = content.slice(e)

  const dateHeader = `### ${date}`
  const factLines = facts.map(f => `- ${f}`)

  if (middle.includes(dateHeader)) {
    // дата уже есть — дописываем недостающие факты в её блок
    const lines = middle.split('\n')
    const idx = lines.findIndex(l => l.trim() === dateHeader)
    // найти конец блока этой даты (до следующего ### или конца)
    let endIdx = lines.length
    for (let i = idx + 1; i < lines.length; i++) {
      if (lines[i].startsWith('### ')) { endIdx = i; break }
    }
    const existing = new Set(lines.slice(idx + 1, endIdx).map(l => l.trim()))
    const toAdd = factLines.filter(fl => !existing.has(fl.trim()))
    if (toAdd.length) lines.splice(endIdx, 0, ...toAdd)
    middle = lines.join('\n')
  } else {
    // новая дата — добавляем секцию сверху (свежее — выше)
    const block = ['', dateHeader, `_(из дайджеста ${digestRel})_`, ...factLines, ''].join('\n')
    middle = block + middle
  }

  fs.writeFileSync(filePath, before + middle + after)
}

// === README проекта / INDEX (recent-секции, как было) ========================
function ensureProjectReadme(vaultDir, vaultSlug) {
  const readmePath = path.join(vaultDir, 'projects', vaultSlug, 'README.md')
  if (fs.existsSync(readmePath)) return readmePath
  fs.mkdirSync(path.dirname(readmePath), { recursive: true })
  fs.writeFileSync(readmePath, [
    `# ${vaultSlug}`, '',
    '(Можно писать вручную — auto-блок ниже обновляется системой.)', '',
    '## Темы', '', 'Смотри папку `topics/` — там хронология по каждой теме.', '',
    '## Последние дайджесты', '',
    '<!-- AUTO:RECENT-START -->', '<!-- AUTO:RECENT-END -->', '',
  ].join('\n'))
  return readmePath
}

function updateRecent(filePath, line) {
  let content = fs.readFileSync(filePath, 'utf8')
  const sMark = '<!-- AUTO:RECENT-START -->', eMark = '<!-- AUTO:RECENT-END -->'
  const s = content.indexOf(sMark), e = content.indexOf(eMark)
  if (s < 0 || e < 0) return
  const middle = content.slice(s + sMark.length, e).trim()
  const existing = middle.split('\n').filter(l => l.trim().startsWith('-'))
  const key = line.match(/\[\[([^\]]+)\]\]/)?.[1] || line
  const newLines = [line, ...existing.filter(l => !l.includes(key))].slice(0, 15)
  content = content.slice(0, s + sMark.length) + '\n' + newLines.join('\n') + '\n' + content.slice(e)
  fs.writeFileSync(filePath, content)
}

function ensureGlobalIndex(vaultDir) {
  const indexPath = path.join(vaultDir, 'INDEX.md')
  if (fs.existsSync(indexPath)) return indexPath
  fs.mkdirSync(vaultDir, { recursive: true })
  fs.writeFileSync(indexPath, [
    '# Vault', '',
    'Сжатая память ассистента. Дайджесты сессий + хронология тем.', '',
    '## Проекты', '', '<!-- AUTO:PROJECTS-START -->', '<!-- AUTO:PROJECTS-END -->', '',
    '## Недавние дайджесты', '', '<!-- AUTO:RECENT-START -->', '<!-- AUTO:RECENT-END -->', '',
  ].join('\n'))
  return indexPath
}

function updateGlobalIndex(vaultDir, vaultSlug, digestFile, kind) {
  const indexPath = ensureGlobalIndex(vaultDir)
  let content = fs.readFileSync(indexPath, 'utf8')

  const projectsDir = path.join(vaultDir, 'projects')
  let list = []
  try {
    list = fs.readdirSync(projectsDir)
      .filter(f => fs.statSync(path.join(projectsDir, f)).isDirectory())
      .sort().map(p => `- [[projects/${p}/README|${p}]]`)
  } catch {}
  const ps = '<!-- AUTO:PROJECTS-START -->', pe = '<!-- AUTO:PROJECTS-END -->'
  const psi = content.indexOf(ps), pei = content.indexOf(pe)
  if (psi >= 0 && pei >= 0) {
    content = content.slice(0, psi + ps.length) + '\n' + list.join('\n') + '\n' + content.slice(pei)
  }

  const rs = '<!-- AUTO:RECENT-START -->', re = '<!-- AUTO:RECENT-END -->'
  const rsi = content.indexOf(rs), rei = content.indexOf(re)
  if (rsi >= 0 && rei >= 0) {
    const middle = content.slice(rsi + rs.length, rei).trim()
    const existing = middle.split('\n').filter(l => l.trim().startsWith('-'))
    const rel = path.relative(vaultDir, digestFile).replace(/\.md$/, '')
    const date = path.basename(digestFile).slice(0, 10)
    const line = `- ${date} · **${vaultSlug}** · _${kind}_ · [[${rel}]]`
    const newLines = [line, ...existing.filter(l => !l.includes(rel))].slice(0, 25)
    content = content.slice(0, rsi + rs.length) + '\n' + newLines.join('\n') + '\n' + content.slice(rei)
  }
  fs.writeFileSync(indexPath, content)
}

// === ГЛАВНЫЙ API =============================================================
// applyDigest — вызывается из digest.js / rotation.js после генерации дайджеста,
// а также из reindex (перепарсинг готовых дайджестов без вызова модели).
function applyDigest(cfg, vaultSlug, digestFile, digestMarkdown) {
  const vaultDir = cfg.paths.vault_dir
  const markdown = digestMarkdown || fs.readFileSync(digestFile, 'utf8')
  const date = digestDate(markdown)
  const facts = parseDigestFacts(markdown)

  // kind из имени файла
  const base = path.basename(digestFile)
  const kind = base.includes('_hardreset') ? 'hard-reset'
             : base.includes('_baseline') ? 'baseline'
             : base.includes('_background') ? 'background'
             : path.dirname(digestFile).endsWith('daily') ? 'daily'
             : 'digest'

  // README + INDEX recent
  const readmePath = ensureProjectReadme(vaultDir, vaultSlug)
  const readmeRel = path.relative(path.dirname(readmePath), digestFile).replace(/\.md$/, '')
  updateRecent(readmePath, `- ${date} · _${kind}_ · [[${readmeRel}]]`)
  updateGlobalIndex(vaultDir, vaultSlug, digestFile, kind)

  // Сгруппировать факты по сущности
  const topicsDir = path.join(vaultDir, 'projects', vaultSlug, 'topics')
  const peopleDir = path.join(vaultDir, '_people')

  // Множество людей — из Entities JSON, чтобы отличать людей от тем
  const peopleSet = new Set()
  const entJson = markdown.match(/```json\s*([\s\S]*?)```/)
  if (entJson) {
    try {
      const o = JSON.parse(entJson[1].trim())
      for (const p of (o.people || [])) peopleSet.add(canonicalizeEntity(String(p).trim()))
    } catch {}
  }

  // entity → массив фактов (с канонизацией падежей/опечаток)
  const byEntity = new Map()
  for (const f of facts) {
    for (const rawEnt of f.entities) {
      if (isJunkEntity(rawEnt)) continue
      const ent = canonicalizeEntity(rawEnt)
      if (!byEntity.has(ent)) byEntity.set(ent, [])
      const arr = byEntity.get(ent)
      if (!arr.includes(f.text)) arr.push(f.text)
    }
  }

  let topicCount = 0, personCount = 0
  for (const [ent, entFacts] of byEntity) {
    const slug = slugify(ent)
    if (!slug) continue
    const isPerson = peopleSet.has(ent)
    const dir = isPerson ? peopleDir : topicsDir
    const filePath = path.join(dir, `${slug}.md`)
    const digestRel = isPerson
      ? `[[${path.relative(peopleDir, digestFile).replace(/\.md$/, '')}]]`
      : `[[${path.relative(topicsDir, digestFile).replace(/\.md$/, '')}]]`
    ensureEntityPage(filePath, ent, isPerson ? 'person' : 'topic', isPerson ? null : vaultSlug)
    appendTimelineFacts(filePath, date, digestRel, entFacts)
    if (isPerson) personCount++; else topicCount++
  }

  return { date, factsCount: facts.length, topicPages: topicCount, personPages: personCount }
}

// Совместимость со старым именем (digest.js/rotation.js вызывают applyEntities)
function applyEntities(cfg, vaultSlug, _entities, digestFile) {
  return applyDigest(cfg, vaultSlug, digestFile, null)
}

module.exports = {
  applyDigest, applyEntities,
  parseDigestFacts, wikiLinksIn, digestDate, isJunkEntity, slugify,
  canonicalizeEntity, loadAliases,
}
