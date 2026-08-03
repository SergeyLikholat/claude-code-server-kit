// Download attachments from Telegram + downscale oversized images.
// Ported from plugin server.ts resizeIfLarge() (uses ffprobe+ffmpeg).

const { mkdirSync, writeFileSync, renameSync, unlinkSync, statSync, existsSync } = require('fs')
const { join } = require('path')
const { spawnSync } = require('child_process')
const { STATE_DIR } = require('./access')

const INBOX_DIR = join(STATE_DIR, 'inbox')
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
const IMAGE_MAX_DIM = parseInt(process.env.TELEGRAM_IMAGE_MAX_DIM || '1500', 10)
const RESIZABLE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp'])

function resizeIfLarge(path) {
  try {
    const ext = (path.split('.').pop() || '').toLowerCase()
    if (!RESIZABLE_EXTS.has(ext)) return
    const probe = spawnSync(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', path],
      { encoding: 'utf8', timeout: 5000 },
    )
    if (probe.status !== 0) return
    const m = probe.stdout.trim().match(/^(\d+)x(\d+)$/)
    if (!m) return
    const w = parseInt(m[1], 10), h = parseInt(m[2], 10)
    if (w <= IMAGE_MAX_DIM && h <= IMAGE_MAX_DIM) return
    const tmp = `${path}.resize.tmp.${ext}`
    const scale = `scale='if(gt(iw,ih),min(iw,${IMAGE_MAX_DIM}),-2)':'if(gt(ih,iw),min(ih,${IMAGE_MAX_DIM}),-2)'`
    const ff = spawnSync(
      'ffmpeg',
      ['-y', '-loglevel', 'error', '-i', path, '-vf', scale, tmp],
      { encoding: 'utf8', timeout: 30000 },
    )
    if (ff.status !== 0) { try { unlinkSync(tmp) } catch {}; return }
    renameSync(tmp, path)
    process.stderr.write(`tg-router: resized ${path} (${w}x${h} -> max ${IMAGE_MAX_DIM}px)\n`)
  } catch (err) {
    process.stderr.write(`tg-router: resize failed: ${err.message}\n`)
  }
}

function safeName(name) {
  if (!name) return undefined
  const cleaned = name.replace(/[^a-zA-Z0-9._\- ]/g, '_').slice(0, 100)
  return cleaned || undefined
}

async function downloadToInbox(bot, fileId, preferExt) {
  const file = await bot.api.getFile(fileId)
  if (!file.file_path) throw new Error('Telegram returned no file_path')
  const token = process.env.TELEGRAM_BOT_TOKEN
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_ATTACHMENT_BYTES) throw new Error(`file too big: ${buf.length}`)
  const rawExt = preferExt || (file.file_path.includes('.') ? file.file_path.split('.').pop() : 'bin')
  const ext = (rawExt || 'bin').replace(/[^a-zA-Z0-9]/g, '') || 'bin'
  const uniqueId = (file.file_unique_id || '').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
  const path = join(INBOX_DIR, `${Date.now()}-${uniqueId}.${ext}`)
  mkdirSync(INBOX_DIR, { recursive: true })
  writeFileSync(path, buf)
  resizeIfLarge(path)
  return path
}

async function handlePhoto(bot, ctx) {
  const photos = ctx.message.photo
  const best = photos[photos.length - 1]
  const path = await downloadToInbox(bot, best.file_id, 'jpg')
  return { kind: 'photo', path, file_id: best.file_id }
}

// Транскрипция голосовых/аудио. Два режима, чтобы работали обе схемы установки:
//   1. PARAKEET_URL задан → HTTP-запрос к parakeet-server (модуль parakeet
//      прописывает эту переменную в .env роутера автоматически);
//   2. иначе → прямой вызов локального скрипта PARAKEET_SCRIPT
//      (по умолчанию /opt/parakeet/transcribe.py, ставится тем же модулем).
// Возвращает текст или null — при null upstream отдаёт Claude сам файл.
const PARAKEET_SCRIPT = process.env.PARAKEET_SCRIPT || '/opt/parakeet/transcribe.py'

function transcribeLocal(path) {
  try {
    const res = spawnSync('python3', [PARAKEET_SCRIPT, path],
      { encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
    if (res.status !== 0) {
      process.stderr.write(`tg-router: transcribe failed (exit ${res.status}): ${(res.stderr || '').slice(-300)}\n`)
      return null
    }
    const text = String(res.stdout || '').trim()
    return text || null
  } catch (err) {
    process.stderr.write(`tg-router: transcribe error: ${err.message}\n`)
    return null
  }
}

async function transcribe(path) {
  const { transcribeIfConfigured, PARAKEET_URL } = require('./transcribe')
  if (PARAKEET_URL) {
    const viaHttp = await transcribeIfConfigured(path)
    if (viaHttp) return viaHttp
    // сервер не ответил — пробуем локальный скрипт, если он на месте
  }
  if (!existsSync(PARAKEET_SCRIPT)) return null
  return transcribeLocal(path)
}

async function handleVoice(bot, ctx) {
  const v = ctx.message.voice
  const path = await downloadToInbox(bot, v.file_id, 'oga')
  // Pre-transcribe so Claude receives plain text instead of an unprocessed file
  // reference (saves context, no need for Claude to call download_attachment).
  const transcript = await transcribe(path)
  return { kind: 'voice', path, file_id: v.file_id, mime: v.mime_type, transcript }
}

async function handleAudioWithTranscript(bot, ctx) {
  const a = ctx.message.audio
  const path = await downloadToInbox(bot, a.file_id, 'mp3')
  const transcript = await transcribe(path)
  return { kind: 'audio', path, file_id: a.file_id, mime: a.mime_type, transcript }
}

async function handleDocument(bot, ctx) {
  const d = ctx.message.document
  const ext = d.file_name ? d.file_name.split('.').pop() : undefined
  const path = await downloadToInbox(bot, d.file_id, ext)
  return { kind: 'document', path, file_id: d.file_id, mime: d.mime_type, name: safeName(d.file_name) }
}

async function handleAudio(bot, ctx) {
  const a = ctx.message.audio
  const path = await downloadToInbox(bot, a.file_id, 'mp3')
  const transcript = await transcribe(path)
  return { kind: 'audio', path, file_id: a.file_id, mime: a.mime_type, transcript }
}

async function handleVideo(bot, ctx) {
  const v = ctx.message.video
  const path = await downloadToInbox(bot, v.file_id, 'mp4')
  return { kind: 'video', path, file_id: v.file_id, mime: v.mime_type }
}

module.exports = {
  resizeIfLarge,
  downloadToInbox,
  handlePhoto,
  handleVoice,
  handleDocument,
  handleAudio,
  handleVideo,
  INBOX_DIR,
  IMAGE_MAX_DIM,
}
