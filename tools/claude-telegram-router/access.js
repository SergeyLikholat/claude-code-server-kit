// Access control — allowlist + pairing, ported from plugin server.ts.
// Reads/writes ~/.claude/channels/telegram/access.json. Same semantics.

const { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, renameSync } = require('fs')
const { randomBytes } = require('crypto')
const { join } = require('path')
const { homedir } = require('os')

const STATE_DIR = process.env.TELEGRAM_STATE_DIR || join(homedir(), '.claude', 'channels', 'telegram')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const APPROVED_DIR = join(STATE_DIR, 'approved')

function defaultAccess() {
  return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }
}

function readAccessFile() {
  try {
    const parsed = JSON.parse(readFileSync(ACCESS_FILE, 'utf8'))
    return {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      mentionPatterns: parsed.mentionPatterns,
    }
  } catch (err) {
    if (err.code === 'ENOENT') return defaultAccess()
    try { renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`) } catch {}
    process.stderr.write('tg-router: access.json corrupt, moved aside\n')
    return defaultAccess()
  }
}

function saveAccess(a) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, ACCESS_FILE)
}

function pruneExpired(a) {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) { delete a.pending[code]; changed = true }
  }
  return changed
}

function isMentioned(ctx, botUsername, extraPatterns) {
  const entities = ctx.message?.entities ?? ctx.message?.caption_entities ?? []
  const text = ctx.message?.text ?? ctx.message?.caption ?? ''
  for (const e of entities) {
    if (e.type === 'mention') {
      const m = text.slice(e.offset, e.offset + e.length)
      if (m.toLowerCase() === `@${botUsername}`.toLowerCase()) return true
    }
    if (e.type === 'text_mention' && e.user?.is_bot && e.user.username === botUsername) return true
  }
  if (ctx.message?.reply_to_message?.from?.username === botUsername) return true
  for (const pat of extraPatterns ?? []) {
    try { if (new RegExp(pat, 'i').test(text)) return true } catch {}
  }
  return false
}

// Returns one of:
//   { action: 'deliver' }
//   { action: 'drop' }
//   { action: 'pair', code, isResend }
function gate(ctx, botUsername) {
  const access = readAccessFile()
  if (pruneExpired(access)) saveAccess(access)
  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  const from = ctx.from
  if (!from) return { action: 'drop' }
  const senderId = String(from.id)
  const chatType = ctx.chat?.type

  if (chatType === 'private') {
    if (access.allowFrom.includes(senderId)) return { action: 'deliver' }
    if (access.dmPolicy === 'allowlist') return { action: 'drop' }
    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        p.replies = (p.replies ?? 1) + 1
        saveAccess(access)
        return { action: 'pair', code, isResend: true }
      }
    }
    if (Object.keys(access.pending).length >= 3) return { action: 'drop' }
    const code = randomBytes(3).toString('hex')
    const now = Date.now()
    access.pending[code] = {
      senderId,
      chatId: String(ctx.chat.id),
      createdAt: now,
      expiresAt: now + 60 * 60 * 1000,
      replies: 1,
    }
    saveAccess(access)
    return { action: 'pair', code, isResend: false }
  }

  if (chatType === 'group' || chatType === 'supergroup') {
    const groupId = String(ctx.chat.id)
    const policy = access.groups[groupId]
    if (!policy) return { action: 'drop' }
    const allow = policy.allowFrom ?? []
    const requireMention = policy.requireMention ?? true
    if (allow.length > 0 && !allow.includes(senderId)) return { action: 'drop' }
    if (requireMention && !isMentioned(ctx, botUsername, access.mentionPatterns)) return { action: 'drop' }
    return { action: 'deliver' }
  }

  return { action: 'drop' }
}

function checkApprovals(bot) {
  let files
  try { files = readdirSync(APPROVED_DIR) } catch { return }
  if (!files.length) return
  for (const senderId of files) {
    const file = join(APPROVED_DIR, senderId)
    bot.api.sendMessage(senderId, 'Paired! Say hi to Claude.')
      .finally(() => { try { rmSync(file, { force: true }) } catch {} })
  }
}

module.exports = { gate, checkApprovals, APPROVED_DIR, STATE_DIR, ACCESS_FILE }
