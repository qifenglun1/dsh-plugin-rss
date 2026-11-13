/** Plugin configuration defaults and normalization. */

export const DEFAULT_CONFIG = Object.freeze({
  /** Minutes between background refreshes; 0 disables the timer. */
  refreshMinutes: 30,
  /** Maximum articles retained across all feeds. */
  maxArticles: 3000,
  /** Articles requested per list page. */
  pageSize: 40,
  /** Request timeout for one feed or article fetch. */
  requestTimeoutMs: 25_000,
  /** Feed response body cap in bytes. */
  maxFeedBytes: 8 * 1024 * 1024,
  /** Article page body cap in bytes. */
  maxPageBytes: 6 * 1024 * 1024,
  /** Parse the original page for articles whose feed content is short. */
  fullTextOnRefresh: false,
  /** Allow fetching loopback/private-network hosts (LAN feeds, local gateways). */
  allowPrivateHosts: false,
  /** Directory name under $DSH_HOME that holds the data file. */
  dataDir: 'rss',
  /** Starts the plugin with a small curated set of feeds on first run. */
  seedFeeds: true,
  /** LLM route overrides; empty means "inherit the Harness default model". */
  aiProvider: '',
  aiModel: '',
  /** Maximum article characters sent to a model request. */
  aiMaxInputChars: 14_000,
  /** Default translation target when the user has no saved preference. */
  translateTo: '',
  /** Run automatic classification when new articles are stored. */
  autoClassify: false,
  /** Refresh on Host start. */
  refreshOnStart: true,
})

/** Read a positive number from untrusted configuration. */
function positive(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.min(max, Math.max(1, Math.round(number)))
}

/** Accept `true`, `"true"`, `1`, and `"1"` as true. */
function bool(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  const text = String(value).trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(text)) return true
  if (['false', '0', 'no', 'off'].includes(text)) return false
  return fallback
}

/** Merge user configuration over the defaults, rejecting unusable values. */
export function normalizeConfig(raw = {}) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    refreshMinutes: Number(config.refreshMinutes) === 0 ? 0 : positive(config.refreshMinutes, DEFAULT_CONFIG.refreshMinutes, 10_080),
    maxArticles: positive(config.maxArticles, DEFAULT_CONFIG.maxArticles, 50_000),
    pageSize: positive(config.pageSize, DEFAULT_CONFIG.pageSize, 200),
    // `timeoutMs` is the older alias still present in some profile patches.
    requestTimeoutMs: positive(config.requestTimeoutMs ?? config.timeoutMs, DEFAULT_CONFIG.requestTimeoutMs, 120_000),
    maxFeedBytes: positive(config.maxFeedBytes, DEFAULT_CONFIG.maxFeedBytes, 32 * 1024 * 1024),
    maxPageBytes: positive(config.maxPageBytes, DEFAULT_CONFIG.maxPageBytes, 32 * 1024 * 1024),
    fullTextOnRefresh: bool(config.fullTextOnRefresh, DEFAULT_CONFIG.fullTextOnRefresh),
    allowPrivateHosts: bool(config.allowPrivateHosts, DEFAULT_CONFIG.allowPrivateHosts),
    dataDir: typeof config.dataDir === 'string' && config.dataDir.trim() !== ''
      ? config.dataDir.trim().replace(/^[/\\]+/, '')
      : DEFAULT_CONFIG.dataDir,
    seedFeeds: bool(config.seedFeeds, DEFAULT_CONFIG.seedFeeds),
    aiProvider: typeof config.aiProvider === 'string' ? config.aiProvider.trim() : '',
    aiModel: typeof config.aiModel === 'string' ? config.aiModel.trim() : '',
    aiMaxInputChars: positive(config.aiMaxInputChars, DEFAULT_CONFIG.aiMaxInputChars, 60_000),
    translateTo: typeof config.translateTo === 'string' ? config.translateTo.trim() : '',
    autoClassify: bool(config.autoClassify, DEFAULT_CONFIG.autoClassify),
    refreshOnStart: bool(config.refreshOnStart, DEFAULT_CONFIG.refreshOnStart),
  }
}

/** Starter subscriptions used only when the data file is created. */
export const SEED_FEEDS = Object.freeze([
  { url: 'https://hnrss.org/frontpage', title: 'Hacker News', category: 'Technology' },
  { url: 'https://www.theverge.com/rss/index.xml', title: 'The Verge', category: 'Technology' },
  { url: 'https://feeds.arstechnica.com/arstechnica/index', title: 'Ars Technica', category: 'Technology' },
  { url: 'https://deepmind.google/blog/rss.xml', title: 'Google DeepMind', category: 'AI' },
  { url: 'https://openai.com/news/rss.xml', title: 'OpenAI News', category: 'AI' },
  // Validated on 2026-11-13 with the built-in feed validator.
  { url: 'https://github.blog/feed/', title: 'The GitHub Blog', category: 'Technology' },
  { url: 'https://feeds.macrumors.com/MacRumors-All', title: 'MacRumors', category: 'Technology' },
  { url: 'https://selfh.st/rss/', title: 'selfh.st', category: 'Technology' },
  { url: 'https://magazine.sebastianraschka.com/feed', title: 'Ahead of AI', category: 'AI' },
  { url: 'https://lastweekin.ai/feed', title: 'Last Week in AI', category: 'AI' },
  { url: 'https://feeds.megaphone.fm/hubermanlab', title: 'Huberman Lab', category: 'Science' },
  { url: 'https://www.vox.com/rss/index.xml', title: 'Vox', category: 'Recommended' },
  { url: 'https://www.trumpstruth.org/feed', title: 'Trump’s Truth', category: 'Recommended' },
  // Validated on 2026-11-13 with the built-in feed validator.
  { url: 'https://huggingface.co/blog/feed.xml', title: 'Hugging Face Blog', category: 'AI' },
  { url: 'https://simonwillison.net/atom/everything/', title: 'Simon Willison’s Weblog', category: 'AI' },
  { url: 'https://rss.arxiv.org/rss/cs.AI', title: 'arXiv cs.AI', category: 'AI' },
  { url: 'https://research.google/blog/rss/', title: 'Google Research', category: 'AI' },
  { url: 'https://hnrss.org/best', title: 'Hacker News Best', category: 'Technology' },
  { url: 'https://newsletter.pragmaticengineer.com/feed', title: 'The Pragmatic Engineer', category: 'Technology' },
  { url: 'https://feed.infoq.com', title: 'InfoQ', category: 'Technology' },
  { url: 'https://techcrunch.com/feed/', title: 'TechCrunch', category: 'Technology' },
  { url: 'https://www.technologyreview.com/feed/', title: 'MIT Technology Review', category: 'Technology' },
  { url: 'https://feeds.bbci.co.uk/zhongwen/trad/rss.xml', title: 'BBC 中文', category: 'Recommended' },
  { url: 'https://feeds.npr.org/1001/rss.xml', title: 'NPR News', category: 'Recommended' },
  { url: 'https://www.theguardian.com/world/rss', title: 'The Guardian World', category: 'Recommended' },
])

/** Default categories created with a fresh data file. */
export const DEFAULT_CATEGORIES = ['AI', 'Technology', 'Science', 'Design', 'Business', 'Recommended']
