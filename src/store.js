/** Durable JSON store for subscriptions, articles, reading state, and filters. */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { hashId, normalizeUrl, nowIso, truncate } from './util.js'
import { DEFAULT_CATEGORIES, SEED_FEEDS } from './config.js'
import { evaluateFilters, isSafeRegexSource, relevanceOf, searchScore } from './rank.js'
import { previewText, sanitizeHtml } from './html.js'

export const DATA_VERSION = 1
const SAVE_DEBOUNCE_MS = 350
const MAX_SAVE_ATTEMPTS = 5

/** Consecutive failed refreshes after which a subscription counts as invalid. */
export const INVALID_FAILURE_THRESHOLD = 3

/** Clamp one untrusted string field before it is persisted. */
function clampText(value, max) {
  return truncate(String(value ?? ''), max)
}

/** Build one subscription record with every field the store expects. */
function buildFeedRecord(input = {}) {
  const url = normalizeUrl(input.url)
  return {
    id: hashId(url, 'feed'),
    url: clampText(url, 2000),
    title: clampText(input.title ?? url, 200),
    siteUrl: '',
    description: '',
    language: '',
    image: '',
    categoryId: typeof input.categoryId === 'string' ? input.categoryId : null,
    tags: normalizeTags(input.tags),
    enabled: input.enabled !== false,
    addedAt: typeof input.addedAt === 'string' ? input.addedAt : nowIso(),
    lastFetchedAt: null,
    etag: null,
    lastModified: null,
    error: null,
    errorCode: null,
    failureCount: 0,
    lastErrorAt: null,
    lastSuccessAt: null,
    customTitle: input.customTitle === true,
  }
}

/** Whether a subscription has failed enough refreshes in a row to count as invalid. */
export function isFeedInvalid(feed) {
  return (Number(feed?.failureCount) || 0) >= INVALID_FAILURE_THRESHOLD
}

/** Normalize one stored article row read back from disk. */
function normalizeStoredArticle(article) {
  const ai = article.ai !== null && typeof article.ai === 'object' ? article.ai : {}
  const url = clampText(article.url, 2000)
  return {
    id: String(article.id),
    feedId: typeof article.feedId === 'string' ? article.feedId : '',
    guid: clampText(article.guid, 500),
    url,
    title: clampText(article.title, 400) || '(untitled)',
    summaryHtml: sanitizeHtml(typeof article.summaryHtml === 'string' ? article.summaryHtml : '', url, 20_000),
    contentHtml: sanitizeHtml(typeof article.contentHtml === 'string' ? article.contentHtml : '', url, 400_000),
    author: clampText(article.author, 200),
    publishedAt: typeof article.publishedAt === 'string' ? article.publishedAt : '',
    updatedAt: typeof article.updatedAt === 'string' ? article.updatedAt : '',
    storedAt: typeof article.storedAt === 'string' ? article.storedAt : nowIso(),
    tags: normalizeTags(article.tags),
    image: clampText(article.image, 2000),
    language: clampText(article.language, 40),
    read: article.read === true,
    starred: article.starred === true,
    readLater: article.readLater === true,
    ai: {
      summary: typeof ai.summary === 'string' ? ai.summary : null,
      summaryAt: typeof ai.summaryAt === 'string' ? ai.summaryAt : null,
      summaryLanguage: typeof ai.summaryLanguage === 'string' ? ai.summaryLanguage : null,
      contentHash: typeof ai.contentHash === 'string' ? ai.contentHash : null,
      translation: typeof ai.translation === 'string' ? ai.translation : null,
      translationLang: typeof ai.translationLang === 'string' ? ai.translationLang : null,
      translationAt: typeof ai.translationAt === 'string' ? ai.translationAt : null,
      translationHash: typeof ai.translationHash === 'string' ? ai.translationHash : null,
      categories: Array.isArray(ai.categories) ? ai.categories.slice(0, 2) : [],
      tags: normalizeTags(ai.tags),
      relevance: Number.isFinite(Number(ai.relevance)) ? Number(ai.relevance) : null,
      classifiedAt: typeof ai.classifiedAt === 'string' ? ai.classifiedAt : null,
    },
  }
}

/** Normalize a tag list: trimmed, unique, bounded. */
export function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(',') : []
  return [...new Set(list.map(tag => String(tag).trim().slice(0, 60)).filter(tag => tag !== ''))].slice(0, 20)
}

/** Build the state a fresh installation starts with. */
export function createInitialState(config, now = Date.now()) {
  const stamp = new Date(now).toISOString()
  const categories = DEFAULT_CATEGORIES.map((name, order) => ({
    id: hashId(name.toLowerCase(), 'cat'), name, order,
  }))
  const categoryId = (name) => categories.find(item => item.name === name)?.id ?? null
  const feeds = (config.seedFeeds === false ? [] : SEED_FEEDS).map(seed => buildFeedRecord({
    url: seed.url,
    title: seed.title,
    categoryId: categoryId(seed.category),
    addedAt: stamp,
  }))
  return {
    version: DATA_VERSION,
    createdAt: stamp,
    updatedAt: stamp,
    settings: {
      aiProvider: '',
      aiModel: '',
      translateTo: config.translateTo ?? '',
      autoClassify: config.autoClassify === true,
      pageSize: config.pageSize ?? 40,
      refreshMinutes: config.refreshMinutes ?? 30,
      preferredLanguage: '',
      lastRefreshAt: null,
      lastRefreshError: null,
    },
    categories,
    feeds,
    articles: [],
    filters: [],
    interests: { feeds: {}, tags: {}, keywords: {} },
  }
}

/** Keep only arrays/objects of the expected shape. */
function asArray(value) {
  return Array.isArray(value) ? value : []
}

/** Merge a loaded state with the current shape. */
function reconcileState(raw, config) {
  if (raw === null || typeof raw !== 'object' || raw.version !== DATA_VERSION) {
    throw new Error('unsupported data version')
  }
  const base = createInitialState(config)
  const settings = { ...base.settings, ...(raw.settings !== null && typeof raw.settings === 'object' ? raw.settings : {}) }
  settings.pageSize = Math.min(200, Math.max(10, Math.round(Number(settings.pageSize) || base.settings.pageSize)))
  settings.refreshMinutes = Math.min(10_080, Math.max(0, Math.round(Number(settings.refreshMinutes) || 0)))
  settings.autoClassify = settings.autoClassify === true
  settings.aiProvider = typeof settings.aiProvider === 'string' ? settings.aiProvider.slice(0, 120) : ''
  settings.aiModel = typeof settings.aiModel === 'string' ? settings.aiModel.slice(0, 160) : ''
  settings.translateTo = typeof settings.translateTo === 'string' ? settings.translateTo.slice(0, 40) : ''
  settings.preferredLanguage = typeof settings.preferredLanguage === 'string' ? settings.preferredLanguage.slice(0, 40) : ''
  settings.lastRefreshAt = typeof settings.lastRefreshAt === 'string' ? settings.lastRefreshAt : null
  settings.lastRefreshError = typeof settings.lastRefreshError === 'string' ? settings.lastRefreshError : null
  const state = {
    version: DATA_VERSION,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : base.createdAt,
    updatedAt: nowIso(),
    settings,
    categories: asArray(raw.categories).filter(item => item !== null && typeof item === 'object' && typeof item.name === 'string')
      .map((item, index) => ({
        id: typeof item.id === 'string' && item.id !== '' ? item.id : hashId(item.name.toLowerCase(), 'cat'),
        name: String(item.name).slice(0, 80),
        order: Number.isFinite(item.order) ? item.order : index,
      })),
    feeds: asArray(raw.feeds).filter(item => item !== null && typeof item === 'object' && typeof item.url === 'string')
      .map(item => ({
        id: typeof item.id === 'string' && item.id !== '' ? item.id : hashId(item.url, 'feed'),
        url: clampText(item.url, 2000),
        title: clampText(item.title ?? item.url, 200) || clampText(item.url, 2000),
        siteUrl: clampText(item.siteUrl, 2000),
        description: clampText(item.description, 1000),
        language: clampText(item.language, 40),
        image: clampText(item.image, 2000),
        categoryId: typeof item.categoryId === 'string' ? item.categoryId : null,
        tags: normalizeTags(item.tags),
        enabled: item.enabled !== false,
        addedAt: typeof item.addedAt === 'string' ? item.addedAt : nowIso(),
        lastFetchedAt: typeof item.lastFetchedAt === 'string' ? item.lastFetchedAt : null,
        etag: clampText(item.etag, 500) || null,
        lastModified: clampText(item.lastModified, 500) || null,
        error: typeof item.error === 'string' ? clampText(item.error, 300) : null,
        errorCode: typeof item.errorCode === 'string' ? clampText(item.errorCode, 80) : null,
        // Older files only stored `error`; a stored error counts as one failure
        // so it can never jump straight past the invalid threshold.
        failureCount: Number.isFinite(Number(item.failureCount))
          ? Math.min(10_000, Math.max(0, Math.floor(Number(item.failureCount))))
          : (typeof item.error === 'string' && item.error !== '' ? 1 : 0),
        lastErrorAt: typeof item.lastErrorAt === 'string' ? item.lastErrorAt : null,
        lastSuccessAt: typeof item.lastSuccessAt === 'string' ? item.lastSuccessAt : null,
        customTitle: item.customTitle === true,
      })),
    articles: asArray(raw.articles).filter(item => item !== null && typeof item === 'object' && typeof item.id === 'string')
      .map(normalizeStoredArticle),
    filters: asArray(raw.filters).filter(item => item !== null && typeof item === 'object' && typeof item.value === 'string'),
    interests: {
      feeds: raw.interests?.feeds !== null && typeof raw.interests?.feeds === 'object' ? raw.interests.feeds : {},
      tags: raw.interests?.tags !== null && typeof raw.interests?.tags === 'object' ? raw.interests.tags : {},
      keywords: raw.interests?.keywords !== null && typeof raw.interests?.keywords === 'object' ? raw.interests.keywords : {},
    },
  }
  const feedIds = new Set(state.feeds.map(feed => feed.id))
  state.articles = state.articles.filter(article => feedIds.has(article.feedId) || article.starred === true || article.readLater === true)
  return state
}

/** Durable store owner. */
export class RssStore {
  /**
   * @param {object} options - file path, normalized config, seed behaviour, logger.
   */
  constructor(options) {
    this.filePath = options.filePath
    this.config = options.config
    this.logger = options.logger ?? console
    this.state = createInitialState(options.config)
    this.saveTimer = null
    this.retryTimer = null
    this.writeChain = Promise.resolve()
    this.closed = false
    this.closing = false
    this.loaded = false
    this.openError = null
    this.lastSaveError = null
    this.dirtyVersion = 0
    this.saveAttempts = 0
  }

  /** Load the data file, creating a fresh one when absent or unreadable. */
  async open() {
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      let raw = null
      try {
        raw = await readFile(this.filePath, 'utf8')
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      if (raw !== null) {
        try {
          this.state = reconcileState(JSON.parse(raw), this.config)
        } catch (error) {
          const backup = `${this.filePath}.corrupt-${Date.now()}`
          this.logger.warn?.(`rss: the data file is unusable (${error instanceof Error ? error.message : String(error)}); moved to ${backup}`)
          try { await rename(this.filePath, backup) } catch { /* ignore */ }
          this.state = createInitialState(this.config)
        }
      }
      this.loaded = true
      this.openError = null
      await this.flush()
      return this
    } catch (error) {
      this.loaded = false
      this.openError = error
      throw error
    }
  }

  /** Mark state dirty and schedule a debounced durable write. */
  touch() {
    if (this.closed) return
    this.state.updatedAt = nowIso()
    this.dirtyVersion += 1
    // Before open succeeds there is nothing safe to write to.
    if (!this.loaded) return
    // While closing, the close loop owns persistence; record the dirty version only.
    if (this.closing) return
    if (this.saveTimer !== null) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.writeChain = this.writeChain.then(() => this.writeNow()).catch((error) => {
        this.lastSaveError = error instanceof Error ? error.message : String(error)
        this.logger.warn?.(`rss: saving the data file failed: ${this.lastSaveError}`)
        this.scheduleRetry()
      })
    }, SAVE_DEBOUNCE_MS)
    this.saveTimer.unref?.()
  }

  /** Retry one failed debounced save with bounded exponential backoff. */
  scheduleRetry() {
    if (this.closed || this.closing || !this.loaded || this.retryTimer !== null) return
    if (this.saveAttempts >= MAX_SAVE_ATTEMPTS) return
    this.saveAttempts += 1
    const delay = Math.min(30_000, 1_000 * 2 ** (this.saveAttempts - 1))
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.flush().catch((error) => {
        this.lastSaveError = error instanceof Error ? error.message : String(error)
        this.scheduleRetry()
      })
    }, delay)
    this.retryTimer.unref?.()
  }

  /** Write the current state and wait for durability. */
  async flush() {
    if (!this.loaded) return
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    // A mutation that lands while a write is in flight gets another pass.
    for (let pass = 0; pass < 5; pass += 1) {
      const version = this.dirtyVersion
      this.writeChain = this.writeChain.then(() => this.writeNow())
      try {
        await this.writeChain
      } catch (error) {
        // Reset the chain so one transient failure cannot poison later writes.
        this.writeChain = Promise.resolve()
        this.lastSaveError = error instanceof Error ? error.message : String(error)
        throw error
      }
      if (version === this.dirtyVersion) {
        this.lastSaveError = null
        this.saveAttempts = 0
        break
      }
    }
  }

  /** Atomic replace of the data file. */
  async writeNow() {
    if (!this.loaded || this.closed) return
    const body = `${JSON.stringify(this.state)}\n`
    const temporary = `${this.filePath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`
    try {
      await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, this.filePath)
    } catch (error) {
      try { await rename(temporary, `${this.filePath}.tmp-failed-${Date.now()}`) } catch { /* ignore */ }
      throw error
    }
  }

  /** Stop the timer and persist, even when the last write failed. */
  async close() {
    if (this.closed) return
    this.closing = true
    try {
      await this.flush()
    } catch (error) {
      this.lastSaveError = error instanceof Error ? error.message : String(error)
      this.logger.warn?.(`rss: closing the data file failed to persist: ${this.lastSaveError}`)
    } finally {
      this.closing = false
      this.closed = true
      if (this.saveTimer !== null) { clearTimeout(this.saveTimer); this.saveTimer = null }
      if (this.retryTimer !== null) { clearTimeout(this.retryTimer); this.retryTimer = null }
    }
  }

  /** Current effective settings with configuration overrides applied. */
  settings() {
    return {
      ...this.state.settings,
      ...this.config.aiProvider === '' ? {} : { aiProvider: this.config.aiProvider },
      ...this.config.aiModel === '' ? {} : { aiModel: this.config.aiModel },
    }
  }

  /** Save the client-editable settings subset. */
  saveSettings(patch = {}) {
    const target = this.state.settings
    if (typeof patch.aiProvider === 'string') target.aiProvider = patch.aiProvider.trim().slice(0, 120)
    if (typeof patch.aiModel === 'string') target.aiModel = patch.aiModel.trim().slice(0, 160)
    if (typeof patch.translateTo === 'string') target.translateTo = patch.translateTo.trim().slice(0, 40)
    if (typeof patch.preferredLanguage === 'string') target.preferredLanguage = patch.preferredLanguage.trim().slice(0, 40)
    if (typeof patch.autoClassify === 'boolean') target.autoClassify = patch.autoClassify
    if (typeof patch.pageSize === 'number' && Number.isFinite(patch.pageSize)) {
      target.pageSize = Math.min(200, Math.max(10, Math.round(patch.pageSize)))
    }
    if (typeof patch.refreshMinutes === 'number' && Number.isFinite(patch.refreshMinutes)) {
      target.refreshMinutes = Math.min(10_080, Math.max(0, Math.round(patch.refreshMinutes)))
    }
    this.touch()
    return this.settings()
  }

  /** Find a category by display name, optionally creating it. */
  categoryIdFor(name, create = false) {
    const wanted = String(name ?? '').trim().slice(0, 80)
    if (wanted === '') return null
    const found = this.state.categories.find(item => item.name.toLowerCase() === wanted.toLowerCase())
    if (found !== undefined) return found.id
    if (!create) return null
    const category = { id: hashId(wanted.toLowerCase(), 'cat'), name: wanted.slice(0, 80), order: this.state.categories.length }
    this.state.categories.push(category)
    this.touch()
    return category.id
  }

  /** Add or update a subscription by URL. */
  upsertFeed(input) {
    const url = normalizeUrl(input.url)
    if (url === '') throw new Error('The feed URL is not valid.')
    let feed = this.state.feeds.find(item => normalizeUrl(item.url) === url)
    if (feed === undefined) {
      feed = buildFeedRecord({ ...input, url })
      this.state.feeds.push(feed)
    }
    if (input.title !== undefined && input.customTitle === true) {
      feed.title = clampText(input.title, 200)
      feed.customTitle = true
    }
    if (input.categoryId !== undefined) feed.categoryId = input.categoryId ?? null
    if (input.tags !== undefined) feed.tags = normalizeTags(input.tags)
    if (input.enabled !== undefined) feed.enabled = input.enabled !== false
    this.touch()
    return feed
  }

  /** Update one feed record (subscription metadata only). */
  updateFeed(id, patch = {}) {
    const feed = this.state.feeds.find(item => item.id === id)
    if (feed === undefined) return undefined
    if (typeof patch.title === 'string' && patch.title.trim() !== '') {
      feed.title = patch.title.trim().slice(0, 200)
      feed.customTitle = true
    }
    if (patch.categoryId !== undefined) feed.categoryId = patch.categoryId ?? null
    if (patch.categoryName !== undefined) feed.categoryId = this.categoryIdFor(patch.categoryName, true)
    if (patch.tags !== undefined) feed.tags = normalizeTags(patch.tags)
    if (typeof patch.enabled === 'boolean') feed.enabled = patch.enabled
    this.touch()
    return feed
  }

  /** Remove a subscription and its non-protected articles. */
  removeFeed(id) {
    return this.removeFeeds([id]).removed.length > 0
  }

  /**
   * Remove several subscriptions at once.
   * Starred and read-later articles survive the removal, exactly like a single
   * subscription removal, and feed-scoped interest weights are dropped.
   * @param {Iterable<string>} ids - subscription ids to remove.
   * @returns {{ removed: Array<object>, keptArticles: number }} what changed.
   */
  removeFeeds(ids) {
    const wanted = ids instanceof Set ? ids : new Set(ids)
    const removed = this.state.feeds.filter(feed => wanted.has(feed.id))
    if (removed.length === 0) return { removed: [], keptArticles: 0 }
    this.state.feeds = this.state.feeds.filter(feed => !wanted.has(feed.id))
    this.state.articles = this.state.articles.filter(article => !wanted.has(article.feedId) || article.starred === true || article.readLater === true)
    for (const id of wanted) delete this.state.interests.feeds[id]
    const keptArticles = this.state.articles.filter(article => wanted.has(article.feedId)).length
    this.touch()
    return { removed, keptArticles }
  }

  /**
   * Merge the curated default subscriptions back into the library.
   * Existing subscriptions (matched by normalized URL) are never modified.
   * @returns {Array<object>} the subscription records that were added.
   */
  restoreDefaultFeeds() {
    const existing = new Set(this.state.feeds.map(feed => normalizeUrl(feed.url)))
    const added = []
    for (const seed of SEED_FEEDS) {
      const url = normalizeUrl(seed.url)
      if (url === '' || existing.has(url)) continue
      const categoryId = seed.category ? this.categoryIdFor(seed.category, true) : null
      const feed = buildFeedRecord({ url, title: seed.title, categoryId })
      this.state.feeds.push(feed)
      existing.add(url)
      added.push(feed)
    }
    if (added.length > 0) this.touch()
    return added
  }

  /** Subscriptions that have failed at least the invalid threshold in a row. */
  invalidFeeds() {
    return this.state.feeds.filter(feed => isFeedInvalid(feed))
  }

  /** Mark a feed's fetch outcome. */
  recordFetch(feedId, outcome) {
    const feed = this.state.feeds.find(item => item.id === feedId)
    if (feed === undefined) return
    feed.lastFetchedAt = outcome.fetchedAt ?? nowIso()
    if (outcome.error === undefined) {
      feed.error = null
      feed.errorCode = null
      feed.failureCount = 0
      feed.lastSuccessAt = feed.lastFetchedAt
    } else {
      feed.error = clampText(outcome.error, 300)
      feed.errorCode = outcome.errorCode === undefined || outcome.errorCode === null
        ? feed.errorCode
        : clampText(outcome.errorCode, 80)
      feed.failureCount = Math.min(10_000, (Number(feed.failureCount) || 0) + 1)
      feed.lastErrorAt = feed.lastFetchedAt
    }
    if (outcome.feed !== undefined) {
      const parsed = outcome.feed
      if (feed.customTitle !== true && parsed.title) feed.title = truncate(parsed.title, 200)
      if (parsed.siteUrl) feed.siteUrl = clampText(parsed.siteUrl, 2000)
      if (parsed.description) feed.description = truncate(parsed.description, 1000)
      if (parsed.language) feed.language = clampText(parsed.language, 40)
      if (parsed.image) feed.image = clampText(parsed.image, 2000)
    }
    if (outcome.etag !== undefined) feed.etag = outcome.etag === null ? null : clampText(outcome.etag, 500)
    if (outcome.lastModified !== undefined) feed.lastModified = outcome.lastModified === null ? null : clampText(outcome.lastModified, 500)
    this.touch()
  }

  /** Store fetched entries, preserving reading state on existing rows. */
  ingest(feedId, items, options = {}) {
    const feed = this.state.feeds.find(item => item.id === feedId)
    if (feed === undefined) return { added: 0, updated: 0, addedIds: [] }
    const existing = new Map(this.state.articles.map(article => [article.id, article]))
    const added = []
    let updated = 0
    for (const item of items) {
      if (item === null || typeof item !== 'object') continue
      const title = clampText(item.title, 400) || '(untitled)'
      const guid = clampText(item.guid, 500)
      const url = clampText(item.url, 2000)
      const id = hashId(`${feedId}|${guid || url || title}`, 'art')
      const current = existing.get(id)
      const base = url || feed.siteUrl || feed.url
      const summaryHtml = sanitizeHtml(truncate(item.summaryHtml ?? '', 20_000), base)
      const contentHtml = sanitizeHtml(truncate(item.contentHtml ?? '', 400_000), base)
      if (current === undefined) {
        const article = {
          id,
          feedId,
          guid,
          url,
          title,
          summaryHtml,
          contentHtml,
          author: clampText(item.author, 200),
          publishedAt: item.publishedAt || nowIso(),
          updatedAt: item.updatedAt || item.publishedAt || nowIso(),
          storedAt: nowIso(),
          tags: normalizeTags(item.tags),
          image: clampText(item.image, 2000),
          language: clampText(item.language, 40),
          read: false,
          starred: false,
          readLater: false,
          ai: emptyAi(),
        }
        added.push(article)
        existing.set(id, article)
      } else {
        const changed = current.title !== title
          || current.contentHtml !== contentHtml
          || current.url !== (url || current.url)
        if (changed) updated += 1
        current.title = title
        current.url = url || current.url
        current.summaryHtml = summaryHtml
        if ((contentHtml ?? '').length >= (current.contentHtml ?? '').length) current.contentHtml = contentHtml
        current.author = clampText(item.author || current.author, 200)
        current.publishedAt = item.publishedAt || current.publishedAt
        current.updatedAt = item.updatedAt || current.updatedAt
        current.tags = normalizeTags([...current.tags, ...(item.tags ?? [])])
        current.image = clampText(item.image || current.image, 2000)
        current.language = clampText(item.language || current.language, 40)
      }
    }
    if (added.length > 0) {
      this.state.articles = [...added, ...this.state.articles]
    }
    this.state.articles.sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt))
    this.prune()
    if (added.length > 0 || updated > 0) this.touch()
    return { added: added.length, updated, addedIds: added.map(article => article.id) }
  }

  /** Keep the newest rows within the cap while protecting saved articles. */
  prune() {
    const max = this.config.maxArticles
    if (this.state.articles.length <= max) return
    const keep = []
    const rest = []
    for (const article of this.state.articles) {
      if (article.starred || article.readLater) keep.push(article)
      else rest.push(article)
    }
    const remaining = Math.max(0, max - keep.length)
    this.state.articles = [...keep, ...rest.slice(0, remaining)]
      .sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt))
  }

  /** Read one article. */
  getArticle(id) {
    return this.state.articles.find(article => article.id === id)
  }

  /** Replace one article's generated content or AI cache. */
  updateArticle(id, patch = {}) {
    const article = this.getArticle(id)
    if (article === undefined) return undefined
    if (typeof patch.contentHtml === 'string') {
      article.contentHtml = sanitizeHtml(patch.contentHtml, article.url, 400_000)
    }
    if (typeof patch.summaryHtml === 'string') {
      article.summaryHtml = sanitizeHtml(patch.summaryHtml, article.url, 20_000)
    }
    if (typeof patch.title === 'string' && patch.title.trim() !== '') article.title = clampText(patch.title, 400)
    if (typeof patch.author === 'string') article.author = clampText(patch.author, 200)
    if (typeof patch.image === 'string') article.image = clampText(patch.image, 2000)
    if (patch.ai !== undefined && patch.ai !== null) article.ai = { ...article.ai, ...patch.ai }
    if (patch.tags !== undefined) article.tags = normalizeTags(patch.tags)
    this.touch()
    return article
  }

  /** Update read/star/read-later flags and interest weights. */
  mark(id, patch = {}) {
    const article = this.getArticle(id)
    if (article === undefined) return undefined
    if (typeof patch.read === 'boolean') {
      if (patch.read && !article.read) this.reinforce(article, 0.25)
      article.read = patch.read
    }
    if (typeof patch.starred === 'boolean') {
      if (patch.starred && !article.starred) this.reinforce(article, 2)
      article.starred = patch.starred
    }
    if (typeof patch.readLater === 'boolean') {
      if (patch.readLater && !article.readLater) this.reinforce(article, 1)
      article.readLater = patch.readLater
    }
    this.touch()
    return article
  }

  /**
   * Mark every article matching a view, subscription, category, tag, or text
   * query as read. Returns the changed ids so the client can offer an undo.
   */
  markAll(filter = {}) {
    const {
      feedId = null, categoryId = null, tag = null, text = '', view = 'all', hideMuted = true,
    } = filter
    if (!['all', 'unread', 'starred', 'later', 'forYou'].includes(view)) {
      const error = new Error(`Unknown view: ${String(view)}`)
      error.code = 'invalid_view'
      error.status = 400
      throw error
    }
    const term = String(text ?? '').trim()
    const feedById = new Map(this.state.feeds.map(feed => [feed.id, feed]))
    const ids = []
    for (const article of this.state.articles) {
      if (feedId !== null && article.feedId !== feedId) continue
      const feed = feedById.get(article.feedId)
      if (categoryId !== null && feed?.categoryId !== categoryId) continue
      if (tag !== null && !(article.tags ?? []).includes(tag)) continue
      if (view === 'starred' && !article.starred) continue
      if (view === 'later' && !article.readLater) continue
      if (view === 'unread' && article.read) continue
      if (term !== '' && searchScore(article, term, feed?.title ?? '') <= 0) continue
      if (hideMuted && evaluateFilters(article, this.state.filters, feed?.title ?? '').muted) continue
      if (!article.read) {
        article.read = true
        ids.push(article.id)
      }
    }
    if (ids.length > 0) this.touch()
    return { updated: ids.length, ids }
  }

  /**
   * Apply one read/star/read-later patch to many articles at once.
   * Missing ids are skipped; interest weights follow the same rules as mark().
   * Returns the number of articles that actually changed.
   */
  markMany(ids, patch = {}) {
    const wanted = new Set(
      (Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string' && id !== ''),
    )
    if (wanted.size === 0) return 0
    const read = typeof patch.read === 'boolean' ? patch.read : undefined
    const starred = typeof patch.starred === 'boolean' ? patch.starred : undefined
    const readLater = typeof patch.readLater === 'boolean' ? patch.readLater : undefined
    if (read === undefined && starred === undefined && readLater === undefined) return 0
    let updated = 0
    for (const article of this.state.articles) {
      if (!wanted.has(article.id)) continue
      let changed = false
      if (read !== undefined && article.read !== read) {
        if (read && !article.read) this.reinforce(article, 0.25)
        article.read = read
        changed = true
      }
      if (starred !== undefined && article.starred !== starred) {
        if (starred && !article.starred) this.reinforce(article, 2)
        article.starred = starred
        changed = true
      }
      if (readLater !== undefined && article.readLater !== readLater) {
        if (readLater && !article.readLater) this.reinforce(article, 1)
        article.readLater = readLater
        changed = true
      }
      if (changed) updated += 1
    }
    if (updated > 0) this.touch()
    return updated
  }

  /** Nudge interest weights from one explicit user action. */
  reinforce(article, amount) {
    const interests = this.state.interests
    interests.feeds[article.feedId] = (Number(interests.feeds[article.feedId]) || 0) + amount
    for (const tag of [...(article.tags ?? []), ...this.feedTags(article.feedId)]) {
      interests.tags[tag] = (Number(interests.tags[tag]) || 0) + amount
    }
  }

  /** Tags attached to a feed. */
  feedTags(feedId) {
    return this.state.feeds.find(feed => feed.id === feedId)?.tags ?? []
  }

  /** Build the counts used by the navigation rail. */
  counts() {
    const byFeed = {}
    const byCategory = {}
    const byTag = {}
    const bump = (map, key) => {
      if (key === undefined || key === null || key === '') return
      map[key] = (Object.hasOwn(map, key) ? map[key] : 0) + 1
    }
    let unread = 0
    let starred = 0
    let later = 0
    let saved = 0
    const categoryOfFeed = new Map(this.state.feeds.map(feed => [feed.id, feed.categoryId]))
    for (const article of this.state.articles) {
      if (!article.read) {
        unread += 1
        bump(byFeed, article.feedId)
        const categoryId = categoryOfFeed.get(article.feedId)
        if (categoryId) bump(byCategory, categoryId)
      }
      if (article.starred) starred += 1
      if (article.readLater) later += 1
      if (article.starred || article.readLater) saved += 1
      for (const tag of article.tags ?? []) bump(byTag, tag)
    }
    return {
      all: this.state.articles.length, unread, starred, later, saved, byFeed, byCategory, byTag,
    }
  }

  /** Subscription and taxonomy snapshot for the client. */
  stateForClient(aiRoute) {
    const counts = this.counts()
    const categoryById = new Map(this.state.categories.map(category => [category.id, category]))
    const tags = Object.entries(counts.byTag)
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
      .slice(0, 60)
    return {
      version: DATA_VERSION,
      settings: this.settings(),
      categories: [...this.state.categories]
        .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name))
        .map(category => ({ ...category, unread: counts.byCategory[category.id] ?? 0, feedCount: this.state.feeds.filter(feed => feed.categoryId === category.id).length })),
      tags,
      feeds: [...this.state.feeds].map(feed => ({
        id: feed.id,
        url: feed.url,
        title: feed.title,
        siteUrl: feed.siteUrl,
        description: feed.description,
        image: feed.image,
        categoryId: feed.categoryId,
        categoryName: categoryById.get(feed.categoryId)?.name ?? '',
        tags: feed.tags,
        enabled: feed.enabled,
        error: feed.error,
        errorCode: feed.errorCode,
        failureCount: feed.failureCount,
        lastErrorAt: feed.lastErrorAt,
        lastSuccessAt: feed.lastSuccessAt,
        lastFetchedAt: feed.lastFetchedAt,
        unread: counts.byFeed[feed.id] ?? 0,
        articleCount: this.state.articles.filter(article => article.feedId === feed.id).length,
      })).sort((left, right) => left.title.localeCompare(right.title)),
      filters: this.state.filters,
      counts,
      invalidFailureThreshold: INVALID_FAILURE_THRESHOLD,
      stats: {
        feeds: this.state.feeds.length,
        articles: this.state.articles.length,
        unread: counts.unread,
        starred: counts.starred,
        later: counts.later,
        savedArticles: counts.saved,
        invalidFeeds: this.state.feeds.filter(feed => isFeedInvalid(feed)).length,
        failingFeeds: this.state.feeds.filter(feed => feed.error !== null).length,
        lastRefreshAt: this.state.settings.lastRefreshAt,
        lastRefreshError: this.state.settings.lastRefreshError,
        lastSaveError: this.lastSaveError,
      },
      ai: aiRoute,
    }
  }

  /**
   * Page through articles for one view.
   * @param {object} query - view, feed/category/tag, text query, page bounds, sorting.
   */
  listArticles(query = {}) {
    const {
      view = 'all', feedId = null, categoryId = null, tag = null, text = '',
      limit = this.settings().pageSize, offset = 0, hideMuted = true, sort = 'newest',
    } = query
    const feedById = new Map(this.state.feeds.map(feed => [feed.id, feed]))
    const term = String(text ?? '').trim()
    const now = Date.now()
    const filtered = []
    let mutedHidden = 0
    for (const article of this.state.articles) {
      if (view === 'unread' && article.read) continue
      if (view === 'starred' && !article.starred) continue
      if (view === 'later' && !article.readLater) continue
      if (view === 'forYou' && article.read && !article.starred && !article.readLater) continue
      if (feedId !== null && article.feedId !== feedId) continue
      if (tag !== null && !(article.tags ?? []).includes(tag)) continue
      const feed = feedById.get(article.feedId)
      if (categoryId !== null && feed?.categoryId !== categoryId) continue
      if (term !== '') {
        const score = searchScore(article, term, feed?.title ?? '')
        if (score <= 0) continue
      }
      const flags = evaluateFilters(article, this.state.filters, feed?.title ?? '')
      if (hideMuted && flags.muted) {
        mutedHidden += 1
        continue
      }
      filtered.push({ article, feed, flags })
    }
    if (term !== '') {
      filtered.sort((left, right) => {
        const delta = searchScore(right.article, term, right.feed?.title ?? '') - searchScore(left.article, term, left.feed?.title ?? '')
        return delta !== 0 ? delta : Date.parse(right.article.publishedAt) - Date.parse(left.article.publishedAt)
      })
    } else if (view === 'forYou') {
      const weights = { feedWeights: this.state.interests.feeds, tagWeights: this.state.interests.tags, now }
      filtered.sort((left, right) => {
        const delta = relevanceOf(right.article, weights).score - relevanceOf(left.article, weights).score
        return delta !== 0 ? delta : Date.parse(right.article.publishedAt) - Date.parse(left.article.publishedAt)
      })
    } else if (sort === 'oldest') {
      filtered.sort((left, right) => Date.parse(left.article.publishedAt) - Date.parse(right.article.publishedAt))
    }
    const total = filtered.length
    const pageSize = Math.min(200, Math.max(1, Number(limit) || 40))
    const start = Math.max(0, Number(offset) || 0)
    const weights = { feedWeights: this.state.interests.feeds, tagWeights: this.state.interests.tags, now }
    const items = filtered.slice(start, start + pageSize).map(({ article, feed, flags }) => ({
      id: article.id,
      feedId: article.feedId,
      feedTitle: feed?.title ?? 'Unknown feed',
      feedImage: feed?.image ?? '',
      title: article.title,
      url: article.url,
      author: article.author,
      publishedAt: article.publishedAt,
      snippet: truncate(previewText(article.summaryHtml, 600), 600),
      tags: article.tags,
      image: article.image,
      read: article.read,
      starred: article.starred,
      readLater: article.readLater,
      hasSummary: typeof article.ai?.summary === 'string' && article.ai.summary !== '',
      hasTranslation: typeof article.ai?.translation === 'string' && article.ai.translation !== '',
      muted: flags.muted,
      highlighted: flags.highlighted,
      relevance: article.ai?.relevance ?? Math.round(relevanceOf(article, weights).score * 100),
    }))
    return {
      items, total, offset: start, limit: pageSize, view, hasMore: start + items.length < total, mutedHidden,
    }
  }

  /** Search tags and feeds for the command palette. */
  suggestions(term) {
    const wanted = String(term ?? '').toLowerCase()
    if (wanted === '') return { feeds: [], tags: [] }
    return {
      feeds: this.state.feeds.filter(feed => feed.title.toLowerCase().includes(wanted)).slice(0, 8)
        .map(feed => ({ id: feed.id, title: feed.title })),
      tags: Object.keys(this.counts().byTag).filter(tag => tag.toLowerCase().includes(wanted)).slice(0, 8),
    }
  }

  /** Add a content filter rule. */
  saveFilter(input) {
    const value = String(input.value ?? '').trim()
    if (value === '') throw new Error('A filter needs a value.')
    const rule = {
      id: typeof input.id === 'string' && input.id !== '' ? input.id : `filter-${randomUUID()}`,
      name: String(input.name ?? value).slice(0, 80),
      field: ['title', 'content', 'author', 'feed'].includes(input.field) ? input.field : 'title',
      op: input.op === 'regex' ? 'regex' : 'contains',
      value: value.slice(0, 200),
      type: input.type === 'highlight' ? 'highlight' : 'mute',
      enabled: input.enabled !== false,
    }
    if (rule.op === 'regex') {
      try { new RegExp(rule.value, 'i') } catch { throw new Error('The regular expression is not valid.') }
      if (!isSafeRegexSource(rule.value)) {
        throw new Error('That regular expression can freeze the reader; simplify it (avoid quantified groups, backreferences, and many unbounded quantifiers).')
      }
    }
    const index = this.state.filters.findIndex(item => item.id === rule.id)
    if (index === -1) this.state.filters.push(rule)
    else this.state.filters[index] = rule
    this.touch()
    return rule
  }

  /** Remove a content filter rule. */
  removeFilter(id) {
    const before = this.state.filters.length
    this.state.filters = this.state.filters.filter(item => item.id !== id)
    if (this.state.filters.length !== before) this.touch()
    return this.state.filters.length !== before
  }

  /** Add a category. */
  addCategory(name) {
    const trimmed = String(name ?? '').trim().slice(0, 80)
    if (trimmed === '') throw new Error('A category needs a name.')
    if (this.state.categories.some(category => category.name.toLowerCase() === trimmed.toLowerCase())) {
      throw new Error('That category already exists.')
    }
    const category = { id: hashId(trimmed.toLowerCase(), 'cat'), name: trimmed, order: this.state.categories.length }
    this.state.categories.push(category)
    this.touch()
    return category
  }

  /** Rename a category. */
  renameCategory(id, name) {
    const category = this.state.categories.find(item => item.id === id)
    if (category === undefined) return undefined
    const trimmed = String(name ?? '').trim().slice(0, 80)
    if (trimmed !== '') {
      if (this.state.categories.some(item => item.id !== id && item.name.toLowerCase() === trimmed.toLowerCase())) {
        const error = new Error('That category already exists.')
        error.status = 400
        error.code = 'category_exists'
        throw error
      }
      category.name = trimmed
    }
    this.touch()
    return category
  }

  /** Delete a category, leaving its feeds uncategorized. */
  removeCategory(id) {
    const before = this.state.categories.length
    this.state.categories = this.state.categories.filter(item => item.id !== id)
    if (this.state.categories.length === before) return false
    for (const feed of this.state.feeds) if (feed.categoryId === id) feed.categoryId = null
    this.touch()
    return true
  }

  /** Record the last OPML import for diagnostics. */
  recordOpml(outcome) {
    this.state.settings.lastOpmlImport = {
      at: nowIso(),
      added: Number(outcome.added) || 0,
      failed: Number(outcome.failed) || 0,
      errors: Array.isArray(outcome.errors) ? outcome.errors.slice(0, 5) : [],
    }
    this.touch()
  }

  /** Record a refresh outcome at the data-file level. */
  recordRefresh(outcome) {
    this.state.settings.lastRefreshAt = outcome.at ?? nowIso()
    this.state.settings.lastRefreshError = outcome.error ?? null
    this.touch()
  }
}

/** Empty AI cache for one article. */
export function emptyAi() {
  return {
    summary: null,
    summaryAt: null,
    summaryLanguage: null,
    contentHash: null,
    translation: null,
    translationLang: null,
    translationAt: null,
    translationHash: null,
    categories: [],
    tags: [],
    relevance: null,
    classifiedAt: null,
  }
}
