/** Feed refresh, subscription validation, and full-text extraction orchestration. */
import { fetchResource, combineSignals } from './http.js'
import { decodeBody, feedErrorHint, parseFeed, isValidFeedUrl } from './feed.js'
import { extractArticle } from './html.js'
import { collapseWhitespace, normalizeUrl, nowIso, resolveUrl, truncate, yieldToLoop } from './util.js'

/** Build a cooperative-cancellation error. */
function abortError() {
  const error = new Error('The operation was cancelled.')
  error.name = 'AbortError'
  error.code = 'aborted'
  return error
}

/** Run tasks with bounded concurrency, stopping when the caller cancels. */
async function mapPool(items, limit, work, signal) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      if (signal?.aborted) throw abortError()
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await work(items[index], index)
      await yieldToLoop()
    }
  })
  await Promise.all(workers)
  return results
}

/** Discover a feed advertised by an HTML page. */
function discoverAlternateFeed(html, pageUrl) {
  const pattern = /<link\b[^>]*>/gi
  let match
  while ((match = pattern.exec(html)) !== null) {
    const tag = match[0]
    if (!/rel\s*=\s*["'][^"']*alternate/i.test(tag)) continue
    if (!/type\s*=\s*["'](?:application\/(?:rss|atom)\+xml|application\/feed\+json|application\/rdf\+xml)/i.test(tag)) continue
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]
    if (href !== undefined) {
      const resolved = resolveUrl(href, pageUrl)
      if (resolved !== '') return resolved
    }
  }
  return undefined
}

/** Feed engine bound to one store and configuration. */
export class FeedEngine {
  constructor(options) {
    this.store = options.store
    this.config = options.config
    this.logger = options.logger ?? console
    this.onNewArticles = options.onNewArticles ?? (() => {})
    this.refreshPromise = null
    this.importController = new AbortController()
    this.lifecycleController = new AbortController()
  }

  /** Cancel background work and prevent new network requests after unload. */
  dispose() {
    this.lifecycleController.abort()
    this.importController.abort()
  }

  /** Wait for an in-flight refresh pass to settle (used during shutdown). */
  async waitForIdle() {
    const pending = this.refreshPromise
    if (pending !== null) await pending.catch(() => {})
  }

  /** One feed fetch options object, combined with the lifecycle signal. */
  requestOptions(signal, maxBytes, timeoutMs = this.config.requestTimeoutMs) {
    return {
      timeoutMs,
      maxBytes,
      signal: combineSignals([this.lifecycleController.signal, signal]),
      allowPrivateHosts: this.config.allowPrivateHosts === true,
    }
  }

  /**
   * Validate a subscription URL, following one page-level feed discovery step.
   * @param {string} url - feed or site URL.
   * @param {{signal?: AbortSignal, timeoutMs?: number}} [options] - cooperative cancellation and a per-request timeout override.
   * @returns {Promise<{ feed: object, finalUrl: string }>} parsed feed and the URL that served it.
   */
  async validate(url, options = {}) {
    const signal = options.signal
    const timeoutMs = options.timeoutMs ?? this.config.requestTimeoutMs
    const trimmed = String(url ?? '').trim()
    if (!isValidFeedUrl(trimmed)) throw new Error('Enter an http(s) feed or site URL.')
    const first = await fetchResource(trimmed, this.requestOptions(signal, this.config.maxFeedBytes, timeoutMs))
    const firstText = decodeBody(first.body, first.contentType)
    try {
      const feed = parseFeed(firstText, first.finalUrl)
      return { feed, finalUrl: first.finalUrl }
    } catch (error) {
      if (signal?.aborted) throw abortError()
      const alternate = discoverAlternateFeed(firstText, first.finalUrl)
      if (alternate === undefined) throw error
      const second = await fetchResource(alternate, this.requestOptions(signal, this.config.maxFeedBytes, timeoutMs))
      const feed = parseFeed(decodeBody(second.body, second.contentType), second.finalUrl)
      return { feed, finalUrl: second.finalUrl }
    }
  }

  /**
   * Fetch one subscription and store its new entries.
   * @param {string} feedId - stored subscription id.
   * @param {{signal?: AbortSignal, force?: boolean}} [options] - cancellation; force rechecks disabled feeds.
   * @returns {Promise<{ feedId: string, added: number, updated: number, notModified?: boolean, skipped?: boolean, error?: string }>}
   */
  async refreshFeed(feedId, options = {}) {
    const signal = options.signal
    const feed = this.store.state.feeds.find(item => item.id === feedId)
    if (feed === undefined) {
      return { feedId, added: 0, updated: 0, skipped: true, error: 'That subscription no longer exists.' }
    }
    if (!feed.enabled && options.force !== true) return { feedId, added: 0, updated: 0, skipped: true }
    try {
      if (signal?.aborted) throw abortError()
      const response = await fetchResource(feed.url, {
        ...this.requestOptions(signal, this.config.maxFeedBytes),
        etag: feed.etag ?? undefined,
        lastModified: feed.lastModified ?? undefined,
      })
      if (response.notModified) {
        this.store.recordFetch(feed.id, { etag: response.etag, lastModified: response.lastModified })
        return { feedId, added: 0, updated: 0, notModified: true }
      }
      const parsed = parseFeed(decodeBody(response.body, response.contentType), response.finalUrl || feed.url)
      if (!feed.customTitle && parsed.title) feed.title = truncate(parsed.title, 200)
      const result = this.store.ingest(feed.id, parsed.items)
      this.store.recordFetch(feed.id, {
        feed: parsed,
        etag: response.etag,
        lastModified: response.lastModified,
      })
      if (this.config.fullTextOnRefresh) {
        await this.upgradeShortArticles(feed.id, result.addedIds, 3, signal)
      }
      if (result.added > 0) {
        try { await this.onNewArticles(feed.id, result.addedIds, parsed) } catch (error) {
          this.logger.warn?.(`rss: post-refresh AI work failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return { feedId, added: result.added, updated: result.updated, title: parsed.title }
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw abortError()
      const message = feedErrorHint(error)
      this.store.recordFetch(feed.id, {
        error: message,
        errorCode: typeof error?.code === 'string' ? error.code : 'fetch_failed',
      })
      return { feedId, added: 0, updated: 0, error: message }
    }
  }

  /**
   * Recheck a bounded set of subscriptions, including disabled ones, with the
   * same concurrency and error handling as a normal refresh.
   * @param {string[]} ids - subscription ids to fetch.
   * @param {{signal?: AbortSignal}} [options] - cooperative cancellation.
   * @returns {Promise<Array<object>>} one refresh result per subscription.
   */
  async recheckFeeds(ids, options = {}) {
    const signal = options.signal
    const targets = ids
      .map(id => this.store.state.feeds.find(feed => feed.id === id))
      .filter(feed => feed !== undefined)
    return await mapPool(targets, 4, async (feed) => {
      try {
        return await this.refreshFeed(feed.id, { signal, force: true })
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw abortError()
        return { feedId: feed.id, added: 0, updated: 0, error: feedErrorHint(error) }
      }
    }, signal)
  }

  /**
   * Refresh every enabled subscription with bounded concurrency.
   * Concurrent callers share one run so a manual refresh and the timer never
   * duplicate network requests.
   * @param {{signal?: AbortSignal}} [options] - cooperative cancellation.
   * @returns {Promise<{ results: Array, added: number, failed: number, at: string }>}
   */
  async refreshAll(options = {}) {
    if (this.refreshPromise !== null) return this.refreshPromise
    this.refreshPromise = this.runRefreshAll(options).finally(() => {
      this.refreshPromise = null
    })
    return this.refreshPromise
  }

  /** Execute one refresh pass. */
  async runRefreshAll(options = {}) {
    const signal = options.signal
    const feeds = this.store.state.feeds.filter(feed => feed.enabled)
    const results = await mapPool(feeds, 4, async (feed) => {
      try {
        return await this.refreshFeed(feed.id, { signal })
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw abortError()
        return { feedId: feed.id, added: 0, updated: 0, error: feedErrorHint(error) }
      }
    }, signal)
    const added = results.reduce((sum, result) => sum + (result.added ?? 0), 0)
    const failed = results.filter(result => result.error !== undefined).length
    const at = nowIso()
    this.store.recordRefresh({
      at,
      error: failed === 0 ? null : `${failed} of ${results.length} subscriptions failed to refresh.`,
    })
    return { results, added, failed, at }
  }

  /**
   * Parse the original page for an article whose feed content is short.
   * @param {string} articleId - stored article id.
   * @param {{signal?: AbortSignal}} [options] - cooperative cancellation.
   * @returns {Promise<object>} the updated article record.
   */
  async fetchFullText(articleId, options = {}) {
    const signal = options.signal
    const article = this.store.getArticle(articleId)
    if (article === undefined) throw new Error('That article no longer exists.')
    if (article.url === '') throw new Error('This article has no original URL.')
    const response = await fetchResource(article.url, {
      ...this.requestOptions(signal, this.config.maxPageBytes),
      accept: 'text/html, application/xhtml+xml;q=0.9, */*;q=0.5',
    })
    const page = decodeBody(response.body, response.contentType)
    const extracted = extractArticle(page, response.finalUrl || article.url)
    if (extracted.contentText.length < 200) {
      throw new Error('No readable article text was found on the original page.')
    }
    const previousLength = (article.contentHtml ?? '').length
    if (extracted.contentText.length * 1.2 < previousLength && previousLength > 1200) {
      return article
    }
    const patch = { contentHtml: extracted.contentHtml }
    if (extracted.title !== '' && (article.title === '(untitled)' || article.title.length < 4)) patch.title = extracted.title
    if (extracted.byline !== '' && (article.author ?? '') === '') patch.author = collapseWhitespace(extracted.byline)
    if (extracted.image !== '' && (article.image ?? '') === '') patch.image = extracted.image
    this.logger.info?.(`rss: extracted ${extracted.contentText.length} characters from ${article.url}`)
    return this.store.updateArticle(article.id, patch) ?? article
  }

  /** Upgrade the shortest new articles when full text on refresh is enabled. */
  async upgradeShortArticles(feedId, ids, limit, signal) {
    const candidates = ids
      .map(id => this.store.getArticle(id))
      .filter(article => article !== undefined && article.url !== '' && (article.contentHtml ?? '').length < 1200)
      .slice(0, limit)
    for (const article of candidates) {
      if (signal?.aborted) return
      try { await this.fetchFullText(article.id, { signal }) } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') return
        this.logger.warn?.(`rss: full text failed for ${article.url}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /**
   * Import OPML candidates, validating each subscription.
   * @param {Array<{url: string, title?: string, category?: string, tags?: string[]}>} entries - OPML rows.
   * @param {{signal?: AbortSignal}} [options] - cooperative cancellation.
   * @returns {Promise<{ added: number, failed: number, errors: string[] }>}
   */
  async importSubscriptions(entries, options = {}) {
    const errors = []
    const addedIds = []
    for (const entry of entries) {
      if (options.signal?.aborted) throw abortError()
      const url = normalizeUrl(entry.url)
      if (!isValidFeedUrl(url)) {
        errors.push(`${entry.url}: not a valid http(s) URL`)
        continue
      }
      const existing = this.store.state.feeds.find(feed => normalizeUrl(feed.url) === url)
      const categoryId = entry.category
        ? this.store.categoryIdFor(entry.category, true)
        : (existing?.categoryId ?? null)
      const title = String(entry.title ?? '').trim()
      const stored = this.store.upsertFeed({
        url,
        title: title || existing?.title || url,
        categoryId,
        tags: entry.tags,
        customTitle: title !== '' && title !== url,
      })
      if (existing === undefined) addedIds.push(stored.id)
    }
    this.store.touch()
    // Fetching every feed inline made a large OPML import look hung for minutes.
    // Add subscriptions immediately and let a bounded background worker fill them.
    if (addedIds.length > 0) this.refreshImported(addedIds, options)
    return {
      added: addedIds.length,
      failed: errors.length,
      errors: errors.slice(0, 20),
      pending: addedIds.length,
    }
  }

  /**
   * Fill newly imported subscriptions in the background with two workers.
   * @param {string[]} ids - subscription ids to fetch.
   * @param {{signal?: AbortSignal}} [options] - cooperative cancellation.
   */
  refreshImported(ids, options = {}) {
    const queue = [...ids]
    const signal = combineSignals([this.importController.signal, options.signal])
    const worker = async () => {
      for (;;) {
        if (signal.aborted) return
        const id = queue.shift()
        if (id === undefined) return
        try { await this.refreshFeed(id, { signal }) } catch (error) {
          if (signal.aborted || error?.name === 'AbortError') return
          this.logger.warn?.(`rss: imported feed refresh failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        await yieldToLoop()
      }
    }
    void Promise.all([worker(), worker()]).catch((error) => {
      this.logger.warn?.(`rss: imported feed worker failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
}
