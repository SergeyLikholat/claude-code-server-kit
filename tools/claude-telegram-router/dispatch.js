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

function projectSlug(dir) {
  // Matches claude-code's slug logic: '/' AND '_' → '-' (claude-code normalizes both).
  return dir.replace(/[/_]/g, '-')
}

function sessionJsonlPath(projectDir, sessionId) {
  return join(homedir(), '.claude', 'projects', projectSlug(projectDir), `${sessionId}.jsonl`)
}

function sessionExists(projectDir, sessionId) {
  return existsSync(sessionJsonlPath(projectDir, sessionId))
}

// Spawn claude worker.
//   opts: { project_dir, session_id, prompt, timeout_ms, env, onStdoutLine }
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
    '--append-system-prompt', TG_FORMAT_RULE,
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
