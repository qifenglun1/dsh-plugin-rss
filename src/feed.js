/** RSS 2.0, RSS 1.0 (RDF), Atom 1.0, and JSON Feed normalization. */
import {
  collapseWhitespace, decodeEntities, escapeHtml, hashId, normalizeUrl, resolveUrl, saneDate, truncate,
} from './util.js'
import {
  attr, child, childElements, descendants, parseMarkup, serialize, textOf, textOfChild,
} from './xml.js'
import { htmlToText, looksLikeHtml } from './html.js'

/** Turn plain text into simple paragraph markup. */
function textToHtml(text) {
  const value = String(text ?? '').trim()
  if (value === '') return ''
  if (looksLikeHtml(value)) return value
  return value
    .split(/\n{2,}/)
    .map(paragraph => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

/** Normalize a value to an http(s) URL, rejecting javascript:, data:, and other schemes. */
function httpUrl(value, base = undefined) {
  const normalized = normalizeUrl(value, base)
  if (normalized === '') return ''
  try {
    const url = new URL(normalized)
    return url.protocol === 'http:' || url.protocol === 'https:' ? normalizeUrl(url.toString()) : ''
  } catch {
    return ''
  }
}

/** Read Atom inline XHTML content, preserving its child markup. */
function innerMarkup(node) {
  return node.children
    .map(item => typeof item === 'string' ? escapeHtml(item) : serialize(item))
    .join('')
}

/** Read an RSS/Atom link element's href. */
function linkOf(node, fallbackBase) {
  const direct = attr(node, 'href')
  if (direct !== undefined) return resolveUrl(direct, fallbackBase)
  const text = textOfChild(node, 'link') || collapseWhitespace(textOf(node))
  return resolveUrl(text, fallbackBase)
}

/** Read the first alternate link from an Atom link list, never a self or enclosure link. */
function atomAlternate(entry, baseUrl) {
  const links = childElements(entry, 'link')
  if (links.length === 0) return ''
  const relOf = link => (attr(link, 'rel') ?? '').toLowerCase()
  const alternate = links.find(link => relOf(link) === 'alternate')
  const untyped = links.find(link => attr(link, 'rel') === undefined)
  const other = links.find(link => !['self', 'enclosure', 'replies', 'edit', 'edit-media', 'hub'].includes(relOf(link)))
  const chosen = alternate ?? untyped ?? other
  if (chosen === undefined) return ''
  return httpUrl(attr(chosen, 'href') ?? textOf(chosen), baseUrl)
}

/** Choose an image URL for an item from common enclosures. */
function itemImage(item, baseUrl) {
  const enclosure = child(item, 'enclosure')
  if (enclosure !== undefined) {
    const type = (attr(enclosure, 'type') ?? '').toLowerCase()
    const url = attr(enclosure, 'url')
    if (url !== undefined && (type === '' || type.startsWith('image/'))) return httpUrl(url, baseUrl)
  }
  for (const name of ['thumbnail', 'content']) {
    for (const media of descendants(item, name, 20)) {
      const url = attr(media, 'url')
      if (url === undefined) continue
      const medium = (attr(media, 'medium') ?? '').toLowerCase()
      const type = (attr(media, 'type') ?? '').toLowerCase()
      if (medium === 'image' || type.startsWith('image/') || name === 'thumbnail') return httpUrl(url, baseUrl)
    }
  }
  const html = textOfChild(item, 'encoded') || textOfChild(item, 'description')
  const match = /<img[^>]+src\s*=\s*["']([^"']+)["']/i.exec(html)
  return match === null ? '' : httpUrl(match[1], baseUrl)
}

/** Normalize one parsed item into the stored article shape. */
function normalizeItem(raw, feedUrl) {
  const baseUrl = raw.baseUrl || feedUrl
  const rawTitle = String(raw.title ?? '').trim()
  const title = truncate((looksLikeHtml(rawTitle) ? htmlToText(rawTitle, 500) : collapseWhitespace(decodeEntities(rawTitle))) || '(untitled)', 400)
  const summaryHtml = truncate(raw.summaryHtml ?? '', 20_000)
  const rawContent = raw.contentHtml ?? ''
  const contentHtml = rawContent === '' ? summaryHtml : truncate(rawContent, 400_000)
  const publishedAt = saneDate(raw.publishedAt ?? raw.updatedAt, undefined)
  // Only an absolute http(s) guid may stand in for a missing link; a plain
  // identifier such as "post-1" must not be resolved into a fake article URL.
  const url = httpUrl(raw.url ?? '', baseUrl) || httpUrl(raw.guid ?? '')
  // Include a content fingerprint so items with no guid/link/title are not merged.
  const guid = collapseWhitespace(String(raw.guid ?? ''))
    || url
    || hashId(`${feedUrl}|${title}|${publishedAt ?? ''}|${hashId(summaryHtml, 'sum')}`, 'guid')
  return {
    guid: truncate(guid, 500),
    url: truncate(url, 2000),
    title,
    summaryHtml,
    contentHtml: textToHtml(contentHtml),
    author: collapseWhitespace(raw.author ?? '').slice(0, 200),
    publishedAt: publishedAt ?? '',
    updatedAt: saneDate(raw.updatedAt, publishedAt) ?? '',
    tags: [...new Set((raw.tags ?? []).map(tag => collapseWhitespace(tag).slice(0, 60)).filter(tag => tag !== ''))].slice(0, 12),
    image: truncate(httpUrl(raw.image ?? '', baseUrl), 2000),
    language: collapseWhitespace(raw.language ?? '').slice(0, 40),
  }
}

/** Parse an RSS 2.0 channel. */
function parseRss(root, feedUrl) {
  const rss = child(root, 'rss')
  const channel = child(rss ?? root, 'channel') ?? child(root, 'channel')
  if (channel === undefined) return null
  const language = collapseWhitespace(textOfChild(channel, 'language'))
  const imageNode = child(channel, 'image')
  const siteUrl = httpUrl(textOfChild(channel, 'link'), feedUrl)
  const feedImage = imageNode === undefined ? '' : httpUrl(textOfChild(imageNode, 'url'), feedUrl)
  const items = childElements(channel, 'item').map((item) => {
    const tags = childElements(item, 'category').map(category => textOf(category))
    const author = textOfChild(item, 'creator') || textOfChild(item, 'author')
    const summaryHtml = textOfChild(item, 'description')
    const encoded = textOfChild(item, 'encoded')
    const mediaContent = descendants(item, 'content', 5).find(node => attr(node, 'url') !== undefined)
    const contentHtml = encoded || (mediaContent !== undefined ? '' : textOfChild(item, 'content')) || summaryHtml
    return normalizeItem({
      baseUrl: siteUrl || feedUrl,
      guid: textOfChild(item, 'guid'),
      url: textOfChild(item, 'link') || attr(child(item, 'link'), 'href'),
      title: textOfChild(item, 'title'),
      summaryHtml,
      contentHtml,
      author,
      publishedAt: textOfChild(item, 'pubDate') || textOfChild(item, 'date'),
      updatedAt: textOfChild(item, 'updated'),
      tags,
      image: itemImage(item, siteUrl || feedUrl),
      language,
    }, feedUrl)
  })
  return {
    title: collapseWhitespace(textOfChild(channel, 'title')) || feedUrl,
    siteUrl,
    description: collapseWhitespace(htmlToText(textOfChild(channel, 'description'), 1000)),
    language,
    image: feedImage,
    items,
  }
}

/** Parse an RSS 1.0 (RDF) document. */
function parseRdf(root, feedUrl) {
  const rdf = child(root, 'RDF') ?? root
  const channel = child(rdf, 'channel')
  if (channel === undefined) return null
  const siteUrl = httpUrl(textOfChild(channel, 'link'), feedUrl)
  const language = collapseWhitespace(textOfChild(channel, 'language'))
  const items = descendants(rdf, 'item', 2000).map((item) => normalizeItem({
    baseUrl: siteUrl || feedUrl,
    guid: textOfChild(item, 'identifier') || attr(item, 'about'),
    url: textOfChild(item, 'link'),
    title: textOfChild(item, 'title'),
    summaryHtml: textOfChild(item, 'description'),
    contentHtml: textOfChild(item, 'encoded') || textOfChild(item, 'description'),
    author: textOfChild(item, 'creator'),
    publishedAt: textOfChild(item, 'date'),
    tags: childElements(item, 'subject').map(subject => textOf(subject)),
    language,
  }, feedUrl))
  return {
    title: collapseWhitespace(textOfChild(channel, 'title')) || feedUrl,
    siteUrl,
    description: collapseWhitespace(htmlToText(textOfChild(channel, 'description'), 1000)),
    language,
    image: '',
    items,
  }
}

/** Parse an Atom 1.0 feed. */
function parseAtom(root, feedUrl) {
  const feed = child(root, 'feed') ?? root
  const siteUrl = atomAlternate(feed, feedUrl)
  const language = attr(feed, 'xml:lang') ?? attr(feed, 'lang') ?? ''
  const logo = textOfChild(feed, 'logo') || textOfChild(feed, 'icon')
  const items = childElements(feed, 'entry').map((entry) => {
    const contentNode = child(entry, 'content')
    const summaryNode = child(entry, 'summary')
    const contentHtml = contentNode === undefined
      ? ''
      : (attr(contentNode, 'src') !== undefined
        ? ''
        : (attr(contentNode, 'type') === 'xhtml' ? innerMarkup(contentNode) : textOf(contentNode)))
    const summaryHtml = summaryNode === undefined ? '' : textOf(summaryNode)
    const authorNode = child(entry, 'author')
    const categories = childElements(entry, 'category')
    return normalizeItem({
      baseUrl: siteUrl || feedUrl,
      guid: textOfChild(entry, 'id'),
      url: atomAlternate(entry, siteUrl || feedUrl),
      title: textOfChild(entry, 'title'),
      summaryHtml,
      contentHtml: contentHtml || summaryHtml,
      author: authorNode === undefined ? '' : textOfChild(authorNode, 'name'),
      publishedAt: textOfChild(entry, 'published') || textOfChild(entry, 'updated'),
      updatedAt: textOfChild(entry, 'updated'),
      tags: categories.map(category => attr(category, 'label') ?? attr(category, 'term') ?? textOf(category)),
      image: itemImage(entry, siteUrl || feedUrl),
      language,
    }, feedUrl)
  })
  return {
    title: collapseWhitespace(htmlToText(textOfChild(feed, 'title'), 300)) || feedUrl,
    siteUrl,
    description: collapseWhitespace(htmlToText(textOfChild(feed, 'subtitle'), 1000)),
    language,
    image: httpUrl(logo, feedUrl),
    items,
  }
}

/** Parse a JSON Feed 1.x document. */
function parseJsonFeed(source, feedUrl) {
  let document
  try { document = JSON.parse(source) } catch { return null }
  if (document === null || typeof document !== 'object' || typeof document.version !== 'string'
    || !document.version.includes('jsonfeed')) return null
  const sourceItems = Array.isArray(document.items) ? document.items : []
  const items = sourceItems
    .filter(item => item !== null && typeof item === 'object' && !Array.isArray(item))
    .slice(0, 500)
    .map(item => normalizeItem({
    baseUrl: document.home_page_url ?? feedUrl,
    guid: item.id,
    url: item.url ?? item.external_url,
    title: item.title,
    summaryHtml: item.summary ?? '',
    contentHtml: item.content_html ?? item.content_text ?? '',
    author: item.author?.name ?? (Array.isArray(item.authors) ? item.authors[0]?.name : ''),
    publishedAt: item.date_published,
    updatedAt: item.date_modified,
    tags: Array.isArray(item.tags) ? item.tags : [],
    image: item.image ?? '',
  }, feedUrl))
  return {
    title: collapseWhitespace(document.title ?? '') || feedUrl,
    siteUrl: httpUrl(document.home_page_url ?? '', feedUrl),
    description: collapseWhitespace(document.description ?? ''),
    language: collapseWhitespace(document.language ?? '').slice(0, 40),
    image: httpUrl(document.icon ?? document.favicon ?? '', feedUrl),
    items,
  }
}

/**
 * Parse one subscription document.
 * @param {string} source - response body.
 * @param {string} feedUrl - URL the body came from.
 * @returns {{ title: string, siteUrl: string, description: string, language: string, image: string, items: Array }}
 * @throws {Error} when the document is not a supported feed.
 */
export function parseFeed(source, feedUrl) {
  const text = String(source ?? '').replace(/^\uFEFF/, '')
  const trimmed = text.trim()
  if (trimmed === '') throw new Error('The feed response was empty.')
  if (trimmed.startsWith('{')) {
    const jsonFeed = parseJsonFeed(trimmed, feedUrl)
    if (jsonFeed !== null) return dedupeItems(jsonFeed)
  }
  const root = parseMarkup(trimmed, { html: false })
  const result = child(root, 'feed') !== undefined
    ? parseAtom(root, feedUrl)
    : child(root, 'rss') !== undefined
      ? parseRss(root, feedUrl)
      : child(root, 'RDF') !== undefined || child(root, 'rdf') !== undefined
        ? parseRdf(root, feedUrl)
        : null
  if (result === null) {
    throw new Error('The response is not a supported RSS, Atom, RDF, or JSON Feed document.')
  }
  return dedupeItems(result)
}

/** Remove duplicate guids and keep the newest copy. */
function dedupeItems(feed) {
  const seen = new Map()
  for (const item of feed.items) {
    const key = item.guid || item.url || item.title
    const existing = seen.get(key)
    if (existing === undefined || Date.parse(item.updatedAt) >= Date.parse(existing.updatedAt)) seen.set(key, item)
  }
  return { ...feed, items: [...seen.values()] }
}

/** Validate that a URL can serve as a subscription. */
export function isValidFeedUrl(value) {
  try {
    const url = new URL(String(value ?? '').trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** Decode a feed body according to its declared charset. */
export function decodeBody(buffer, contentType = '') {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buffer.subarray(2))
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buffer.subarray(2))
  }
  const headerCharset = /charset=([^;]+)/i.exec(contentType)?.[1]?.trim().replace(/["']/g, '')
  if (headerCharset !== undefined && headerCharset !== '') {
    try { return new TextDecoder(headerCharset).decode(buffer) } catch { /* fall through */ }
  }
  const head = new TextDecoder('latin1').decode(buffer.subarray(0, 4096))
  const metaCharset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1]
    ?? /<\?xml[^>]+encoding=["']([\w-]+)/i.exec(head)?.[1]
  if (metaCharset !== undefined && metaCharset !== '') {
    try { return new TextDecoder(metaCharset).decode(buffer) } catch { /* fall through */ }
  }
  return new TextDecoder('utf-8').decode(buffer)
}

/** Strip the XML prolog for display or debugging. */
export function feedErrorHint(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|timed out/i.test(message)) return 'The feed could not be reached.'
  if (/not a supported|unsupported|empty/i.test(message)) return message
  if (/certificate|TLS|SSL/i.test(message)) return 'The feed has an invalid TLS certificate.'
  return truncate(message, 300)
}

/** Read the feed title from an already fetched body (used by validation). */
export function readFeedTitle(source, feedUrl) {
  try { return parseFeed(source, feedUrl).title } catch { return decodeEntities(feedUrl) }
}

/** Detected feed format label for diagnostics. */
export function feedFormat(source) {
  const head = String(source ?? '').slice(0, 2000).toLowerCase()
  if (head.trimStart().startsWith('{')) return 'jsonfeed'
  if (head.includes('<feed')) return 'atom'
  if (head.includes('<rdf')) return 'rdf'
  if (head.includes('<rss')) return 'rss'
  return 'unknown'
}
