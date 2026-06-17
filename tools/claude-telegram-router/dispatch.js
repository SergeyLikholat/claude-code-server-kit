// Spawn headless claude worker for a single Telegram message.
// Session persistence: deterministic UUID per topic + --session-id / --resume.

const { spawn } = require('child_process')
const { existsSync, mkdirSync, readdirSync, statSync } = require('fs')
const { join } = require('path')
const { homedir } = require('os')

// Resolve claude binary. The historical hard-coded /usr/bin/claude does not
// exist on this host — the only working binary ships inside the VS Code
// extension. The version is in the path, so glob for the newest install at
// each spawn so we survive extension updates.
let _cachedBin = null
function resolveClaudeBin() {
  if (_cachedBin && existsSync(_cachedBin)) return _cachedBin
  const candidates = [
    process.env.CLAUDE_BIN,
    '/usr/local/bin/claude',
    '/usr/bin/claude',
    '/root/.bun/bin/claude',
    '/root/.local/bin/claude',
  ].filter(Boolean)
  for (const c of candidates) {
    if (existsSync(c)) { _cachedBin = c; return c }
  }
  try {
    const extDir = join(homedir(), '.vscode-server', 'extensions')
    const entries = readdirSync(extDir)
      .filter((n) => /^anthropic\.claude-code-.*-linux-x64$/.test(n))
      .map((n) => {
        const p = join(extDir, n, 'resources', 'native-binary', 'claude')
        return existsSync(p) ? { p, mtime: statSync(p).mtimeMs } : null
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
    if (entries.length) { _cachedBin = entries[0].p; return _cachedBin }
  } catch (_) {}
  return null
}

// Built-in tools always available to the worker. The official telegram MCP
// plugin is NOT installed — the router is self-sufficient: it auto-pulls the
// final assistant message from the JSONL log and sends it via the grammy Bot
// API itself (see index.js). So Claude must NEVER rely on telegram MCP tools.
const BASE_TOOLS = [
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent', 'WebFetch', 'WebSearch', 'TodoWrite',
]

// Optional extra MCP tools, opt-in via env (comma-separated). Lets a deployment
// add its own MCP servers (e.g. a task tracker, docs lookup) WITHOUT hardcoding
// anyone's personal plugins into the kit. Example:
//   TG_EXTRA_ALLOWED_TOOLS=mcp__yougile__yougile_list_tasks,mcp__plugin_context7_context7__query-docs
const EXTRA_TOOLS = (process.env.TG_EXTRA_ALLOWED_TOOLS || '')
  .split(',').map((s) => s.trim()).filter(Boolean)

const ALLOWED_TOOLS = [...BASE_TOOLS, ...EXTRA_TOOLS]

// System-prompt appended to every worker. Since there is no telegram MCP, the
// daemon delivers the answer by reading the final assistant message from the
// JSONL session log and sending it to Telegram (converting Markdown → TG HTML).
const WORKER_FORMAT_RULE = [
  '',
  '## Telegram delivery (CRITICAL — read before answering)',
  '',
  'You are a headless Telegram worker. The daemon will fetch your FINAL assistant message from the JSONL session log and send it to Telegram automatically. There is no telegram MCP tool.',
  '',
  '- Write your answer as a normal assistant message (plain text + standard Markdown). Do NOT try to call any telegram/MCP "reply" tool — none exists.',
  '- Your final assistant message IS what the user receives. Make it self-contained.',
  '- Use other tools (Bash, Read, Edit, etc.) freely for the actual work.',
  '- Markdown: **bold**, *italic*, `code`, ```fenced```, [links](url), ## headings — the daemon converts everything to valid Telegram HTML.',
].join('\n')

function projectSlug(dir) {
  // Matches claude-code's slug logic: EVERY non-alphanumeric character → '-'.
  // The earlier `/[/_]/g` regex only replaced `/` and `_`, which silently broke
  // session resume for any topic whose project_dir contained Cyrillic, spaces
  // or dots — sessionExists() returned false, the worker re-spawned with
  // --session-id for an already-existing session, and crashed with
  // "Session ID … is already in use" on every message after the first.
  return dir.replace(/[^a-zA-Z0-9]/g, '-')
}

function sessionJsonlPath(projectDir, sessionId) {
  return join(homedir(), '.claude', 'projects', projectSlug(projectDir), `${sessionId}.jsonl`)
}

function sessionExists(projectDir, sessionId) {
  return existsSync(sessionJsonlPath(projectDir, sessionId))
}

// After claude finishes writing a new session, patch JSONL so VS Code Sidebar
// displays it:
//   1. Replace "entrypoint":"sdk-cli" → "claude-vscode" in all records
//   2. Append a synthetic ai-title record at the end so Sidebar has a title to show
//      (Sidebar filter appears to require at least one ai-title record).
// Safe to call after claude --print has fully completed (no concurrent writes).
function patchFirstEntrypointToVscode(projectDir, sessionId) {
  const fs = require('fs')
  const path = sessionJsonlPath(projectDir, sessionId)
  if (!fs.existsSync(path)) return false
  const content = fs.readFileSync(path, 'utf8')
  const lines = content.split('\n')
  let modified = false
  let firstUserText = null
  let hasAiTitle = false
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue
    if (lines[i].includes('"type":"ai-title"')) hasAiTitle = true
    if (lines[i].includes('"entrypoint":"sdk-cli"')) {
      let obj
      try { obj = JSON.parse(lines[i]) } catch { continue }
      if (obj.entrypoint === 'sdk-cli') {
        obj.entrypoint = 'claude-vscode'
        lines[i] = JSON.stringify(obj)
        modified = true
      }
    }
    // Capture first user message text for synthetic ai-title (skip system tags)
    if (!firstUserText && lines[i].includes('"type":"user"')) {
      try {
        const obj = JSON.parse(lines[i])
        const content = obj.message?.content
        let txt = ''
        if (typeof content === 'string') {
          txt = content
        } else if (Array.isArray(content)) {
          for (const part of content) {
            if (typeof part === 'string') txt += part + ' '
            else if (part && typeof part.text === 'string') txt += part.text + ' '
          }
        }
        txt = txt.replace(/<channel[^>]*>/g, '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/\s+/g, ' ').trim()
        if (txt) firstUserText = txt
      } catch {}
    }
  }
  // Append synthetic ai-title if none exists (Sidebar needs it to display the session)
  if (!hasAiTitle) {
    const title = firstUserText
      ? (firstUserText.length > 60 ? firstUserText.slice(0, 57) + '...' : firstUserText)
      : 'Telegram session'
    const aiTitleRecord = JSON.stringify({
      type: 'ai-title',
      aiTitle: title,
      sessionId: sessionId,
    })
    lines.push(aiTitleRecord)
    modified = true
  }
  if (modified) {
    fs.writeFileSync(path, lines.join('\n'))
  }
  return modified
}

// Spawn claude worker.
//   opts: { project_dir, session_id, prompt, timeout_ms, env, onStdoutLine }
//   All workers run in "bridged" mode: no telegram MCP tools; Claude writes a
//   plain assistant message, the daemon auto-pulls it from JSONL and sends it.
// Returns: { code, stdout, stderr, durationMs }
async function runClaudeWorker(opts) {
  const { project_dir, session_id, prompt, timeout_ms = 600000, env = {}, onStdoutLine } = opts

  mkdirSync(project_dir, { recursive: true })
  const resumes = sessionExists(project_dir, session_id)

  const args = [
    '--print',
    resumes ? '--resume' : '--session-id',
    session_id,
    '--permission-mode', 'dontAsk',
    '--allowedTools', ...ALLOWED_TOOLS,
    '--add-dir', project_dir,
    '--append-system-prompt', WORKER_FORMAT_RULE,
  ]

  const claudeBin = resolveClaudeBin()
  if (!claudeBin) {
    return { code: 1, stdout: '', stderr: '[spawn-error] no claude binary found on host', durationMs: 0 }
  }
  const child = spawn(claudeBin, args, {
    cwd: project_dir,
    env: { ...process.env, ...env, TG_ROUTER_CHILD: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const startedAt = Date.now()
  let stdout = ''
  let stderr = ''
  let killed = false

  child.stdin.write(prompt)
  child.stdin.end()

  const timer = setTimeout(() => {
    killed = true
    try { child.kill('SIGTERM') } catch {}
    setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 5000)
  }, timeout_ms)

  let stdoutBuf = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    stdout += chunk
    if (onStdoutLine) {
      stdoutBuf += chunk
      let idx
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx)
        stdoutBuf = stdoutBuf.slice(idx + 1)
        try { onStdoutLine(line) } catch {}
      }
    }
  })

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })

  const code = await new Promise((resolve) => {
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve(code ?? (signal ? 128 : 1))
    })
    child.on('error', err => {
      clearTimeout(timer)
      stderr += `\n[spawn-error] ${err.message}`
      resolve(1)
    })
  })

  // Post-create patch: rewrite "sdk-cli" → "claude-vscode" in JSONL records so
  // newly created sessions show up in VS Code Sidebar. Safe — claude --print
  // has already finished writing (no concurrent writes).
  // Only run for new sessions (resumes === false), and only on success.
  if (!resumes && code === 0) {
    try {
      patchFirstEntrypointToVscode(project_dir, session_id)
    } catch (err) {
      console.error('tg-router: entrypoint patch failed:', err.message)
    }
  }

  return {
    code,
    stdout,
    stderr,
    killed,
    durationMs: Date.now() - startedAt,
    limit: parseUsageLimit(stdout + '\n' + stderr),
  }
}

// Распознать причину «лимит Anthropic» в выводе claude --print.
// Возвращает:
//   { limited:bool, kind:'plan'|'server'|null, resetAt:Date|null, resetText:string|null, raw:string }
//   kind='plan'   — исчерпан лимит подписки/плана (долгое ожидание, есть время сброса)
//   kind='server' — серверный rate-limit / overloaded / 429 (временно, можно повторить)
function parseUsageLimit(text) {
  const out = { limited: false, kind: null, resetAt: null, resetText: null, raw: '' }
  if (!text) return out
  const t = String(text)

  // 1) Канонический print-режим: "Claude AI usage limit reached|<epoch_seconds>"
  let m = t.match(/Claude AI usage limit reached\|(\d{9,13})/i)
  if (m) {
    out.limited = true; out.kind = 'plan'
    const n = parseInt(m[1], 10)
    out.resetAt = new Date(n < 1e12 ? n * 1000 : n)   // секунды или мс
    out.raw = m[0]
    return out
  }

  // 2) План-лимит текстом: "usage limit reached ... resets at 3pm" / "limit will reset at ..."
  if (/usage limit|plan limit|limit reached|reached your .* limit|5-hour limit|weekly limit/i.test(t)) {
    out.limited = true; out.kind = 'plan'
    const r = t.match(/reset[s]?(?:\s+at)?\s+([^\n.|]{3,40})/i)
                || t.match(/try again (?:at|after)\s+([^\n.|]{3,40})/i)
    if (r) out.resetText = r[1].trim()
    out.raw = (t.match(/[^\n]*limit[^\n]*/i) || [''])[0].slice(0, 200)
    return out
  }

  // 3) Серверный rate-limit / перегрузка (временно)
  if (/\b429\b|rate limit|overloaded|too many requests|service unavailable|529/i.test(t)) {
    out.limited = true; out.kind = 'server'
    const r = t.match(/retry[- ]after[:\s]+(\d+)/i)
    if (r) { out.resetAt = new Date(Date.now() + parseInt(r[1], 10) * 1000) }
    out.raw = (t.match(/[^\n]*(429|rate limit|overloaded|too many)[^\n]*/i) || [''])[0].slice(0, 200)
    return out
  }

  return out
}

module.exports = {
  runClaudeWorker,
  sessionJsonlPath,
  sessionExists,
  projectSlug,
  parseUsageLimit,
  ALLOWED_TOOLS,
}
