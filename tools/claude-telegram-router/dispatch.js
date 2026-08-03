// Spawn headless claude worker for a single Telegram message.
// Session persistence: deterministic UUID per topic + --session-id / --resume.

const { spawn } = require('child_process')
const { existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, copyFileSync } = require('fs')
const { join } = require('path')
const { homedir } = require('os')
const crypto = require('crypto')

// Resolve claude binary. The historical hard-coded /usr/bin/claude does not
// exist on this host — the only working binary ships inside the VS Code
// extension. The version is in the path, so glob for the newest install at
// each spawn so we survive extension updates.
// Newer claude binaries (≥2.1.179) support proper prompt caching and large
// session handling via --resume. Old standalone CLIs (e.g. 2.1.143 at
// /root/.local/bin/claude) fail with "Prompt is too long" on big sessions.
// So PREFER the latest VS Code extension binary, fall back to standalone.
let _cachedBin = null
function resolveClaudeBin() {
  if (_cachedBin && existsSync(_cachedBin)) return _cachedBin
  if (process.env.CLAUDE_BIN && existsSync(process.env.CLAUDE_BIN)) {
    _cachedBin = process.env.CLAUDE_BIN
    return _cachedBin
  }
  // 1) Newest VS Code extension binary (has prompt caching, handles big sessions).
  try {
    const extDir = '/root/.vscode-server/extensions'
    const entries = readdirSync(extDir)
      .filter((n) => /^anthropic\.claude-code-.*-linux-x64$/.test(n))
      .map((n) => {
        const p = join(extDir, n, 'resources', 'native-binary', 'claude')
        if (!existsSync(p)) return null
        // Extract version from dir name for sorting (e.g. 2.1.181 > 2.1.143).
        const verMatch = n.match(/^anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)-/)
        const ver = verMatch ? [parseInt(verMatch[1]), parseInt(verMatch[2]), parseInt(verMatch[3])] : [0, 0, 0]
        return { p, ver, mtime: statSync(p).mtimeMs }
      })
      .filter(Boolean)
      .sort((a, b) => {
        // Sort by semantic version desc (latest first), tiebreak by mtime.
        for (let i = 0; i < 3; i++) {
          if (b.ver[i] !== a.ver[i]) return b.ver[i] - a.ver[i]
        }
        return b.mtime - a.mtime
      })
    if (entries.length) { _cachedBin = entries[0].p; return _cachedBin }
  } catch (_) {}
  // 2) Fallback to standalone binaries (may be older — last resort).
  const candidates = [
    '/usr/local/bin/claude',
    '/usr/bin/claude',
    '/root/.bun/bin/claude',
    '/root/.local/bin/claude',
  ]
  for (const c of candidates) {
    if (existsSync(c)) { _cachedBin = c; return c }
  }
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

// Tools for bridged sessions (VS Code Live): no MCP telegram OUTGOING tools.
// Daemon auto-pulls the final assistant message from JSONL and sends it itself,
// so Claude must NOT call mcp__plugin_telegram_telegram__reply / react / edit_message.
// But `download_attachment` IS allowed — without it Claude can't handle voice
// messages, photos or documents (it just exits when seeing attachment_file_id).
const ALLOWED_TOOLS_BRIDGED = ALLOWED_TOOLS.filter(t => {
  if (!t.startsWith('mcp__plugin_telegram_')) return true
  return t === 'mcp__plugin_telegram_telegram__download_attachment'
})

const BRIDGED_FORMAT_RULE = [
  '',
  '## Bridged mode (CRITICAL — read before answering)',
  '',
  'You are running inside a Telegram VS Code Live bridge. The daemon will fetch your final assistant message from the JSONL session log and send it to Telegram automatically.',
  '',
  '- DO NOT call mcp__plugin_telegram_telegram__reply, react, or edit_message. They are not available in this mode.',
  '- For incoming voice/photo/document attachments use `mcp__plugin_telegram_telegram__download_attachment` — that one IS available. After downloading you can transcribe voice via `/opt/parakeet/transcribe.py <path>` or read the file directly.',
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

// Standard "summary harvest" prompt — instructs Claude to produce a structured
// recap of the session, identical in form to what `/compact` slash-command does
// internally. Daemon then writes the summary back as an isCompactSummary record.
const COMPACT_SUMMARY_PROMPT = [
  'Your context is at risk of overflow. Produce a structured recap of this conversation that lets you continue seamlessly afterwards. Cover ALL sections, in this exact order, with concrete details (file paths, function names, ids, decisions, error texts, exact intent quotes from the user):',
  '',
  '1. Primary Request and Intent — what the user actually wants, including the most recent explicit request verbatim or near-verbatim.',
  '2. Key Technical Concepts — frameworks, libraries, services, models, data formats touched.',
  '3. Files and Code Sections — every path read or edited, with a one-line note of why.',
  '4. Errors and Fixes — anything that broke and how it was resolved.',
  '5. Problem Solving — non-obvious reasoning steps, hypotheses tested, dead ends.',
  '6. All User Messages — every meaningful user instruction, paraphrased compactly but completely.',
  '7. Pending Tasks — anything queued but not done.',
  '8. Current Work — what was being done at the moment of compaction.',
  '9. Optional Next Step — the single most useful next action.',
  '',
  'Output the recap as a plain assistant message (Markdown). Be exhaustive — losing detail here means losing it forever.',
].join('\n')

// VS Code writes `ai-title` / `custom-title` records interleaved with the
// conversation (it re-appends them after almost every turn, latest wins), NOT
// in the header block before the first user turn. Any compact that keeps only
// header records therefore destroys the session title, and the Sidebar — which
// needs a title to render a row — drops the session from the list entirely.
// The Telegram list hides the damage because it falls back to `slug`.
//
// Returns the latest ai-title / custom-title records as ready-to-write JSONL
// lines, sessionId normalized to the session being rewritten.
function collectTitleRecords(lines, sessionId) {
  const latest = { 'ai-title': null, 'custom-title': null }
  for (const line of lines) {
    if (!line || (!line.includes('"type":"ai-title"') && !line.includes('"type":"custom-title"'))) continue
    let obj
    try { obj = JSON.parse(line) } catch { continue }
    if (obj.type !== 'ai-title' && obj.type !== 'custom-title') continue
    if (obj.type === 'ai-title' && !obj.aiTitle) continue
    if (obj.type === 'custom-title' && !obj.customTitle) continue
    obj.sessionId = sessionId
    latest[obj.type] = JSON.stringify(obj)
  }
  return [latest['ai-title'], latest['custom-title']].filter(Boolean)
}

// Compact via truncated JSONL hack: when the real session is too large for
// claude --resume to load (context_length_exceeded), we make a tiny temporary
// session containing only attachment headers + the last ~10MB of conversation,
// ask claude to summarize that, then write the summary back into the original
// JSONL as an isCompactSummary record and drop the original raw turns.
//
// opts: { tailBytes: limit how much tail conversation to include (default 8 MB) }
async function compactViaTruncate(projectDir, sessionId, opts = {}) {
  const fs = require('fs')
  const { randomUUID } = require('crypto')
  const tailBudget = opts.tailBytes || (8 * 1024 * 1024)
  const origPath = sessionJsonlPath(projectDir, sessionId)
  if (!fs.existsSync(origPath)) return { ok: false, error: 'jsonl not found' }
  const origContent = fs.readFileSync(origPath, 'utf8')
  const origLines = origContent.split('\n').filter(l => l.trim())
  // Separate header records (attachments before first user/assistant) from conversation.
  const headerLines = []
  const convLines = []
  let inConversation = false
  for (const line of origLines) {
    if (!inConversation) {
      try {
        const obj = JSON.parse(line)
        if (obj.type === 'user' || obj.type === 'assistant' || obj.type === 'tool_use' || obj.type === 'tool_result') {
          inConversation = true
        }
      } catch { continue }
    }
    if (inConversation) convLines.push(line)
    else headerLines.push(line)
  }
  // Pick the last ~tailBudget bytes of conversation. Walk from end backwards
  // until we've accumulated enough.
  let accBytes = 0
  let cutIdx = convLines.length
  for (let i = convLines.length - 1; i >= 0; i--) {
    accBytes += convLines[i].length + 1
    if (accBytes >= tailBudget) { cutIdx = i; break }
  }
  const tailConv = convLines.slice(cutIdx)
  // Build temporary session with new UUID. Rewrite sessionId inside each line so
  // claude doesn't complain about mismatch.
  const tmpSessionId = randomUUID()
  const rewriteSessionId = (line) => {
    try {
      const obj = JSON.parse(line)
      if (obj.sessionId === sessionId) obj.sessionId = tmpSessionId
      if (obj.message?.content && typeof obj.message.content === 'string' && obj.message.content.includes(sessionId)) {
        // leave content alone — references inside body are fine
      }
      return JSON.stringify(obj)
    } catch { return line }
  }
  const tmpLines = [...headerLines.map(rewriteSessionId), ...tailConv.map(rewriteSessionId)]
  const tmpPath = sessionJsonlPath(projectDir, tmpSessionId)
  mkdirSync(require('path').dirname(tmpPath), { recursive: true })
  fs.writeFileSync(tmpPath, tmpLines.join('\n') + '\n', { mode: 0o600 })
  // Run claude on the truncated session.
  let summary = null
  try {
    const res = await runClaudeWorker({
      project_dir: projectDir,
      session_id: tmpSessionId,
      prompt: COMPACT_SUMMARY_PROMPT,
      timeout_ms: 600000,
      bridged: true,
      model: opts.model || null,
    })
    if (res.code !== 0) {
      return { ok: false, error: `summary worker code=${res.code}`, stderr: (res.stderr || '').slice(-300) }
    }
    // Read latest assistant from tmp jsonl.
    const tmpContent = fs.readFileSync(tmpPath, 'utf8')
    const tmpLinesAfter = tmpContent.split('\n')
    for (let i = tmpLinesAfter.length - 1; i >= 0; i--) {
      const line = tmpLinesAfter[i]
      if (!line.includes('"type":"assistant"')) continue
      try {
        const obj = JSON.parse(line)
        if (obj.type !== 'assistant') continue
        const content = obj.message?.content
        if (Array.isArray(content)) {
          let txt = ''
          for (const p of content) if (p?.text) txt += p.text
          if (txt.trim()) { summary = txt.trim(); break }
        } else if (typeof content === 'string' && content.trim()) {
          summary = content.trim(); break
        }
      } catch {}
    }
  } finally {
    // Clean up tmp JSONL no matter what.
    try { fs.unlinkSync(tmpPath) } catch {}
  }
  if (!summary) return { ok: false, error: 'summary not generated' }
  // Backup original and rewrite with isCompactSummary record.
  const bakPath = `${origPath}.bak-precompact-${Date.now()}`
  fs.copyFileSync(origPath, bakPath)
  const cwdFromHeader = headerLines.length > 0
    ? (() => { try { return JSON.parse(headerLines[headerLines.length - 1]).cwd } catch { return projectDir } })()
    : projectDir
  const versionFromHeader = headerLines.length > 0
    ? (() => { try { return JSON.parse(headerLines[headerLines.length - 1]).version } catch { return '2.1.143' } })()
    : '2.1.143'
  const lastHeaderUuid = headerLines.length > 0
    ? (() => { try { return JSON.parse(headerLines[headerLines.length - 1]).uuid } catch { return null } })()
    : null
  const summaryRec = {
    parentUuid: lastHeaderUuid,
    isSidechain: false,
    promptId: randomUUID(),
    type: 'user',
    message: {
      role: 'user',
      content: `This session is being continued from a previous conversation that was compacted to free context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n${summary}\n\nContinue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I'll continue" or similar. Pick up the last task as if the break never happened.`,
    },
    isVisibleInTranscriptOnly: true,
    isCompactSummary: true,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    userType: 'external',
    entrypoint: 'claude-vscode',
    cwd: cwdFromHeader,
    sessionId: sessionId,
    version: versionFromHeader,
    gitBranch: 'HEAD',
  }
  // Carry the session title across the rewrite — otherwise VS Code Sidebar
  // loses the session and it only stays reachable from Telegram.
  const titleLines = collectTitleRecords(origLines, sessionId)
  const newLines = [...headerLines, JSON.stringify(summaryRec), ...titleLines]
  fs.writeFileSync(origPath, newLines.join('\n') + '\n')
  const newSize = fs.statSync(origPath).size
  const oldSize = fs.statSync(bakPath).size
  return {
    ok: true,
    backup: bakPath,
    oldBytes: oldSize,
    newBytes: newSize,
    reduction: oldSize > 0 ? Math.round((1 - newSize / oldSize) * 100) : 0,
    summaryLen: summary.length,
  }
}

// Rewrite JSONL: keep initial attachment/system records, drop all user/assistant
// turns, append one isCompactSummary user-record with the provided summary text.
// Mirrors what /compact does internally so the next --resume continues seamlessly.
function compactRewriteJsonl(projectDir, sessionId, summaryText) {
  const fs = require('fs')
  const { randomUUID } = require('crypto')
  const path = sessionJsonlPath(projectDir, sessionId)
  if (!fs.existsSync(path)) return { ok: false, error: 'jsonl not found' }
  // Backup first — safety net in case rewrite breaks.
  const bakPath = `${path}.bak-precompact-${Date.now()}`
  fs.copyFileSync(path, bakPath)
  const orig = fs.readFileSync(path, 'utf8')
  const lines = orig.split('\n')
  const kept = []
  let lastAttachmentUuid = null
  let cwd = projectDir
  let version = '2.1.143'
  let gitBranch = 'HEAD'
  for (const line of lines) {
    if (!line.trim()) continue
    let obj
    try { obj = JSON.parse(line) } catch { continue }
    // Keep ONLY initial attachment/queue-operation/system records (before first user/assistant turn).
    if (obj.cwd) cwd = obj.cwd
    if (obj.version) version = obj.version
    if (obj.gitBranch) gitBranch = obj.gitBranch
    if (obj.type === 'user' || obj.type === 'assistant' || obj.type === 'tool_use' || obj.type === 'tool_result') {
      // Reached first conversational turn — stop collecting kept records.
      break
    }
    kept.push(line)
    if (obj.uuid) lastAttachmentUuid = obj.uuid
  }
  // Append the compact-summary user record (the format Claude Code uses internally).
  const summaryRecord = {
    parentUuid: lastAttachmentUuid,
    isSidechain: false,
    promptId: randomUUID(),
    type: 'user',
    message: {
      role: 'user',
      content: `This session is being continued from a previous conversation that was compacted to free context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n${summaryText}\n\nContinue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I'll continue" or similar. Pick up the last task as if the break never happened.`,
    },
    isVisibleInTranscriptOnly: true,
    isCompactSummary: true,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    userType: 'external',
    entrypoint: 'claude-vscode',
    cwd: cwd,
    sessionId: sessionId,
    version: version,
    gitBranch: gitBranch,
  }
  kept.push(JSON.stringify(summaryRecord))
  // Same as in compactViaTruncate — title records live inside the conversation
  // block that we just dropped, so re-emit them explicitly.
  kept.push(...collectTitleRecords(lines, sessionId))
  fs.writeFileSync(path, kept.join('\n') + '\n')
  const newSize = fs.statSync(path).size
  const oldSize = fs.statSync(bakPath).size
  return {
    ok: true,
    backup: bakPath,
    oldBytes: oldSize,
    newBytes: newSize,
    reduction: oldSize > 0 ? Math.round((1 - newSize / oldSize) * 100) : 0,
  }
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

// Safety net for RESUMED sessions. patchFirstEntrypointToVscode only runs for
// newly created sessions, so a session that lost its title mid-life (e.g. a
// compact that predates collectTitleRecords, or a manual JSONL surgery) would
// stay invisible in the VS Code Sidebar forever. This re-appends a title
// without touching entrypoints or any conversational record.
function ensureSessionTitle(projectDir, sessionId) {
  const fs = require('fs')
  const path = sessionJsonlPath(projectDir, sessionId)
  if (!fs.existsSync(path)) return false
  const content = fs.readFileSync(path, 'utf8')
  if (content.includes('"type":"ai-title"')) return false
  const lines = content.split('\n').filter(l => l.trim())
  // Prefer the slug the session was born with — that is what Telegram already
  // shows, so the two lists stay in sync.
  let title = null
  for (const line of lines) {
    if (!line.includes('"slug"')) continue
    try {
      const obj = JSON.parse(line)
      if (obj.slug) { title = obj.slug; break }
    } catch {}
  }
  if (!title) title = 'Telegram session'
  lines.push(JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId }))
  fs.writeFileSync(path, lines.join('\n') + '\n')
  return true
}

// Spawn claude worker.
//   opts: { project_dir, session_id, prompt, timeout_ms, env, onStdoutLine, bridged }
//   bridged=true → MCP Telegram tools removed from allowedTools, replaced system prompt
//   so Claude writes its final answer as a plain assistant message instead of
//   calling mcp__plugin_telegram_telegram__reply. Daemon then auto-pulls from JSONL.
// Heal a half-state JSONL session — used when claude --resume fails with
// "No deferred tool marker found". Sessions land in this state when VS Code
// (or the daemon) is killed while an assistant turn is mid tool_use: the
// last record pair is assistant.tool_use → user.tool_result with no following
// assistant turn, plus trailing noise (attachment, last-prompt, ai-title, mode).
//
// Repair procedure:
//   1. Backup full JSONL to .bak.<unix-ts>
//   2. Truncate after the last user.tool_result, dropping trailing meta records
//   3. Append a synthetic assistant turn with stop_reason="end_turn" so the
//      next --resume sees a clean conversation boundary.
//
// Returns: { healed, backupPath, droppedLines } or { healed: false, reason }.
function healHalfStateJsonl(jsonlPath) {
  if (!existsSync(jsonlPath)) return { healed: false, reason: 'jsonl-not-found' }
  let raw
  try { raw = readFileSync(jsonlPath, 'utf8') }
  catch (e) { return { healed: false, reason: `read-failed: ${e.message}` } }
  const lines = raw.split('\n')
  // Find last user.tool_result and last assistant (for structure ref)
  let lastTrIdx = -1
  let refAssistant = null
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (!l || !l.trim()) continue
    let j
    try { j = JSON.parse(l) } catch { continue }
    if (j.type === 'assistant') refAssistant = j
    if (j.type === 'user') {
      const content = (j.message && j.message.content) || []
      if (Array.isArray(content) && content.some(c => c && typeof c === 'object' && c.type === 'tool_result')) {
        lastTrIdx = i
      }
    }
  }
  if (lastTrIdx < 0) return { healed: false, reason: 'no-tool-result-in-tail' }
  if (!refAssistant) return { healed: false, reason: 'no-assistant-turn' }
  const tr = JSON.parse(lines[lastTrIdx])
  const parentUuid = tr.uuid
  const synthUuid = crypto.randomUUID()
  const synth = {
    type: 'assistant',
    message: {
      id: `msg_synth_${synthUuid.slice(0, 8)}`,
      type: 'message',
      role: 'assistant',
      model: (refAssistant.message && refAssistant.message.model) || 'claude-opus-4-7',
      content: [{ type: 'text', text: '(сессия восстановлена после обрыва)' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 1,
        service_tier: 'standard',
      },
    },
    parentUuid: parentUuid,
    isSidechain: false,
    userType: 'external',
    cwd: refAssistant.cwd || '/root',
    sessionId: refAssistant.sessionId,
    version: refAssistant.version || '2.1.185',
    gitBranch: refAssistant.gitBranch || '',
    uuid: synthUuid,
    timestamp: new Date().toISOString().replace(/\.\d+Z$/, '.000Z'),
    requestId: `synth_req_${synthUuid.slice(0, 8)}`,
  }
  const backupPath = `${jsonlPath}.bak.${Math.floor(Date.now() / 1000)}`
  try { copyFileSync(jsonlPath, backupPath) }
  catch (e) { return { healed: false, reason: `backup-failed: ${e.message}` } }
  // Keep through lastTrIdx (inclusive), drop the rest, append synth turn
  const kept = lines.slice(0, lastTrIdx + 1)
  const droppedLines = lines.length - kept.length - 1 // trailing empty line in split
  const newContent = kept.join('\n') + '\n' + JSON.stringify(synth) + '\n'
  try { writeFileSync(jsonlPath, newContent) }
  catch (e) { return { healed: false, reason: `write-failed: ${e.message}` } }
  return { healed: true, backupPath, droppedLines: Math.max(0, droppedLines) }
}

// stderr signatures that indicate a half-state JSONL recoverable by healing.
function isHalfStateError(stderr) {
  if (!stderr) return false
  return /No deferred tool marker found in the resumed session/i.test(stderr)
}

// Returns: { code, stdout, stderr, durationMs, healed?, healedInfo? }
async function runClaudeWorker(opts) {
  const first = await runClaudeWorkerOnce(opts)
  if (first.code === 0 || first.killed) return first
  if (!isHalfStateError(first.stderr)) return first
  // Half-state recoverable — heal and retry once.
  const jsonlPath = sessionJsonlPath(opts.project_dir, opts.session_id)
  const healInfo = healHalfStateJsonl(jsonlPath)
  console.error(`tg-router: half-state detected, heal=${JSON.stringify(healInfo)}`)
  if (!healInfo.healed) return first
  const second = await runClaudeWorkerOnce(opts)
  return { ...second, healed: true, healedInfo: healInfo }
}

async function runClaudeWorkerOnce(opts) {
  const { project_dir, session_id, prompt, timeout_ms = 600000, env = {}, onStdoutLine, bridged = false, model = null, onSpawn = null } = opts

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
  // Pin the model explicitly. Without this the CLI resolves its own default,
  // which drifts and ignores whatever the VS Code session picked — the topic
  // would silently change models between messages. null = caller wants the
  // CLI's own resolution.
  if (model) args.push('--model', model)

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

  // Hand the child to the caller so it can be interrupted on demand (the
  // "перебить" button). Escalates to SIGKILL if the process ignores SIGTERM.
  if (onSpawn) {
    try {
      onSpawn({
        pid: child.pid,
        kill() {
          try { child.kill('SIGTERM') } catch {}
          setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 5000)
        },
      })
    } catch (err) {
      console.error('tg-router: onSpawn hook failed:', err.message)
    }
  }

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
  } else if (code === 0) {
    // Resumed session — don't rewrite entrypoints, just make sure it still has
    // a title so it can't silently fall out of the VS Code Sidebar.
    try {
      ensureSessionTitle(project_dir, session_id)
    } catch (err) {
      console.error('tg-router: ensureSessionTitle failed:', err.message)
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
  COMPACT_SUMMARY_PROMPT,
  compactRewriteJsonl,
  compactViaTruncate,
  collectTitleRecords,
  ensureSessionTitle,
}
