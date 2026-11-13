/** Content filters, search scoring, and the explainable recommendation score. */

const REGEX_CACHE = new WeakMap()
const REGEX_TEXT_LIMIT = 2000

/**
 * Conservative safety check for user-supplied filter regular expressions.
 * Rejects constructs that can backtrack catastrophically in a single-threaded
 * host: lookarounds, backreferences, quantified groups, and more than two
 * unbounded quantifiers.
 * @param {string} source - regular expression body.
 * @returns {boolean} whether the expression is safe to evaluate inline.
 */
export function isSafeRegexSource(source) {
  const value = String(source ?? '')
  if (value.length === 0 || value.length > 200) return false
  if (/\(\?/.test(value)) return false
  if (/\\[1-9]/.test(value)) return false
  if (/\([^)]*\)\s*(?:[?*+]|\{\d+,?\d*\})/.test(value)) return false
  let unbounded = 0
  let inClass = false
  for (let i = 0; i < value.length; i += 1) {
    const character = value[i]
    if (character === '\\') { i += 1; continue }
    if (character === '[') { inClass = true; continue }
    if (character === ']') { inClass = false; continue }
    if (inClass) continue
    if (character === '*' || character === '+') unbounded += 1
    else if (character === '{') {
      const close = value.indexOf('}', i)
      if (close !== -1) {
        if (/^\d+,\d*$/.test(value.slice(i + 1, close))) unbounded += 1
        i = close
      }
    }
  }
  return unbounded <= 2
}

/** Compile and cache one filter's regular expression; unsafe rules are disabled. */
function filterRegex(rule) {
  let compiled = REGEX_CACHE.get(rule)
  if (compiled === undefined) {
    try {
      compiled = isSafeRegexSource(rule.value) ? new RegExp(rule.value, 'i') : null
    } catch {
      compiled = null
    }
    REGEX_CACHE.set(rule, compiled)
  }
  return compiled
}

/** Text one filter field reads for an article. */
function filterText(article, field, feedTitle) {
  switch (field) {
    case 'content': return `${article.summaryHtml ?? ''} ${(article.contentHtml ?? '').slice(0, REGEX_TEXT_LIMIT)}`.slice(0, REGEX_TEXT_LIMIT)
    case 'author': return (article.author ?? '').slice(0, REGEX_TEXT_LIMIT)
    case 'feed': return (feedTitle ?? '').slice(0, REGEX_TEXT_LIMIT)
    case 'title':
    default: return (article.title ?? '').slice(0, REGEX_TEXT_LIMIT)
  }
}

/**
 * Evaluate mute and highlight rules for one article.
 * @returns {{ muted: boolean, highlighted: boolean, matched: string[] }}
 */
export function evaluateFilters(article, filters, feedTitle = '') {
  const result = { muted: false, highlighted: false, matched: [] }
  if (!Array.isArray(filters) || filters.length === 0) return result
  for (const rule of filters) {
    if (rule.enabled === false) continue
    const text = filterText(article, rule.field, feedTitle)
    let hit = false
    if (rule.op === 'regex') {
      const expression = filterRegex(rule)
      hit = expression === null ? false : expression.test(text)
    } else {
      hit = text.toLowerCase().includes(String(rule.value ?? '').toLowerCase())
    }
    if (!hit) continue
    result.matched.push(rule.name)
    if (rule.type === 'highlight') result.highlighted = true
    else result.muted = true
  }
  return result
}

/** Split a search term into lowercase tokens. */
export function tokenize(term) {
  return [...new Set(String(term ?? '').toLowerCase().split(/[\s,;|]+/).filter(token => token !== ''))].slice(0, 12)
}

/**
 * Score an article against a text query.
 * @returns {number} zero when any token is absent, so callers can filter on it.
 */
export function searchScore(article, term, feedTitle = '') {
  const tokens = tokenize(term)
  if (tokens.length === 0) return 0
  const title = (article.title ?? '').toLowerCase()
  const tags = (article.tags ?? []).join(' ').toLowerCase()
  const author = (article.author ?? '').toLowerCase()
  const feed = (feedTitle ?? '').toLowerCase()
  const summary = (article.summaryHtml ?? '').toLowerCase()
  const content = (article.contentHtml ?? '').slice(0, 8000).toLowerCase()
  let score = 0
  for (const token of tokens) {
    let tokenScore = 0
    if (title.includes(token)) tokenScore += 10
    if (tags.includes(token)) tokenScore += 6
    if (author.includes(token)) tokenScore += 4
    if (feed.includes(token)) tokenScore += 4
    if (summary.includes(token)) tokenScore += 3
    if (content.includes(token)) tokenScore += 1
    if (tokenScore === 0) return 0
    score += tokenScore
  }
  if (title.includes(String(term).toLowerCase())) score += 8
  return score
}

/** Recency weight with a 72-hour half-life. */
export function recencyWeight(publishedAt, now = Date.now()) {
  const stamp = Date.parse(publishedAt)
  if (!Number.isFinite(stamp)) return 0
  const hours = Math.max(0, (now - stamp) / 3_600_000)
  return Math.exp(-hours / 72 * Math.LN2)
}

/** Highest weight in a sparse weight map, used to normalize to 0..1. */
function normalizeMap(map) {
  let max = 0
  for (const value of Object.values(map ?? {})) max = Math.max(max, Number(value) || 0)
  if (max <= 0) return {}
  const normalized = {}
  for (const [key, value] of Object.entries(map)) normalized[key] = (Number(value) || 0) / max
  return normalized
}

/**
 * Explainable 0..1 relevance used by the "For you" view and the brief.
 * @returns {{ score: number, reasons: string[] }}
 */
export function relevanceOf(article, options = {}) {
  const now = options.now ?? Date.now()
  const feedWeights = options.feedWeights ?? {}
  const tagWeights = options.tagWeights ?? {}
  const normalizedFeeds = normalizeMap(feedWeights)
  const normalizedTags = normalizeMap(tagWeights)
  const reasons = []
  let score = recencyWeight(article.publishedAt, now) * 0.45
  if (recencyWeight(article.publishedAt, now) > 0.5) reasons.push('recent')
  if (!article.read) { score += 0.18; reasons.push('unread') }
  if (article.starred) { score += 0.08; reasons.push('starred') }
  if (article.readLater) { score += 0.05; reasons.push('read later') }
  const feedWeight = normalizedFeeds[article.feedId] ?? 0
  if (feedWeight > 0) { score += feedWeight * 0.16; reasons.push('followed source') }
  let tagBoost = 0
  for (const tag of article.tags ?? []) tagBoost = Math.max(tagBoost, normalizedTags[tag] ?? 0)
  if (tagBoost > 0) { score += tagBoost * 0.12; if (tagBoost > 0.3) reasons.push('matching tag') }
  const length = (article.contentHtml ?? '').length
  if (length > 160) score += 0.03
  if (length > 20_000) score -= 0.03
  return { score: Math.max(0, Math.min(1, score)), reasons: reasons.slice(0, 3) }
}

/**
 * Rank articles for the "For you" view.
 * @returns {Array<{ article: object, score: number, reasons: string[] }>} descending relevance.
 */
export function recommendArticles(articles, options = {}) {
  const limit = options.limit ?? 40
  const pool = articles.filter(article => {
    if (article.read && !article.starred) return false
    return true
  })
  return pool
    .map(article => ({ article, ...relevanceOf(article, options) }))
    .sort((left, right) => right.score - left.score || Date.parse(right.article.publishedAt) - Date.parse(left.article.publishedAt))
    .slice(0, limit)
}

/** Pick the unread articles most worth a short AI brief. */
export function digestCandidates(articles, options = {}) {
  const limit = options.limit ?? 12
  return recommendArticles(articles.filter(article => !article.read || article.starred), options)
    .slice(0, limit)
    .map(entry => entry.article)
}

/** Group articles by ISO day for the digest. */
export function groupByDay(articles) {
  const groups = new Map()
  for (const article of articles) {
    const day = String(article.publishedAt ?? '').slice(0, 10)
    if (!groups.has(day)) groups.set(day, [])
    groups.get(day).push(article)
  }
  return [...groups.entries()].sort((left, right) => right[0].localeCompare(left[0]))
}
