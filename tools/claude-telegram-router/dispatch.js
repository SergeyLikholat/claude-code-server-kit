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
    const extDir = '/root/.vscode-server/extensions'
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

// System-prompt appended to every worker — forces safe Telegram formatting.
const TG_FORMAT_RULE = [
  '',
  '## Telegram delivery (CRITICAL — read before answering)',
  '',
  'You are running as a headless Telegram worker. The user CANNOT see your stdout, transcript, thinking, or any text you write outside of tool calls.',
  '',
  'The ONLY way the user sees a response is via `mcp__plugin_telegram_telegram__reply`.',
  '',
  '- EVERY turn that produces a user-visible response MUST call `mcp__plugin_telegram_telegram__reply` with the `chat_id` from the incoming `<channel ...>` tag (and `message_thread_id` if present).',
  '- Even short acknowledgements ("на связи", "понял", "готово") MUST go through `reply`. Plain assistant text is silently discarded.',
  '- If you have nothing to say (e.g. the message was an automated heartbeat), call `react` instead — but never end a turn that the user is waiting on without sending something via reply or react.',
  '- Reactions (`react`) supplement reply; they do NOT replace it for substantive answers.',
  '',
  '## Telegram reply formatting (STRICT)',
  '',
  'When calling `mcp__plugin_telegram_telegram__reply`:',
  '- ALWAYS pass `format="text"` (or omit it — default is text).',
  '- NEVER pass `format="markdownv2"`. The plugin auto-formats text → MarkdownV2.',
  '- For bold write `**text**`; italic `*text*`; code `` `code` ``; fenced block ```` ```lang\\ncode\\n``` ````. Plugin converts these to valid MarkdownV2.',
  '- Do NOT escape characters yourself. The plugin escapes everything.',
  '- If you really need pre-escaped MarkdownV2 (rare), double-check pattern `*bold*` (one asterisk) — `**` is invalid bold in MarkdownV2.',
].join('\n')

const ALLOWED_TOOLS = [
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent', 'WebFetch', 'WebSearch', 'TodoWrite',
  'mcp__plugin_telegram_telegram__reply',
  'mcp__plugin_telegram_telegram__react',
  'mcp__plugin_telegram_telegram__edit_message',
  'mcp__plugin_telegram_telegram__download_attachment',
  'mcp__yougile__yougile_list_projects',
  'mcp__yougile__yougile_list_boards',
  'mcp__yougile__yougile_list_columns',
  'mcp__yougile__yougile_list_tasks',
  'mcp__yougile__yougile_get_task',
  'mcp__yougile__yougile_create_task',
  'mcp__yougile__yougile_update_task',
  'mcp__yougile__yougile_list_contacts',
  'mcp__yougile__yougile_create_contact',
  'mcp__yougile__yougile_list_comments',
  'mcp__yougile__yougile_add_comment',
  'mcp__yougile__yougile_list_stickers',
  'mcp__plugin_context7_context7__resolve-library-id',
  'mcp__plugin_context7_context7__query-docs',
]

// Tools for bridged sessions (VS Code Live): NO MCP Telegram tools.
// Daemon auto-pulls the final assistant message from JSONL and sends it itself,
// so Claude must NOT call mcp__plugin_telegram_telegram__reply.
const ALLOWED_TOOLS_BRIDGED = ALLOWED_TOOLS.filter(t => !t.startsWith('mcp__plugin_telegram_'))

const BRIDGED_FORMAT_RULE = [
  '',
  '## Bridged mode (CRITICAL — read before answering)',
  '',
  'You are running inside a Telegram VS Code Live bridge. The daemon will fetch your final assistant message from the JSONL session log and send it to Telegram automatically.',
  '',
  '- DO NOT call mcp__plugin_telegram_telegram__reply or any telegram MCP tools. They are not available in this mode.',
  '- Write your final answer as a normal assistant message (plain text + standard Markdown). The daemon converts it to Telegram HTML and sends it.',
  '- Use other tools (Bash, Read, Edit, etc.) freely for the actual work — just do not try to send messages via MCP.',
  '- Markdown: use **bold**, *italic*, `code`, ```fenced```, [links](url), ## headings — daemon converts everything correctly.',
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
//   opts: { project_dir, session_id, prompt, timeout_ms, env, onStdoutLine, bridged }
//   bridged=true → MCP Telegram tools removed from allowedTools, replaced system prompt
//   so Claude writes its final answer as a plain assistant message instead of
//   calling mcp__plugin_telegram_telegram__reply. Daemon then auto-pulls from JSONL.
// Returns: { code, stdout, stderr, durationMs }
async function runClaudeWorker(opts) {
  const { project_dir, session_id, prompt, timeout_ms = 600000, env = {}, onStdoutLine, bridged = false } = opts

  mkdirSync(project_dir, { recursive: true })
  const resumes = sessionExists(project_dir, session_id)

  const tools = bridged ? ALLOWED_TOOLS_BRIDGED : ALLOWED_TOOLS
  const sysPromptAppend = bridged ? BRIDGED_FORMAT_RULE : TG_FORMAT_RULE
  const args = [
    '--print',
    resumes ? '--resume' : '--session-id',
    session_id,
    '--permission-mode', 'dontAsk',
    '--allowedTools', ...tools,
    '--add-dir', project_dir,
    '--append-system-prompt', sysPromptAppend,
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
  }
}

module.exports = {
  runClaudeWorker,
  sessionJsonlPath,
  sessionExists,
  projectSlug,
  ALLOWED_TOOLS,
}
