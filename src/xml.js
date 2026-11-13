/**
 * A tolerant XML/HTML tree parser.
 *
 * Feeds and article pages are frequently malformed, so this parser never
 * throws on bad markup: it skips what it cannot read, closes mismatched tags,
 * and keeps the text it has already collected. It is intentionally small and
 * has no dependencies, which keeps the plugin installable as a plain bundle.
 */
import { decodeEntities, escapeHtml, stripControl } from './util.js'

const HTML_VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
])
const HTML_RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'plaintext', 'noscript'])
const NAME_START = /[A-Za-z_]/
const NAME_CHAR = /[A-Za-z0-9:_.-]/

/** Local part of a qualified name (`content:encoded` -> `encoded`). */
export function localName(name) {
  const text = String(name)
  const index = text.indexOf(':')
  return (index === -1 ? text : text.slice(index + 1)).toLowerCase()
}

/** Create one element node. */
function element(name, attrs) {
  return { name, local: localName(name), attrs, children: [] }
}

/** Parse the attributes between a tag name and its closing `>`. */
function parseAttributes(source, start, end) {
  const attrs = {}
  let i = start
  while (i < end) {
    while (i < end && /\s/.test(source[i])) i += 1
    if (i >= end) break
    const nameStart = i
    while (i < end && !/[\s=/>]/.test(source[i])) i += 1
    if (i === nameStart) { i += 1; continue }
    const name = source.slice(nameStart, i)
    while (i < end && /\s/.test(source[i])) i += 1
    let value = ''
    if (source[i] === '=') {
      i += 1
      while (i < end && /\s/.test(source[i])) i += 1
      const quote = source[i]
      if (quote === '"' || quote === "'") {
        i += 1
        const valueStart = i
        while (i < end && source[i] !== quote) i += 1
        value = source.slice(valueStart, i)
        i += 1
      } else {
        const valueStart = i
        while (i < end && !/[\s>]/.test(source[i])) i += 1
        value = source.slice(valueStart, i)
      }
    }
    if (!(name in attrs)) attrs[name] = decodeEntities(value)
  }
  return attrs
}

/**
 * Parse markup into a synthetic root whose children are the top-level nodes.
 * @param {string} input - XML or HTML source.
 * @param {{ html?: boolean, maxDepth?: number }} [options] - HTML mode is case-insensitive, honors void and raw-text elements, and tolerates stray `<`.
 * @returns {{ children: Array }} synthetic document root.
 */
export function parseMarkup(input, options = {}) {
  const html = options.html === true
  const maxDepth = options.maxDepth ?? 400
  const source = stripControl(String(input ?? ''))
  const root = { name: '#root', local: '#root', attrs: {}, children: [] }
  const stack = [root]
  let i = 0
  let length = source.length

  const appendText = (raw, decode = true) => {
    if (raw === '') return
    const text = decode ? decodeEntities(raw) : raw
    if (text === '') return
    const parent = stack[stack.length - 1]
    const last = parent.children[parent.children.length - 1]
    if (typeof last === 'string') parent.children[parent.children.length - 1] = last + text
    else parent.children.push(text)
  }

  const closeTo = (name) => {
    const wanted = html ? name.toLowerCase() : name
    for (let index = stack.length - 1; index > 0; index -= 1) {
      const nodeLocal = html ? stack[index].name.toLowerCase() : stack[index].name
      if (nodeLocal === wanted) {
        stack.length = index
        return
      }
    }
  }

  while (i < length) {
    const lt = source.indexOf('<', i)
    if (lt === -1) { appendText(source.slice(i)); break }
    if (lt > i) appendText(source.slice(i, lt))

    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4)
      i = end === -1 ? length : end + 3
      continue
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9)
      const body = end === -1 ? source.slice(lt + 9) : source.slice(lt + 9, end)
      appendText(body, false)
      i = end === -1 ? length : end + 3
      continue
    }
    if (source.startsWith('<?', lt)) {
      const end = source.indexOf('?>', lt + 2)
      i = end === -1 ? length : end + 2
      continue
    }
    if (source.startsWith('<!', lt)) {
      // DOCTYPE or another declaration; an internal subset may contain `>`.
      let depth = 0
      let cursor = lt + 2
      for (; cursor < length; cursor += 1) {
        const char = source[cursor]
        if (char === '[') depth += 1
        else if (char === ']') depth = Math.max(0, depth - 1)
        else if (char === '>' && depth === 0) break
      }
      i = cursor + 1
      continue
    }
    if (source.startsWith('</', lt)) {
      let cursor = lt + 2
      const start = cursor
      while (cursor < length && NAME_CHAR.test(source[cursor])) cursor += 1
      if (cursor === start) { i = cursor + 1; continue }
      closeTo(source.slice(start, cursor))
      const end = source.indexOf('>', cursor)
      i = end === -1 ? length : end + 1
      continue
    }

    // A `<` that does not begin a tag is ordinary text in HTML.
    const next = source[lt + 1]
    if (next === undefined) { appendText('<'); break }
    if (!NAME_START.test(next)) {
      appendText('<')
      i = lt + 1
      continue
    }

    let cursor = lt + 1
    const nameStart = cursor
    while (cursor < length && NAME_CHAR.test(source[cursor])) cursor += 1
    const name = source.slice(nameStart, cursor)
    if (name === '') { appendText('<'); i = lt + 1; continue }

    let quote = ''
    let angle = -1
    for (; cursor < length; cursor += 1) {
      const char = source[cursor]
      if (quote !== '') {
        if (char === quote) quote = ''
        continue
      }
      if (char === '"' || char === "'") { quote = char; continue }
      if (char === '>') { angle = cursor; break }
    }
    if (angle === -1) {
      // Unterminated tag: keep the remainder as text rather than losing it.
      appendText(source.slice(lt))
      break
    }

    const endsWithSlash = source[cursor - 1] === '/'
    const attrs = parseAttributes(source, nameStart + name.length, endsWithSlash ? angle - 1 : angle)
    const node = element(name, attrs)
    if (stack.length < maxDepth) stack[stack.length - 1].children.push(node)

    const lower = name.toLowerCase()
    const isVoid = html && HTML_VOID.has(lower)
    const selfClosing = endsWithSlash || isVoid
    i = angle + 1
    if (selfClosing) continue

    if (html && HTML_RAW_TEXT.has(lower)) {
      const close = new RegExp(`</\\s*${lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*>`, 'i')
      const rest = source.slice(i)
      const match = close.exec(rest)
      const body = match === null ? rest : rest.slice(0, match.index)
      if (body !== '') node.children.push(body)
      i = match === null ? length : i + match.index + match[0].length
      continue
    }

    if (stack.length < maxDepth) stack.push(node)
  }

  return root
}

/** Read an attribute case-insensitively, then by exact name. */
export function attr(node, name) {
  if (node === undefined || node === null || typeof node !== 'object') return undefined
  if (Object.prototype.hasOwnProperty.call(node.attrs, name)) return node.attrs[name]
  const lower = name.toLowerCase()
  for (const key of Object.keys(node.attrs)) {
    if (key.toLowerCase() === lower) return node.attrs[key]
  }
  return undefined
}

/** Direct child elements, optionally filtered by local name. */
export function childElements(node, name = undefined) {
  if (node === undefined || node === null) return []
  const elements = node.children.filter(item => typeof item === 'object' && item !== null)
  if (name === undefined) return elements
  const wanted = name.toLowerCase()
  return elements.filter(item => item.local === wanted)
}

/** First direct child element with a local name. */
export function child(node, name) {
  return childElements(node, name)[0]
}

/** All descendant elements with a local name, breadth-first, bounded. */
export function descendants(node, name, limit = 5000) {
  const wanted = name.toLowerCase()
  const found = []
  const queue = [node]
  for (let index = 0; index < queue.length && found.length < limit; index += 1) {
    const current = queue[index]
    for (const item of current.children) {
      if (typeof item !== 'object' || item === null) continue
      if (item.local === wanted) found.push(item)
      queue.push(item)
    }
  }
  return found
}

/** Concatenated text content of a node and its descendants. */
export function textOf(node) {
  if (node === undefined || node === null) return ''
  if (typeof node === 'string') return node
  let text = ''
  for (const item of node.children) {
    text += typeof item === 'string' ? item : textOf(item)
  }
  return text
}

/** Trimmed text of the first child with a local name. */
export function textOfChild(node, name) {
  const found = child(node, name)
  return found === undefined ? '' : textOf(found).trim()
}

/** Serialize a node tree back to HTML, escaping text. */
export function serialize(node) {
  if (typeof node === 'string') return escapeHtml(node)
  if (node.name === '#root') return node.children.map(serialize).join('')
  const attrs = Object.entries(node.attrs ?? {})
    .map(([key, value]) => ` ${key}="${escapeHtml(value)}"`)
    .join('')
  const inner = node.children.map(serialize).join('')
  return `<${node.name}${attrs}>${inner}</${node.name}>`
}
