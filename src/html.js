/** HTML sanitization, text conversion, and readable-article extraction. */
import {
  collapseWhitespace, escapeHtml, resolveUrl, stripControl, truncate,
} from './util.js'
import { attr, childElements, parseMarkup, textOf } from './xml.js'

const ALLOWED = new Set([
  'a', 'abbr', 'article', 'aside', 'b', 'blockquote', 'br', 'caption', 'cite', 'code',
  'col', 'colgroup', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 'figcaption',
  'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li',
  'main', 'mark', 'ol', 'p', 'pre', 'q', 's', 'section', 'small', 'span', 'strong',
  'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
])

const DROP_CONTENT = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select',
  'option', 'textarea', 'svg', 'math', 'video', 'audio', 'canvas', 'template', 'noscript',
  'head', 'title', 'meta', 'link', 'base', 'frame', 'frameset', 'applet',
])

const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'dd', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tr', 'td', 'th', 'ul',
])

const SAFE_SCHEME = /^(?:https?:|mailto:|tel:)/i

/** Resolve a URL that may be relative, keeping only safe schemes. */
function safeUrl(value, baseUrl, allowDataImage = false) {
  const raw = String(value ?? '').trim()
  if (raw === '') return ''
  if (allowDataImage && /^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(raw)) return raw
  const resolved = resolveUrl(raw, baseUrl)
  if (resolved === '') return ''
  if (!SAFE_SCHEME.test(resolved)) return ''
  return resolved
}

/** Copy the attributes an allowed element may keep. */
function sanitizedAttributes(node, tag, baseUrl) {
  const attrs = []
  const put = (name, value) => {
    if (value === undefined || value === null || value === '') return
    attrs.push(` ${name}="${escapeHtml(value)}"`)
  }
  if (tag === 'a') {
    put('href', safeUrl(attr(node, 'href'), baseUrl))
    put('title', attr(node, 'title'))
    attrs.push(' target="_blank" rel="noopener noreferrer nofollow"')
  } else if (tag === 'img') {
    const source = safeUrl(attr(node, 'src'), baseUrl, true)
    if (source === '') return attrs
    put('src', source)
    put('alt', attr(node, 'alt'))
    put('title', attr(node, 'title'))
    put('width', attr(node, 'width'))
    put('height', attr(node, 'height'))
    attrs.push(' loading="lazy" referrerpolicy="no-referrer" decoding="async"')
  } else if (tag === 'td' || tag === 'th') {
    put('colspan', attr(node, 'colspan'))
    put('rowspan', attr(node, 'rowspan'))
  }
  return attrs
}

/**
 * Render untrusted article HTML as a safe subset. Unknown elements are
 * unwrapped so their text survives; dangerous elements lose their content.
 */
export function sanitizeHtml(input, baseUrl = '', limit = 400_000) {
  const root = parseMarkup(input, { html: true })
  const render = (node) => {
    if (typeof node === 'string') return escapeHtml(node)
    const tag = node.local
    if (DROP_CONTENT.has(tag)) return ''
    const inner = node.children.map(render).join('')
    if (!ALLOWED.has(tag)) return inner
    const attrs = sanitizedAttributes(node, tag, baseUrl)
    if (tag === 'br' || tag === 'hr' || tag === 'img') return `<${tag}${attrs.join('')}>`
    return `<${tag}${attrs.join('')}>${inner}</${tag}>`
  }
  const output = root.children.map(render).join('')
  return truncate(output, limit)
}

/** Convert untrusted HTML into readable plain text. */
export function htmlToText(input, limit = 400_000) {
  const root = parseMarkup(input, { html: true })
  const parts = []
  const walk = (node) => {
    if (typeof node === 'string') { parts.push(node); return }
    const tag = node.local
    if (DROP_CONTENT.has(tag)) return
    if (tag === 'br') { parts.push('\n'); return }
    if (tag === 'hr') { parts.push('\n\n'); return }
    const block = BLOCK.has(tag)
    if (block) parts.push('\n')
    if (tag === 'li') parts.push('• ')
    if (tag === 'img') {
      const alt = attr(node, 'alt')
      if (alt !== undefined && alt.trim() !== '') parts.push(`[${alt.trim()}]`)
      return
    }
    for (const child of node.children) walk(child)
    if (block) parts.push('\n')
  }
  for (const node of root.children) walk(node)
  const text = parts.join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
  return truncate(text, limit)
}

/** Whether a string looks like HTML rather than plain text. */
export function looksLikeHtml(value) {
  return /<(?:p|div|br|span|img|a|ul|ol|li|h[1-6]|table|figure|blockquote)\b/i.test(String(value ?? ''))
}

/** Read the page's first http(s) <base href>, resolved against the page URL. */
function pageBaseUrl(root, url) {
  const stack = [...root.children]
  let visited = 0
  while (stack.length > 0 && visited < 5000) {
    visited += 1
    const node = stack.pop()
    if (typeof node !== 'object' || node === null) continue
    if (node.local === 'base') {
      const href = attr(node, 'href')
      const resolved = href === undefined ? '' : resolveUrl(href, url)
      if (/^https?:\/\//i.test(resolved)) return resolved
    }
    for (const child of node.children) stack.push(child)
  }
  return ''
}

/** Collect every meta tag's content keyed by property/name. */
function metaMap(root) {
  const map = new Map()
  const stack = [...root.children]
  let visited = 0
  while (stack.length > 0 && visited < 30_000) {
    visited += 1
    const node = stack.pop()
    if (typeof node !== 'object' || node === null) continue
    if (node.local === 'meta') {
      const key = (attr(node, 'property') ?? attr(node, 'name') ?? '').toLowerCase()
      const content = attr(node, 'content')
      if (key !== '' && content !== undefined && content !== '' && !map.has(key)) map.set(key, content)
    }
    for (const child of node.children) stack.push(child)
  }
  return map
}

/** Score one candidate container for readable extraction. */
function scoreCandidate(node, baseUrl) {
  const text = textOf(node)
  const length = text.trim().length
  if (length < 120) return -Infinity
  const links = []
  const stack = [...node.children]
  let visited = 0
  while (stack.length > 0 && visited < 4000) {
    visited += 1
    const item = stack.pop()
    if (typeof item !== 'object' || item === null) continue
    if (item.local === 'a') links.push(textOf(item).length)
    for (const child of item.children) stack.push(child)
  }
  const linkLength = links.reduce((sum, value) => sum + value, 0)
  const density = length === 0 ? 0 : Math.min(1, linkLength / length)
  const punctuation = (text.match(/[.!?。！？,，;；:：]/g) ?? []).length
  const paragraphs = childElements(node, 'p').length
  const hint = `${attr(node, 'class') ?? ''} ${attr(node, 'id') ?? ''}`.toLowerCase()
  let score = Math.min(length, 4000) + punctuation * 6 + paragraphs * 20
  if (node.local === 'article' || node.local === 'main') score += 220
  if (/(article|content|entry|post|story|markdown|body|prose)/.test(hint)) score += 160
  if (/(comment|footer|header|nav|menu|sidebar|share|related|promo|advert|banner|cookie|subscribe)/.test(hint)) score -= 320
  score *= Math.max(0.05, 1 - density * 1.6)
  if (baseUrl === '' && length > 20_000) score -= 200
  return score
}

/** Choose the densest readable container in a parsed page. */
function bestContainer(root, baseUrl) {
  let best = null
  let bestScore = -Infinity
  const stack = [...root.children].map(node => ({ node, depth: 0 }))
  let visited = 0
  while (stack.length > 0 && visited < 30_000) {
    const { node, depth } = stack.pop()
    visited += 1
    if (typeof node !== 'object' || node === null) continue
    if (DROP_CONTENT.has(node.local)) continue
    if (depth <= 60) {
      for (const child of node.children) {
        if (typeof child === 'object' && child !== null) stack.push({ node: child, depth: depth + 1 })
      }
    }
    const score = scoreCandidate(node, baseUrl)
    if (score > bestScore) { bestScore = score; best = node }
  }
  return best
}

/** Find the page title from common metadata. */
function pageTitle(root, metas) {
  const candidates = [
    metas.get('og:title'), metas.get('twitter:title'), metas.get('title'),
  ]
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate.trim() !== '') return collapseWhitespace(candidate)
  }
  const stack = [...root.children]
  let visited = 0
  while (stack.length > 0 && visited < 5000) {
    visited += 1
    const node = stack.pop()
    if (typeof node !== 'object' || node === null) continue
    if (node.local === 'title') {
      const text = collapseWhitespace(textOf(node))
      if (text !== '') return text
    }
    if (node.local === 'h1') {
      const text = collapseWhitespace(textOf(node))
      if (text.length > 3) return text
    }
    for (const child of node.children) stack.push(child)
  }
  return ''
}

/** Find an author byline from common metadata and microformats. */
function pageByline(root, metas) {
  const direct = metas.get('author') ?? metas.get('article:author') ?? metas.get('parsely-author')
  if (direct !== undefined && direct.trim() !== '') return collapseWhitespace(direct)
  const stack = [...root.children]
  let visited = 0
  while (stack.length > 0 && visited < 8000) {
    visited += 1
    const node = stack.pop()
    if (typeof node !== 'object' || node === null) continue
    if (node.local === 'a' || node.local === 'span' || node.local === 'div') {
      const hint = `${attr(node, 'class') ?? ''} ${attr(node, 'rel') ?? ''}`.toLowerCase()
      if (/author|byline/.test(hint)) {
        const text = collapseWhitespace(textOf(node))
        if (text.length > 1 && text.length < 120) return text
      }
    }
    for (const child of node.children) stack.push(child)
  }
  return ''
}

/** Find a published timestamp in metadata or the first `<time datetime>`. */
function pagePublishedAt(root, metas) {
  const direct = metas.get('article:published_time') ?? metas.get('og:article:published_time')
    ?? metas.get('datepublished') ?? metas.get('date')
  if (direct !== undefined && direct.trim() !== '') return direct.trim()
  const stack = [...root.children]
  let visited = 0
  while (stack.length > 0 && visited < 8000) {
    visited += 1
    const node = stack.pop()
    if (typeof node !== 'object' || node === null) continue
    if (node.local === 'time') {
      const stamp = attr(node, 'datetime')
      if (stamp !== undefined && stamp.trim() !== '') return stamp.trim()
    }
    for (const child of node.children) stack.push(child)
  }
  return ''
}

/**
 * Extract a readable article from a full page.
 * @param {string} pageHtml - original page markup.
 * @param {string} url - page URL used to resolve relative links.
 * @returns {{ title: string, byline: string, publishedAt: string, image: string, siteName: string, contentHtml: string, contentText: string }}
 */
export function extractArticle(pageHtml, url) {
  const root = parseMarkup(pageHtml, { html: true })
  const metas = metaMap(root)
  const baseUrl = pageBaseUrl(root, url) || url
  const container = bestContainer(root, baseUrl) ?? root
  const rawHtml = container === root
    ? root.children.map(node => typeof node === 'string' ? escapeHtml(node) : serializeNode(node)).join('')
    : container.children.map(node => typeof node === 'string' ? escapeHtml(node) : serializeNode(node)).join('')
  let contentHtml = sanitizeHtml(rawHtml, baseUrl)
  let contentText = htmlToText(contentHtml)
  if (contentText.length < 200) {
    const bodyText = htmlToText(pageHtml)
    if (bodyText.length > contentText.length) {
      contentText = truncate(bodyText, 200_000)
      contentHtml = `<p>${escapeHtml(contentText).replace(/\n{2,}/g, '</p><p>')}</p>`
    }
  }
  const image = safeUrl(metas.get('og:image') ?? metas.get('twitter:image') ?? '', baseUrl)
  return {
    title: pageTitle(root, metas),
    byline: pageByline(root, metas),
    publishedAt: pagePublishedAt(root, metas),
    image,
    siteName: collapseWhitespace(metas.get('og:site_name') ?? ''),
    contentHtml,
    contentText,
  }
}

/** Serialize one raw element for the readability fallback. */
function serializeNode(node) {
  const attrs = Object.entries(node.attrs ?? {})
    .filter(([key]) => /^[A-Za-z_:][-A-Za-z0-9_:.]*$/.test(key))
    .map(([key, value]) => ` ${key}="${escapeHtml(value)}"`)
    .join('')
  const inner = node.children.map(child => typeof child === 'string' ? escapeHtml(child) : serializeNode(child)).join('')
  return `<${node.name}${attrs}>${inner}</${node.name}>`
}

/** Build a short plain-text preview for list rows. */
export function previewText(html, max = 260) {
  return truncate(htmlToText(html, 4000), max)
}
