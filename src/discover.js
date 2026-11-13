/** Topic-based feed discovery: interest inference, a curated catalog, and candidate merging. */
import { collapseWhitespace, normalizeUrl } from './util.js'
import { isValidFeedUrl } from './feed.js'

/** How many inferred topics the client starts with. */
export const MAX_TOPICS = 8

/**
 * Labels that feeds use as navigation or section categories. They are poor
 * discovery topics and would otherwise crowd out specific subjects.
 */
const GENERIC_TOPICS = new Set([
  'news', 'tech', 'technology', 'featured', 'latest', 'updates', 'update',
  'article', 'articles', 'blog', 'blogs', 'general', 'misc', 'headlines',
  'top stories', 'top news', 'breaking news', 'world news', 'company news',
  'news & insights', 'news and insights', 'reviews', 'deals',
  '新闻', '资讯', '科技', '推荐', '最新', '热门', '头条', '要闻', '综合', '快讯',
])

/** Whether a label is a generic feed section instead of a real topic. */
function isGenericTopic(label) {
  return GENERIC_TOPICS.has(label.toLowerCase())
}

/** A hand-curated directory of stable public feeds, grouped by broad topic. */
export const FEED_CATALOG = Object.freeze([
  // AI and research
  { title: 'OpenAI News', url: 'https://openai.com/news/rss.xml', siteUrl: 'https://openai.com', description: 'Product and research announcements from OpenAI.', category: 'AI', topics: ['ai', 'machine learning', 'llm', 'research'] },
  { title: 'Google DeepMind', url: 'https://deepmind.google/blog/rss.xml', siteUrl: 'https://deepmind.google', description: 'Research posts from Google DeepMind.', category: 'AI', topics: ['ai', 'machine learning', 'research'] },
  { title: 'Hugging Face Blog', url: 'https://huggingface.co/blog/feed.xml', siteUrl: 'https://huggingface.co', description: 'Open models, datasets, and machine-learning engineering.', category: 'AI', topics: ['ai', 'machine learning', 'open source', 'llm'] },
  { title: 'Google Research Blog', url: 'https://research.google/blog/rss/', siteUrl: 'https://research.google', description: 'Research across AI, systems, and the sciences.', category: 'AI', topics: ['ai', 'research', 'machine learning', 'science'] },
  { title: 'MIT Technology Review', url: 'https://www.technologyreview.com/feed/', siteUrl: 'https://www.technologyreview.com', description: 'Technology journalism with a research focus.', category: 'Technology', topics: ['technology', 'ai', 'science', 'business'] },
  { title: 'Simon Willison', url: 'https://simonwillison.net/atom/everything/', siteUrl: 'https://simonwillison.net', description: 'Practical notes on LLMs, Python, and data.', category: 'AI', topics: ['ai', 'llm', 'programming', 'data'] },
  { title: 'LessWrong', url: 'https://www.lesswrong.com/feed.xml', siteUrl: 'https://www.lesswrong.com', description: 'Essays on AI, rationality, and philosophy.', category: 'AI', topics: ['ai', 'rationality', 'philosophy'] },

  // Programming and open source
  { title: 'Rust Blog', url: 'https://blog.rust-lang.org/feed.xml', siteUrl: 'https://blog.rust-lang.org', description: 'Official Rust language announcements.', category: 'Technology', topics: ['programming', 'rust', 'open source', 'systems'] },
  { title: 'The Go Blog', url: 'https://go.dev/blog/feed.atom', siteUrl: 'https://go.dev/blog', description: 'Official Go language articles and releases.', category: 'Technology', topics: ['programming', 'go', 'open source', 'backend'] },
  { title: 'Node.js Blog', url: 'https://nodejs.org/en/feed/blog.xml', siteUrl: 'https://nodejs.org', description: 'Node.js releases and ecosystem news.', category: 'Technology', topics: ['programming', 'javascript', 'node', 'backend'] },
  { title: 'Python Insider', url: 'https://blog.python.org/feeds/posts/default?alt=rss', siteUrl: 'https://blog.python.org', description: 'The official Python core development blog.', category: 'Technology', topics: ['programming', 'python', 'open source'] },
  { title: 'React Blog', url: 'https://react.dev/rss.xml', siteUrl: 'https://react.dev', description: 'Official React release notes and guidance.', category: 'Technology', topics: ['programming', 'javascript', 'react', 'frontend'] },
  { title: 'TypeScript Blog', url: 'https://devblogs.microsoft.com/typescript/feed/', siteUrl: 'https://devblogs.microsoft.com/typescript', description: 'TypeScript releases and language design.', category: 'Technology', topics: ['programming', 'typescript', 'javascript'] },
  { title: 'JetBrains Blog', url: 'https://blog.jetbrains.com/feed/', siteUrl: 'https://blog.jetbrains.com', description: 'Developer tools, IDEs, and language news.', category: 'Technology', topics: ['programming', 'tools', 'software'] },
  { title: 'GitHub Blog', url: 'https://github.blog/feed/', siteUrl: 'https://github.blog', description: 'Product, open-source, and developer ecosystem news.', category: 'Technology', topics: ['programming', 'open source', 'github', 'software'] },
  { title: 'LWN.net', url: 'https://lwn.net/headlines/rss', siteUrl: 'https://lwn.net', description: 'In-depth Linux and free-software reporting.', category: 'Technology', topics: ['linux', 'open source', 'programming', 'systems'] },
  { title: 'Julia Evans', url: 'https://jvns.ca/atom.xml', siteUrl: 'https://jvns.ca', description: 'Approachable writing about debugging and systems.', category: 'Technology', topics: ['programming', 'debugging', 'systems', 'linux'] },

  // Web and design
  { title: 'CSS-Tricks', url: 'https://css-tricks.com/feed/', siteUrl: 'https://css-tricks.com', description: 'Practical CSS, front-end, and web-platform articles.', category: 'Design', topics: ['design', 'css', 'frontend', 'web'] },
  { title: 'Smashing Magazine', url: 'https://www.smashingmagazine.com/feed/', siteUrl: 'https://www.smashingmagazine.com', description: 'Web design, UX, and front-end craft.', category: 'Design', topics: ['design', 'ux', 'frontend', 'web'] },
  { title: 'A List Apart', url: 'https://alistapart.com/main/feed/', siteUrl: 'https://alistapart.com', description: 'Web standards, design, and content strategy.', category: 'Design', topics: ['design', 'web', 'ux', 'accessibility'] },
  { title: 'web.dev', url: 'https://web.dev/feed.xml', siteUrl: 'https://web.dev', description: 'Modern web development, performance, and accessibility.', category: 'Design', topics: ['web', 'frontend', 'performance', 'accessibility'] },
  { title: 'Figma Blog', url: 'https://www.figma.com/blog/feed/atom.xml', siteUrl: 'https://www.figma.com/blog', description: 'Product design, collaboration, and design systems.', category: 'Design', topics: ['design', 'product', 'ux', 'tools'] },
  { title: 'Product Talk', url: 'https://www.producttalk.org/feed/', siteUrl: 'https://www.producttalk.org', description: 'Discovery, product management, and customer research.', category: 'Business', topics: ['product', 'design', 'business', 'ux'] },

  // Security
  { title: 'Krebs on Security', url: 'https://krebsonsecurity.com/feed/', siteUrl: 'https://krebsonsecurity.com', description: 'Investigative security reporting.', category: 'Technology', topics: ['security', 'privacy', 'cybercrime'] },
  { title: 'Schneier on Security', url: 'https://www.schneier.com/feed/atom/', siteUrl: 'https://www.schneier.com', description: 'Security, cryptography, and privacy commentary.', category: 'Technology', topics: ['security', 'privacy', 'cryptography'] },
  { title: 'Cloudflare Blog', url: 'https://blog.cloudflare.com/rss/', siteUrl: 'https://blog.cloudflare.com', description: 'Networking, security, and internet infrastructure.', category: 'Technology', topics: ['security', 'networking', 'infrastructure', 'cloud'] },

  // Engineering and infrastructure
  { title: 'Meta Engineering', url: 'https://engineering.fb.com/feed/', siteUrl: 'https://engineering.fb.com', description: 'Large-scale engineering, AI, and infrastructure.', category: 'Technology', topics: ['engineering', 'infrastructure', 'ai', 'programming'] },
  { title: 'Netflix Technology Blog', url: 'https://netflixtechblog.com/feed', siteUrl: 'https://netflixtechblog.com', description: 'Streaming infrastructure, data, and reliability.', category: 'Technology', topics: ['engineering', 'data', 'infrastructure', 'distributed systems'] },

  // Technology news
  { title: 'Hacker News', url: 'https://hnrss.org/frontpage', siteUrl: 'https://news.ycombinator.com', description: 'The front page of Hacker News.', category: 'Technology', topics: ['technology', 'startups', 'programming', 'news'] },
  { title: 'The Verge', url: 'https://www.theverge.com/rss/index.xml', siteUrl: 'https://www.theverge.com', description: 'Consumer technology, products, and culture.', category: 'Technology', topics: ['technology', 'design', 'gadgets', 'news'] },
  { title: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index', siteUrl: 'https://arstechnica.com', description: 'Technology, science, and policy reporting.', category: 'Technology', topics: ['technology', 'science', 'security', 'policy'] },
  { title: 'TechCrunch', url: 'https://techcrunch.com/feed/', siteUrl: 'https://techcrunch.com', description: 'Startups, funding, and technology business.', category: 'Business', topics: ['startups', 'business', 'technology', 'venture capital'] },
  { title: 'Wired', url: 'https://www.wired.com/feed/rss', siteUrl: 'https://www.wired.com', description: 'Technology, science, and culture.', category: 'Technology', topics: ['technology', 'science', 'culture'] },
  { title: '少数派', url: 'https://sspai.com/feed', siteUrl: 'https://sspai.com', description: '数字生活、效率工具与产品体验。', category: 'Technology', topics: ['technology', 'productivity', 'design', 'tools'] },

  // Science and ideas
  { title: 'Nature', url: 'https://www.nature.com/nature.rss', siteUrl: 'https://www.nature.com', description: 'Research highlights from Nature.', category: 'Science', topics: ['science', 'research', 'biology', 'physics'] },
  { title: 'Quanta Magazine', url: 'https://www.quantamagazine.org/feed/', siteUrl: 'https://www.quantamagazine.org', description: 'Mathematics, physics, biology, and computer science.', category: 'Science', topics: ['science', 'math', 'physics', 'biology'] },
  { title: 'NASA', url: 'https://www.nasa.gov/rss/dyn/breaking_news.rss', siteUrl: 'https://www.nasa.gov', description: 'Missions, astronomy, and space exploration.', category: 'Science', topics: ['space', 'science', 'astronomy'] },
  { title: 'Aeon', url: 'https://aeon.co/feed.rss', siteUrl: 'https://aeon.co', description: 'Long-form essays on philosophy, science, and culture.', category: 'Science', topics: ['ideas', 'philosophy', 'science', 'culture'] },
  { title: 'Our World in Data', url: 'https://ourworldindata.org/atom.xml', siteUrl: 'https://ourworldindata.org', description: 'Data and research on global development.', category: 'Science', topics: ['data', 'science', 'climate', 'economics'] },
  { title: 'Inside Climate News', url: 'https://insideclimatenews.org/feed/', siteUrl: 'https://insideclimatenews.org', description: 'Climate reporting, science, and policy.', category: 'Science', topics: ['climate', 'science', 'policy', 'energy'] },
  { title: 'TED Talks', url: 'https://www.ted.com/feeds/talks.rss', siteUrl: 'https://www.ted.com', description: 'Talks on science, design, technology, and ideas.', category: 'Science', topics: ['ideas', 'science', 'design', 'talks'] },

  // Business, product, and culture
  { title: 'Stratechery', url: 'https://stratechery.com/feed/', siteUrl: 'https://stratechery.com', description: 'Technology strategy and business analysis.', category: 'Business', topics: ['business', 'strategy', 'technology'] },
  { title: "Lenny's Newsletter", url: 'https://www.lennysnewsletter.com/feed', siteUrl: 'https://www.lennysnewsletter.com', description: 'Product management, growth, and careers.', category: 'Business', topics: ['product', 'business', 'startups', 'career'] },
  { title: 'The Atlantic', url: 'https://www.theatlantic.com/feed/all/', siteUrl: 'https://www.theatlantic.com', description: 'Ideas, politics, and culture.', category: 'Business', topics: ['culture', 'politics', 'ideas', 'news'] },
  { title: 'Vox', url: 'https://www.vox.com/rss/index.xml', siteUrl: 'https://www.vox.com', description: 'Explanatory journalism on news and policy.', category: 'Business', topics: ['news', 'politics', 'culture', 'policy'] },
  { title: 'The New Yorker', url: 'https://www.newyorker.com/feed/everything', siteUrl: 'https://www.newyorker.com', description: 'Reporting, criticism, and essays.', category: 'Business', topics: ['culture', 'ideas', 'news', 'books'] },
  { title: 'Fast Company', url: 'https://www.fastcompany.com/rss', siteUrl: 'https://www.fastcompany.com', description: 'Business, design, and innovation.', category: 'Business', topics: ['business', 'design', 'innovation'] },
])

/** Common ways readers write a topic, expanded before matching. */
const TOPIC_ALIASES = Object.freeze({
  ai: ['artificial intelligence', 'llm', 'machine learning'],
  'artificial intelligence': ['ai'],
  llm: ['ai', 'large language model'],
  llms: ['ai', 'large language model'],
  'machine learning': ['ml', 'ai'],
  ml: ['machine learning', 'ai'],
  js: ['javascript'],
  javascript: ['js', 'frontend', 'web'],
  ts: ['typescript'],
  typescript: ['ts'],
  frontend: ['front-end', 'web'],
  'front-end': ['frontend'],
  backend: ['back-end', 'server'],
  'back-end': ['backend'],
  web: ['frontend', 'javascript', 'design'],
  devops: ['infrastructure', 'cloud'],
  'open source': ['oss'],
  oss: ['open source'],
  ux: ['user experience', 'design'],
  ui: ['user interface', 'design'],
  startup: ['startups'],
  startups: ['startup', 'business'],
  product: ['product management', 'design'],
  crypto: ['blockchain'],
  人工智能: ['ai'],
  机器学习: ['machine learning', 'ai'],
  大模型: ['ai', 'llm'],
  编程: ['programming'],
  前端: ['frontend', 'web'],
  后端: ['backend'],
  安全: ['security'],
  设计: ['design'],
  科学: ['science'],
  商业: ['business'],
  创业: ['startups'],
  开源: ['open source'],
  数据库: ['database'],
  云原生: ['cloud', 'kubernetes'],
  芯片: ['hardware', 'semiconductors'],
  太空: ['space'],
  气候: ['climate'],
  能源: ['energy'],
  生物: ['biology'],
  物理: ['physics'],
  数学: ['math'],
  产品: ['product'],
  效率: ['productivity'],
})

/** Normalize one topic label for display. */
export function cleanTopic(value) {
  return collapseWhitespace(String(value ?? ''))
    .replace(/^#+/, '')
    .replace(/^[-–—]+|[-–—]+$/g, '')
    .slice(0, 60)
    .trim()
}

/**
 * Normalize an untrusted topic list: trimmed, deduplicated case-insensitively,
 * bounded to 8 entries of 60 characters.
 * @param {unknown} topics - array or comma-separated string.
 * @returns {string[]} display labels in input order.
 */
export function normalizeTopicList(topics) {
  const list = Array.isArray(topics)
    ? topics
    : typeof topics === 'string'
      ? topics.split(/[,，;；\n]+/)
      : []
  const seen = new Set()
  const result = []
  for (const item of list) {
    const label = cleanTopic(item)
    if (label === '') continue
    const key = label.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(label)
    if (result.length >= MAX_TOPICS) break
  }
  return result
}

/**
 * Expand topics into lowercase match tokens, including common aliases.
 * @param {string[]|string} topics - reader topics.
 * @returns {string[]} unique tokens, capped at 12.
 */
export function topicTokens(topics) {
  const tokens = new Set()
  const add = (value) => {
    const token = collapseWhitespace(value).toLowerCase()
    if (token !== '' && token.length <= 60) tokens.add(token)
  }
  for (const topic of normalizeTopicList(topics)) {
    const lower = topic.toLowerCase()
    add(lower)
    for (const part of lower.split(/[^\p{L}\p{N}+#.]+/u)) add(part.replace(/^[.+#]+|[.+#]+$/g, ''))
    const aliases = Object.hasOwn(TOPIC_ALIASES, lower) ? TOPIC_ALIASES[lower] : []
    for (const alias of aliases) add(alias)
  }
  return [...tokens].slice(0, 12)
}

/** Whether a token appears in text on word-ish boundaries. */
function textHasToken(text, token) {
  if (token === '') return false
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'iu').test(text)
}

/** Score one catalog entry against the reader's tokens. */
function scoreEntry(entry, tokens) {
  let score = 0
  const matched = []
  const topics = entry.topics.map(topic => topic.toLowerCase())
  for (const token of tokens) {
    if (topics.includes(token)) {
      score += 6
      if (!matched.includes(token)) matched.push(token)
      continue
    }
    if (textHasToken(entry.title, token)) {
      score += 3
      if (!matched.includes(token)) matched.push(token)
      continue
    }
    if (textHasToken(entry.description, token)) {
      score += 1
      if (!matched.includes(token)) matched.push(token)
      continue
    }
    if (textHasToken(entry.category, token)) {
      score += 1
      if (!matched.includes(token)) matched.push(token)
    }
  }
  return { score, matched: matched.slice(0, 4) }
}

/**
 * Rank curated catalog entries for a topic list.
 * @param {string[]|string} topics - reader topics.
 * @param {{limit?: number}} [options] - result cap.
 * @returns {Array<object>} normalized catalog candidates, best first.
 */
export function catalogCandidates(topics, options = {}) {
  const limit = Math.min(20, Math.max(1, Number(options.limit) || 6))
  const tokens = topicTokens(topics)
  if (tokens.length === 0) return []
  const ranked = []
  const seen = new Set()
  for (const entry of FEED_CATALOG) {
    const url = normalizeUrl(entry.url)
    if (url === '' || !isValidFeedUrl(url) || seen.has(url)) continue
    const { score, matched } = scoreEntry(entry, tokens)
    if (score <= 0) continue
    seen.add(url)
    ranked.push({
      url,
      title: entry.title,
      siteUrl: normalizeUrl(entry.siteUrl ?? ''),
      description: entry.description,
      image: '',
      suggestedCategory: entry.category,
      tags: entry.topics.slice(0, 6),
      matchedTopics: matched,
      reason: '',
      source: 'catalog',
      score,
    })
  }
  ranked.sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
  return ranked.slice(0, limit)
}

/**
 * Build the set used to recognize sources the reader already follows. Only
 * exact normalized URLs count; a publisher can legitimately offer several
 * distinct feeds on one host.
 * @param {Array<object>} feeds - stored subscriptions.
 * @returns {{urls: Set<string>}}
 */
export function existingFeedKeys(feeds) {
  const urls = new Set()
  for (const feed of Array.isArray(feeds) ? feeds : []) {
    for (const value of [feed?.url, feed?.siteUrl]) {
      const normalized = normalizeUrl(value)
      if (normalized !== '') urls.add(normalized)
    }
  }
  return { urls }
}

/** Whether a candidate matches a subscription URL exactly. */
export function isExistingCandidate(candidate, keys) {
  if (keys === undefined || keys === null) return false
  for (const value of [candidate?.url, candidate?.finalUrl, candidate?.siteUrl]) {
    const normalized = normalizeUrl(value)
    if (normalized !== '' && keys.urls.has(normalized)) return true
  }
  return false
}

/**
 * Deduplicate candidates by normalized URL, keeping the first occurrence.
 * @param {Array<object>} candidates - AI candidates first, then catalog.
 * @param {number} [limit] - result cap.
 * @returns {Array<object>} unique candidates.
 */
export function mergeCandidates(candidates, limit = 14) {
  const seen = new Set()
  const result = []
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const url = normalizeUrl(candidate?.url)
    if (url === '' || !isValidFeedUrl(url) || seen.has(url)) continue
    seen.add(url)
    result.push({ ...candidate, url })
    if (result.length >= limit) break
  }
  return result
}

/**
 * Infer reader topics from explicit reading signals, saved articles, feed tags,
 * categories, and recent article tags. Newer libraries still get suggestions
 * from the default categories.
 * @param {{state?: object}} store - the durable store.
 * @param {number} [limit] - result cap.
 * @returns {string[]} topic labels, strongest first.
 */
export function inferTopics(store, limit = MAX_TOPICS) {
  const state = store?.state ?? {}
  const scores = new Map()
  const labels = new Map()
  const add = (value, weight) => {
    const label = cleanTopic(value)
    if (label === '' || isGenericTopic(label)) return
    const key = label.toLowerCase()
    if (!labels.has(key)) labels.set(key, label)
    scores.set(key, (scores.get(key) ?? 0) + weight)
  }
  for (const [tag, weight] of Object.entries(state.interests?.tags ?? {})) {
    add(tag, 3 + Math.min(3, Math.max(0, Number(weight) || 0)))
  }
  for (const article of Array.isArray(state.articles) ? state.articles : []) {
    if (article?.starred !== true && article?.readLater !== true) continue
    for (const tag of Array.isArray(article.tags) ? article.tags : []) add(tag, 2)
  }
  for (const feed of Array.isArray(state.feeds) ? state.feeds : []) {
    for (const tag of Array.isArray(feed?.tags) ? feed.tags : []) add(tag, 1)
  }
  for (const category of Array.isArray(state.categories) ? state.categories : []) add(category?.name, 1)
  // Recent article tags are a weak signal; they only break ties and help a
  // library with imports but no reading history.
  for (const article of (Array.isArray(state.articles) ? state.articles : []).slice(0, 40)) {
    for (const tag of Array.isArray(article?.tags) ? article.tags : []) add(tag, 0.25)
  }
  const target = Math.min(MAX_TOPICS, Math.max(1, Number(limit) || MAX_TOPICS))
  return [...scores.entries()]
    .sort((left, right) => right[1] - left[1] || labels.get(left[0]).localeCompare(labels.get(right[0])))
    .slice(0, target)
    .map(([key]) => labels.get(key))
}
