/** Small dependency-free helpers shared by the host half. */
import { createHash } from 'node:crypto'

/** Stable short hash used for record ids. */
export function hashId(input, prefix = 'id') {
  const digest = createHash('sha1').update(String(input)).digest('hex').slice(0, 16)
  return `${prefix}-${digest}`
}

/** ISO timestamp for "now". */
export function nowIso() {
  return new Date().toISOString()
}

/** Clamp a number into an inclusive range. */
export function clamp(value, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return min
  return Math.min(max, Math.max(min, number))
}

/** Truncate text without splitting a surrogate pair. */
export function truncate(text, max) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  let end = Math.max(0, max)
  const code = value.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return value.slice(0, end)
}

/** Collapse whitespace runs into one space. */
export function collapseWhitespace(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/** Remove control and bidirectional-override characters that corrupt UI text. */
export function stripControl(text) {
  return String(text ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0085\u009B\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
}

const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', rsquo: '\u2019',
  lsquo: '\u2018', ldquo: '\u201c', rdquo: '\u201d', copy: '\u00a9',
  reg: '\u00ae', trade: '\u2122', middot: '\u00b7', bull: '\u2022',
}

/** Decode the named and numeric entities feeds and article HTML commonly use. */
export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return match
      try { return String.fromCodePoint(code) } catch { return match }
    }
    const named = HTML_ENTITIES[body.toLowerCase()]
    return named ?? match
  })
}

/** Escape text for insertion into HTML. */
export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Parse the date formats RSS, Atom, and JSON Feed produce. */
export function parseDate(value, fallback = undefined) {
  if (value === undefined || value === null || value === '') return fallback
  const text = String(value).trim()
  const stamp = Date.parse(text)
  if (Number.isFinite(stamp)) return new Date(stamp).toISOString()
  // Some feeds omit the timezone; treat those as UTC rather than local time.
  const relaxed = Date.parse(`${text} UTC`)
  if (Number.isFinite(relaxed)) return new Date(relaxed).toISOString()
  return fallback
}

/** Keep a published date that is not implausibly far in the future. */
export function saneDate(value, fallback = nowIso()) {
  const parsed = parseDate(value, undefined)
  if (parsed === undefined) return fallback
  const stamp = Date.parse(parsed)
  if (stamp > Date.now() + 7 * 86_400_000) return fallback
  return parsed
}

/** Normalize a URL for deduplication without throwing on invalid input. */
export function normalizeUrl(value, base = undefined) {
  const raw = String(value ?? '').trim()
  if (raw === '') return ''
  try {
    const url = base === undefined ? new URL(raw) : new URL(raw, base)
    url.hash = ''
    return url.toString()
  } catch {
    return ''
  }
}

/** Pick the first defined value. */
export function firstDefined(...values) {
  for (const value of values) if (value !== undefined && value !== null && value !== '') return value
  return undefined
}

/** Resolve a maybe-relative URL against a base. */
export function resolveUrl(value, base) {
  const normalized = normalizeUrl(value, base)
  return normalized === '' ? '' : normalized
}

/** Convert an arbitrary value into a JSON-safe copy. */
export function jsonSafe(value) {
  if (value === undefined) return null
  try { return JSON.parse(JSON.stringify(value)) } catch { return null }
}

/** Run `work` with a timeout, rejecting with a clear message. */
export async function withTimeout(work, ms, label = 'operation') {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`${label} timed out after ${ms} ms`)), ms)
  timer.unref?.()
  try {
    return await work(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

/** Yield to the event loop so long refreshes do not starve the host. */
export function yieldToLoop() {
  return new Promise(resolve => setImmediate(resolve))
}
