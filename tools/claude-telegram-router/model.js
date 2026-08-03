// Per-SESSION model selection for Telegram-driven workers.
//
// Why this exists: the worker spawns `claude --print` headlessly. Without an
// explicit --model flag the CLI resolves its own default, which is NOT the
// model chosen in the VS Code session sharing the same JSONL — and that
// implicit default drifts over time (account/org side). The result was a
// session silently switching models between messages with no way to control it
// from Telegram.
//
// Keyed by session_id, NOT by chat/topic: "hard task → stronger model" is a
// property of the work living in that session, and a bridged topic can be
// re-pointed at a different session at any time via /connect. Pinning to the
// topic would leave the model behind when the session changes.
//
// State lives in <STATE_DIR>/model.json:
//   { "__default": "claude-opus-5", "<session_id>": "claude-fable-5" }
// Value AUTO means "pass no --model flag" (fall back to CLI's own resolution).
//
// STATE_DIR is per-router (TELEGRAM_STATE_DIR), so each bot instance pins models
// independently — a second router must not read or write the first one's file.

const { readFileSync, writeFileSync, mkdirSync } = require('fs')
const { dirname, join } = require('path')
const { STATE_DIR } = require('./access')

const STATE_FILE = process.env.TG_MODEL_STATE_FILE || join(STATE_DIR, 'model.json')
const DEFAULT_KEY = '__default'

// Sentinel for "let the CLI decide" — deliberately not a real model id.
const AUTO = 'auto'

// Sentinel for "use whatever VS Code last used in THIS session". The model
// picked in the VS Code UI is not persisted to any file we can read, but every
// assistant turn records the model that answered it — so the last claude-vscode
// turn in the session JSONL is a faithful read of the current VS Code choice.
const FOLLOW = 'follow'

// Used when FOLLOW is active but the session has no VS Code turns to learn from
// (e.g. a session created and only ever driven from Telegram).
const FOLLOW_FALLBACK = 'claude-opus-5'

// Shortlist offered as buttons. Any other string can still be set via
// `/model <id>` — we do not hard-fail on unknown ids, the CLI validates.
const MODEL_CHOICES = [
  { id: 'claude-opus-5',              label: 'Opus 5',    hint: 'сложные задачи' },
  { id: 'claude-sonnet-5',            label: 'Sonnet 5',  hint: 'рабочая лошадка' },
  { id: 'claude-fable-5',             label: 'Fable 5',   hint: 'самая дорогая' },
  { id: 'claude-haiku-4-5-20251001',  label: 'Haiku 4.5', hint: 'простые задачи' },
  { id: AUTO,                         label: 'Auto',      hint: 'решает CLI, дрейфует' },
  { id: FOLLOW,                       label: 'Как в VS Code', hint: 'синхронно с сессией' },
]

// Model used when a session has no pin and no global default was configured.
// Explicit on purpose: an implicit default is exactly the drift this module
// was built to stop.
const BUILTIN_DEFAULT = FOLLOW

function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return {} }
}

function writeState(state) {
  try { mkdirSync(dirname(STATE_FILE), { recursive: true }) } catch {}
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

// Raw setting for a session, falling back to the global default. May be AUTO.
function getModelSetting(sessionId) {
  const state = readState()
  if (sessionId && state[sessionId]) return state[sessionId]
  return state[DEFAULT_KEY] || BUILTIN_DEFAULT
}

// Read the model of the most recent VS Code turn in a session. Scans the tail
// only — session JSONLs reach hundreds of MB. Returns null when the tail holds
// no claude-vscode assistant turn.
function readVscodeModel(jsonlPath, tailBytes = 2 * 1024 * 1024) {
  const fs = require('fs')
  let fd
  try {
    fd = fs.openSync(jsonlPath, 'r')
    const size = fs.fstatSync(fd).size
    const len = Math.min(tailBytes, size)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, size - len)
    const lines = buf.toString('utf8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line.includes('"type":"assistant"')) continue
      if (!line.includes('"entrypoint":"claude-vscode"')) continue
      let obj
      try { obj = JSON.parse(line) } catch { continue }
      if (obj.type !== 'assistant' || obj.entrypoint !== 'claude-vscode') continue
      const m = obj.message && obj.message.model
      if (m && m !== '<synthetic>') return m
    }
    return null
  } catch {
    return null
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch {} }
  }
}

// What runClaudeWorker should receive: a model id, or null to omit --model.
// jsonlPath is required to resolve FOLLOW; without it FOLLOW degrades to the
// fallback model rather than guessing.
function resolveModelFlag(sessionId, jsonlPath = null) {
  const val = getModelSetting(sessionId)
  if (val === AUTO) return null
  if (val === FOLLOW) {
    const fromVscode = jsonlPath ? readVscodeModel(jsonlPath) : null
    return fromVscode || FOLLOW_FALLBACK
  }
  return val
}

// Human-readable resolution of the current setting, for /status and /model.
function describe(sessionId, jsonlPath = null) {
  const val = getModelSetting(sessionId)
  if (val === FOLLOW) {
    const fromVscode = jsonlPath ? readVscodeModel(jsonlPath) : null
    return fromVscode
      ? { effective: fromVscode, note: 'синхронно с VS Code' }
      : { effective: FOLLOW_FALLBACK, note: 'в сессии нет турнов VS Code — запасная' }
  }
  if (val === AUTO) return { effective: null, note: 'решает CLI (дрейфует)' }
  return { effective: val, note: 'закреплено вручную' }
}

function setModel(sessionId, model) {
  const state = readState()
  state[sessionId] = model
  writeState(state)
  return model
}

// Drop the per-session pin so it follows the global default again.
function clearModel(sessionId) {
  const state = readState()
  delete state[sessionId]
  writeState(state)
}

function setGlobalDefault(model) {
  const state = readState()
  state[DEFAULT_KEY] = model
  writeState(state)
  return model
}

function getGlobalDefault() {
  return readState()[DEFAULT_KEY] || BUILTIN_DEFAULT
}

// True when this session carries its own pin (vs inheriting the default).
function hasOverride(sessionId) {
  if (!sessionId) return false
  return Boolean(readState()[sessionId])
}

function labelFor(modelId) {
  const found = MODEL_CHOICES.find(m => m.id === modelId)
  return found ? found.label : modelId
}

// Short badge for session lists — empty unless the session is explicitly
// pinned, so the list stays quiet for everything running on the default.
function badgeFor(sessionId) {
  if (!hasOverride(sessionId)) return ''
  return labelFor(readState()[sessionId])
}

// Inline keyboard for the model picker. `sessionId` marks the active choice.
function buildPickerKeyboard(sessionId) {
  const current = getModelSetting(sessionId)
  const rows = MODEL_CHOICES.map(m => ([{
    text: `${m.id === current ? '● ' : ''}${m.label} · ${m.hint}`,
    callback_data: `model:${m.id}`,
  }]))
  rows.push([
    { text: '↩️ Сбросить', callback_data: 'model:__reset' },
    { text: '⬅️ Назад',   callback_data: 'model:__close' },
  ])
  return { inline_keyboard: rows }
}

module.exports = {
  AUTO,
  FOLLOW,
  FOLLOW_FALLBACK,
  readVscodeModel,
  describe,
  MODEL_CHOICES,
  BUILTIN_DEFAULT,
  getModelSetting,
  resolveModelFlag,
  setModel,
  clearModel,
  setGlobalDefault,
  getGlobalDefault,
  hasOverride,
  labelFor,
  badgeFor,
  buildPickerKeyboard,
}
