#!/usr/bin/env node
// CLI entrypoint для context-mgr.
//
// Команды:
//   node cli.js status                  — dry-run, показывает что сделал бы монитор
//   node cli.js monitor                 — реальный тик монитора (cron */5)
//   node cli.js daily-snapshot          — daily-дайджесты всех топиков (cron 04:30)
//   node cli.js baseline                — одноразовый прогон по всем топикам
//   node cli.js baseline-one <threadId> — baseline только для одного топика (для теста)
//   node cli.js reset <threadId>        — форс hard-reset конкретного топика
//
// Все команды читают конфиг из ./config.json и routing.json из путей в нём.

const path = require('path')
const { monitorTick, loadConfig, loadRouting, jsonlPath, jsonlStats, topicVaultSlug } = require('./monitor')
const { runDailyDigest, runBaselineDigest } = require('./digest')
const { runHardReset } = require('./rotation')
const { applyDigest } = require('./obsidian-writer')
const fsmod = require('fs')
const pathmod = require('path')

const CMD = process.argv[2] || 'status'

function fmtBytes(mb) { return `${mb.toFixed(2)}MB` }

async function cmdStatus() {
  const results = await monitorTick({ dryRun: true })
  for (const r of results) {
    const idle = r.idle ? (r.idle.idle ? '✓idle' : `busy:${r.idle.reason}`) : '-'
    console.log(`${(r.name || 'General').padEnd(15)} ${fmtBytes(r.stats.size_mb).padStart(8)} / ${String(r.stats.turns).padStart(5)}t  ${idle.padEnd(20)} → ${r.action} (${r.reason})`)
  }
}

async function cmdMonitor() {
  const results = await monitorTick({ dryRun: false })
  for (const r of results) {
    if (r.action === 'nothing' || r.action === 'skip' || r.action === 'wait-idle') continue
    console.log(`[${r.action}] ${r.name}: ${r.reason}`)
    if (r.outcome) console.log(`  → ${JSON.stringify(r.outcome).slice(0, 300)}`)
  }
}

async function cmdDaily() {
  const cfg = loadConfig()
  const routing = loadRouting(cfg.paths.routing)
  const all = { ...(routing.topics || {}) }
  if (routing.general?.session_id) all._general = { ...routing.general, _isGeneral: true }

  for (const [key, topic] of Object.entries(all)) {
    const threadId = topic._isGeneral ? null : key
    const jp = jsonlPath(cfg.paths.claude_projects, topic.project_dir, topic.session_id)
    const stats = jsonlStats(jp)
    if (!stats.exists || stats.turns < 10) {
      console.log(`skip ${topic.name || 'General'}: ${stats.exists ? `${stats.turns} turns` : 'no jsonl'}`)
      continue
    }
    console.log(`daily-digest ${topic.name || 'General'} (${fmtBytes(stats.size_mb)} / ${stats.turns}t)...`)
    try {
      const out = await runDailyDigest({ cfg, topic, threadId, jsonlPath: jp, stats })
      console.log(`  → ${out.file} (${out.entities_count} entities)`)
    } catch (err) {
      console.error(`  FAIL: ${err.message}`)
    }
  }
}

async function cmdBaseline(filterThreadId = null) {
  const cfg = loadConfig()
  const routing = loadRouting(cfg.paths.routing)
  const all = { ...(routing.topics || {}) }
  if (routing.general?.session_id) all._general = { ...routing.general, _isGeneral: true }

  for (const [key, topic] of Object.entries(all)) {
    const threadId = topic._isGeneral ? null : key
    if (filterThreadId !== null && String(threadId) !== String(filterThreadId)) continue
    const jp = jsonlPath(cfg.paths.claude_projects, topic.project_dir, topic.session_id)
    const stats = jsonlStats(jp)
    if (!stats.exists || stats.turns < 5) {
      console.log(`skip ${topic.name || 'General'}: ${stats.exists ? `${stats.turns} turns` : 'no jsonl'}`)
      continue
    }
    console.log(`baseline ${topic.name || 'General'} (${fmtBytes(stats.size_mb)} / ${stats.turns}t)...`)
    try {
      const out = await runBaselineDigest({ cfg, topic, threadId, jsonlPath: jp, stats })
      console.log(`  → ${out.file} (${out.entities_count} entities)`)
    } catch (err) {
      console.error(`  FAIL: ${err.message}`)
    }
  }
}

// reindex — перестроить topic/people-страницы из УЖЕ существующих дайджестов.
// Не вызывает модель. Удаляет старые topics/_people и собирает заново
// хронологию из всех digests/*.md в vault.
async function cmdReindex() {
  const cfg = loadConfig()
  const vaultDir = cfg.paths.vault_dir
  const projectsDir = pathmod.join(vaultDir, 'projects')
  if (!fsmod.existsSync(projectsDir)) { console.log('vault пуст, нечего реиндексировать'); return }

  // 1. Снести старые topics/ во всех проектах и общий _people/
  const projects = fsmod.readdirSync(projectsDir).filter(p =>
    fsmod.statSync(pathmod.join(projectsDir, p)).isDirectory())
  for (const proj of projects) {
    const topicsDir = pathmod.join(projectsDir, proj, 'topics')
    if (fsmod.existsSync(topicsDir)) { fsmod.rmSync(topicsDir, { recursive: true, force: true }) }
  }
  const peopleDir = pathmod.join(vaultDir, '_people')
  if (fsmod.existsSync(peopleDir)) { fsmod.rmSync(peopleDir, { recursive: true, force: true }) }
  console.log('старые topics/ и _people/ снесены')

  // 2. Пройтись по всем дайджестам (хронологически по имени файла) и применить
  let total = { topics: 0, people: 0, digests: 0 }
  for (const proj of projects) {
    const digestsDir = pathmod.join(projectsDir, proj, 'digests')
    if (!fsmod.existsSync(digestsDir)) continue
    // собрать все .md рекурсивно (включая daily/)
    const files = []
    const walk = (d) => {
      for (const f of fsmod.readdirSync(d)) {
        const fp = pathmod.join(d, f)
        if (fsmod.statSync(fp).isDirectory()) walk(fp)
        else if (f.endsWith('.md')) files.push(fp)
      }
    }
    walk(digestsDir)
    files.sort()  // имена начинаются с даты-времени → хронологический порядок
    for (const df of files) {
      const md = fsmod.readFileSync(df, 'utf8')
      const r = applyDigest(cfg, proj, df, md)
      total.topics += r.topicPages
      total.people += r.personPages
      total.digests++
      console.log(`  ${proj}/${pathmod.basename(df)} → +${r.topicPages} тем, +${r.personPages} людей (${r.factsCount} фактов)`)
    }
  }
  console.log(`\nготово: ${total.digests} дайджестов, ${total.topics} обновлений тем, ${total.people} людей`)
}

async function cmdResetForced(threadIdArg) {
  if (!threadIdArg) { console.error('Usage: cli.js reset <threadId|general>'); process.exit(1) }
  const cfg = loadConfig()
  const routing = loadRouting(cfg.paths.routing)
  let topic, threadId
  if (threadIdArg === 'general') {
    topic = { ...routing.general, _isGeneral: true }
    threadId = null
  } else {
    topic = routing.topics?.[String(threadIdArg)]
    if (!topic) { console.error(`topic ${threadIdArg} not found in routing.json`); process.exit(1) }
    threadId = String(threadIdArg)
  }
  const jp = jsonlPath(cfg.paths.claude_projects, topic.project_dir, topic.session_id)
  const stats = jsonlStats(jp)
  console.log(`FORCED hard-reset ${topic.name || 'General'} (${fmtBytes(stats.size_mb)} / ${stats.turns}t)`)
  console.log(`  jsonl: ${jp}`)
  console.log(`  session_id: ${topic.session_id}`)
  const out = await runHardReset({ cfg, topic, threadId, jsonlPath: jp, stats })
  console.log(JSON.stringify(out, null, 2))
}

(async () => {
  try {
    switch (CMD) {
      case 'status':        await cmdStatus(); break
      case 'monitor':       await cmdMonitor(); break
      case 'daily-snapshot':
      case 'daily':         await cmdDaily(); break
      case 'baseline':      await cmdBaseline(); break
      case 'baseline-one':  await cmdBaseline(process.argv[3] || null); break
      case 'reindex':       await cmdReindex(); break
      case 'reset':         await cmdResetForced(process.argv[3]); break
      default:
        console.error(`Unknown command: ${CMD}`)
        console.error('Usage: cli.js status | monitor | daily | baseline | baseline-one <tid> | reset <tid|general>')
        process.exit(1)
    }
  } catch (err) {
    console.error('FATAL:', err.stack || err.message || err)
    process.exit(2)
  }
})()
