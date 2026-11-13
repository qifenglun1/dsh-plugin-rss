/** The shared operation layer used by both the client API and the agent tools. */
import { normalizeTags } from './store.js'
import { hashId, normalizeUrl, nowIso } from './util.js'
import { digestCandidates } from './rank.js'
import { exportOpml, importOpml } from './opml.js'
import { feedErrorHint, isValidFeedUrl } from './feed.js'
import { AiFailureError, AiUnavailableError, stripSummaryLabel } from './ai.js'
import {
  catalogCandidates, existingFeedKeys, inferTopics, isExistingCandidate, mergeCandidates, normalizeTopicList,
} from './discover.js'

/** Build a cancellation error that matches the host-wide convention. */
function abortError() {
  const error = new Error('The operation was cancelled.')
  error.name = 'AbortError'
  error.code = 'aborted'
  return error
}

/** Run tasks with bounded concurrency while preserving result order. */
async function mapBounded(items, limit, work) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await work(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/** A failure that a caller can correct. */
export class ApiError extends Error {
  constructor(message, code = 'bad_request', status = 400) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

/** Re-throw one engine failure with a stable API code and status. */
function rethrow(error, fallbackCode = 'operation_failed', fallbackStatus = 502) {
  if (Number.isInteger(error?.status) && typeof error?.code === 'string') throw error
  const message = error instanceof Error ? error.message : 'The operation failed.'
  if (/no original URL/i.test(message) || /not a supported|response was empty/i.test(message)) {
    throw new ApiError(message, 'invalid_feed', 400)
  }
  throw new ApiError(message, fallbackCode, fallbackStatus)
}

/** Require a non-empty string. */
function text(value, name, max = 500) {
  const result = String(value ?? '').trim()
  if (result === '') throw new ApiError(`${name} is required.`)
  if (result.length > max) throw new ApiError(`${name} is too long.`)
  return result
}

/** Normalize the public shape of one subscription. */
function feedView(feed, store) {
  const counts = store.counts()
  const category = store.state.categories.find(item => item.id === feed.categoryId)
  return {
    id: feed.id,
    url: feed.url,
    title: feed.title,
    siteUrl: feed.siteUrl,
    description: feed.description,
    image: feed.image,
    categoryId: feed.categoryId,
    categoryName: category?.name ?? '',
    tags: feed.tags,
    enabled: feed.enabled,
    error: feed.error,
    errorCode: feed.errorCode,
    failureCount: feed.failureCount,
    lastErrorAt: feed.lastErrorAt,
    lastSuccessAt: feed.lastSuccessAt,
    lastFetchedAt: feed.lastFetchedAt,
    unread: counts.byFeed[feed.id] ?? 0,
  }
}

/** Normalize the public shape of one full article. */
function articleView(article, store) {
  const feed = store.state.feeds.find(item => item.id === article.feedId)
  return {
    id: article.id,
    feedId: article.feedId,
    feedTitle: feed?.title ?? 'Unknown feed',
    feedSiteUrl: feed?.siteUrl ?? '',
    title: article.title,
    url: article.url,
    author: article.author,
    publishedAt: article.publishedAt,
    updatedAt: article.updatedAt,
    tags: article.tags,
    image: article.image,
    language: article.language,
    read: article.read,
    starred: article.starred,
    readLater: article.readLater,
    summaryHtml: article.summaryHtml,
    contentHtml: article.contentHtml,
    contentLength: (article.contentHtml ?? '').length,
    ai: article.ai === undefined || article.ai === null ? article.ai : {
      ...article.ai,
      summary: typeof article.ai.summary === 'string' ? stripSummaryLabel(article.ai.summary) : article.ai.summary,
    },
  }
}

/**
 * Build the operation table.
 * @param {{ store: object, engine: object, ai: object, config: object, logger: object, onNewArticles?: Function }} deps - owners.
 */
export function createApi(deps) {
  const { store, engine, ai, config, logger } = deps
  const notifyNew = deps.onNewArticles ?? (() => {})

  const mustArticle = (id) => {
    const article = store.getArticle(text(id, 'id', 200))
    if (article === undefined) throw new ApiError('That article no longer exists.', 'article_not_found', 404)
    return article
  }
  const mustFeed = (id) => {
    const feed = store.state.feeds.find(item => item.id === text(id, 'id', 200))
    if (feed === undefined) throw new ApiError('That subscription no longer exists.', 'feed_not_found', 404)
    return feed
  }

  /** Add one already-validated feed and import its current entries. */
  function addValidatedFeed(validated, options = {}) {
    const customTitle = typeof options.title === 'string' && options.title.trim() !== ''
    const feed = store.upsertFeed({
      url: validated.finalUrl,
      title: customTitle ? options.title : validated.feed.title,
      categoryId: options.categoryId ?? null,
      tags: normalizeTags(options.tags),
      customTitle,
      ...(typeof options.enabled === 'boolean' ? { enabled: options.enabled } : {}),
    })
    const result = store.ingest(feed.id, validated.feed.items)
    store.recordFetch(feed.id, { feed: validated.feed })
    if (store.settings().autoClassify || store.settings().autoSummarize) {
      void notifyNew(feed.id, result.addedIds, validated.feed)
    }
    return { feed: feedView(store.state.feeds.find(item => item.id === feed.id), store), added: result.added, updated: result.updated }
  }

  const methods = {
    /** Lightweight liveness payload for tools and verification. */
    async health() {
      const state = store.stateForClient(ai.describe())
      return {
        ok: true,
        version: 1,
        feeds: state.stats.feeds,
        articles: state.stats.articles,
        unread: state.stats.unread,
        dataFile: store.filePath,
        ai: state.ai,
      }
    },

    /** Everything the client needs for its first paint. */
    async state() {
      return store.stateForClient(ai.describe())
    },

    /** Page through one article view. */
    async articles(params = {}) {
      return store.listArticles({
        view: params.view ?? 'all',
        feedId: params.feedId ?? null,
        categoryId: params.categoryId ?? null,
        tag: params.tag ?? null,
        text: params.text ?? '',
        limit: params.limit ?? store.settings().pageSize,
        offset: params.offset ?? 0,
        hideMuted: params.hideMuted !== false,
        sort: params.sort === 'oldest' ? 'oldest' : 'newest',
      })
    },

    /** Read one article, optionally promoting it to read and fetching full text. */
    async article(params = {}) {
      const article = mustArticle(params.id)
      if (params.markRead !== false) store.mark(article.id, { read: true })
      if (params.fullText === true) {
        try { await engine.fetchFullText(article.id, { signal: params.signal }) } catch (error) { rethrow(error, 'full_text_failed', 502) }
      }
      return articleView(store.getArticle(article.id), store)
    },

    /** Fetch and store the original page's readable text. */
    async fullText(params = {}) {
      const article = mustArticle(params.id)
      try {
        return articleView(await engine.fetchFullText(article.id, { signal: params.signal }), store)
      } catch (error) { rethrow(error, 'full_text_failed', 502) }
    },

    /** Validate and add one subscription, importing its current entries. */
    async feedAdd(params = {}) {
      const url = text(params.url, 'url', 2000)
      if (!isValidFeedUrl(url)) throw new ApiError('Enter an http(s) feed or site URL.', 'invalid_url', 400)
      let validated
      try { validated = await engine.validate(url, { signal: params.signal }) } catch (error) { rethrow(error, 'feed_unreachable', 502) }
      const categoryId = typeof params.categoryId === 'string'
        ? params.categoryId
        : params.categoryName
          ? store.categoryIdFor(params.categoryName, true)
          : null
      return await addValidatedFeed(validated, {
        title: params.title,
        categoryId,
        tags: params.tags,
        enabled: params.enabled,
      })
    },

    /** Suggest subscriptions for the reader's topics without adding anything. */
    async discoverTopics() {
      return { topics: inferTopics(store) }
    },

    /**
     * Build verified subscription candidates from topics: curated catalog
     * entries plus optional DeepSeek suggestions. Nothing is added here.
     */
    async discoverFeeds(params = {}) {
      const provided = normalizeTopicList(params.topics)
      const topics = provided.length > 0 ? provided : inferTopics(store)
      if (topics.length === 0) {
        throw new ApiError('Choose at least one topic to discover feeds.', 'topics_required', 400)
      }
      const limit = Math.min(12, Math.max(4, Number(params.limit) || 10))
      const existing = store.state.feeds.map(feed => ({ title: feed.title, url: feed.url, siteUrl: feed.siteUrl }))
      const keys = existingFeedKeys(existing)
      const aiAvailable = typeof ai.available === 'function' ? ai.available() === true : false
      const aiInfo = { available: aiAvailable, requested: false, used: false, error: null }
      let aiCandidates = []
      if (aiAvailable && typeof ai.suggestFeeds === 'function') {
        aiInfo.requested = true
        try {
          const suggestion = await ai.suggestFeeds({
            topics,
            existing,
            categories: store.state.categories.map(category => category.name),
            limit,
            signal: params.signal,
          })
          aiCandidates = (Array.isArray(suggestion?.feeds) ? suggestion.feeds : []).map(feed => ({
            url: feed.url,
            title: feed.title,
            siteUrl: '',
            description: feed.description,
            image: '',
            suggestedCategory: feed.category,
            tags: Array.isArray(feed.tags) ? feed.tags : [],
            matchedTopics: [],
            reason: feed.reason,
            source: 'ai',
            score: 0,
          }))
          aiInfo.used = aiCandidates.length > 0
        } catch (error) {
          if (params.signal?.aborted || error?.name === 'AbortError') throw abortError()
          aiInfo.error = error instanceof Error ? error.message : String(error)
        }
      }
      const catalog = catalogCandidates(topics, { limit: Math.max(4, Math.min(8, limit)) })
      // Keep a few extra entries so existing sources and validation failures
      // cannot crowd out the rest of the catalog before the final cap.
      const merged = mergeCandidates([...aiCandidates, ...catalog], limit + 8)
      let existingCount = 0
      const targets = []
      for (const candidate of merged) {
        if (isExistingCandidate(candidate, keys)) {
          existingCount += 1
          continue
        }
        targets.push(candidate)
      }
      const timeoutMs = Math.min(Number(config.requestTimeoutMs) || 25_000, 15_000)
      const checked = await mapBounded(targets.slice(0, 14), 4, async (candidate) => {
        if (params.signal?.aborted) throw abortError()
        try {
          const validated = await engine.validate(candidate.url, { signal: params.signal, timeoutMs })
          return { candidate, validated }
        } catch (error) {
          if (params.signal?.aborted || error?.name === 'AbortError') throw abortError()
          return { candidate, error: feedErrorHint(error) }
        }
      })
      const skipped = []
      const seenFinals = new Set()
      const candidates = []
      for (const entry of checked) {
        if (entry.error !== undefined) {
          if (skipped.length < 8) skipped.push({ url: entry.candidate.url, title: entry.candidate.title, error: entry.error })
          continue
        }
        const finalUrl = normalizeUrl(entry.validated.finalUrl) || entry.candidate.url
        const feed = entry.validated.feed ?? {}
        // A site URL can resolve to a feed the reader already follows, so the
        // post-validation URL must be checked again.
        if (isExistingCandidate({ url: finalUrl, siteUrl: feed.siteUrl }, keys)
          || store.state.feeds.some(existing => normalizeUrl(existing.url) === finalUrl)) {
          existingCount += 1
          continue
        }
        if (seenFinals.has(finalUrl)) continue
        seenFinals.add(finalUrl)
        candidates.push({
          url: entry.candidate.url,
          finalUrl,
          title: feed.title || entry.candidate.title || finalUrl,
          siteUrl: feed.siteUrl || entry.candidate.siteUrl || '',
          description: feed.description || entry.candidate.description || '',
          image: feed.image || '',
          suggestedCategory: entry.candidate.suggestedCategory || '',
          tags: entry.candidate.tags ?? [],
          matchedTopics: entry.candidate.matchedTopics ?? [],
          reason: entry.candidate.reason || '',
          source: entry.candidate.source === 'ai' ? 'ai' : 'catalog',
        })
      }
      return {
        topics,
        candidates: candidates.slice(0, limit),
        skipped,
        existingCount,
        ai: aiInfo,
      }
    },

    /** Add several discovered feeds at once; each URL is verified independently. */
    async feedsAddBatch(params = {}) {
      const entries = []
      const failed = []
      const seen = new Set()
      for (const value of Array.isArray(params.urls) ? params.urls : []) {
        const url = String(value ?? '').trim()
        if (url === '') continue
        if (!isValidFeedUrl(url)) {
          failed.push({ url, error: 'Enter an http(s) feed or site URL.' })
          continue
        }
        const key = normalizeUrl(url)
        if (key === '' || seen.has(key)) continue
        seen.add(key)
        entries.push({ url: key })
      }
      if (entries.length === 0 && failed.length === 0) {
        throw new ApiError('Select at least one feed to add.', 'urls_required', 400)
      }
      if (entries.length > 20) throw new ApiError('Add at most 20 feeds at once.', 'too_many_urls', 400)
      const explicitCategoryId = typeof params.categoryId === 'string' ? params.categoryId : null
      const categoryName = typeof params.categoryName === 'string' ? params.categoryName.trim() : ''
      const tags = normalizeTags(params.tags)
      const keys = existingFeedKeys(store.state.feeds)
      const skipped = []
      const targets = []
      for (const entry of entries) {
        if (isExistingCandidate(entry, keys)) skipped.push({ url: entry.url, reason: 'existing' })
        else targets.push(entry)
      }
      const timeoutMs = Math.min(Number(config.requestTimeoutMs) || 25_000, 15_000)
      // Verify every selected URL before touching the store, so a cancellation
      // can never leave a half-applied batch.
      const checked = await mapBounded(targets, 3, async (entry) => {
        if (params.signal?.aborted) throw abortError()
        try {
          const validated = await engine.validate(entry.url, { signal: params.signal, timeoutMs })
          return { entry, validated }
        } catch (error) {
          if (params.signal?.aborted || error?.name === 'AbortError') throw abortError()
          return { entry, error: feedErrorHint(error) }
        }
      })
      const added = []
      const seenFinals = new Set()
      // The add phase performs no network work; each call mutates memory only.
      for (const outcome of checked) {
        if (outcome.error !== undefined) {
          failed.push({ url: outcome.entry.url, error: outcome.error })
          continue
        }
        const finalUrl = normalizeUrl(outcome.validated.finalUrl)
        if (finalUrl === '' || store.state.feeds.some(feed => normalizeUrl(feed.url) === finalUrl)) {
          skipped.push({ url: outcome.entry.url, reason: 'existing' })
          continue
        }
        if (seenFinals.has(finalUrl)) {
          skipped.push({ url: outcome.entry.url, reason: 'duplicate' })
          continue
        }
        seenFinals.add(finalUrl)
        try {
          const categoryId = explicitCategoryId ?? (categoryName !== '' ? store.categoryIdFor(categoryName, true) : null)
          const result = addValidatedFeed(outcome.validated, { categoryId, tags })
          added.push({ id: result.feed.id, title: result.feed.title, url: result.feed.url, inputUrl: outcome.entry.url })
        } catch (error) {
          failed.push({ url: outcome.entry.url, error: feedErrorHint(error) })
        }
      }
      return {
        added,
        failed,
        skipped,
        addedCount: added.length,
        failedCount: failed.length,
        state: store.stateForClient(ai.describe()),
      }
    },

    /** Update subscription metadata, category, tags, or enablement. */
    async feedUpdate(params = {}) {
      const feed = mustFeed(params.id)
      store.updateFeed(feed.id, {
        ...(typeof params.title === 'string' ? { title: params.title } : {}),
        ...(params.categoryId !== undefined ? { categoryId: params.categoryId } : {}),
        ...(typeof params.categoryName === 'string' ? { categoryName: params.categoryName } : {}),
        ...(params.tags !== undefined ? { tags: params.tags } : {}),
        ...(typeof params.enabled === 'boolean' ? { enabled: params.enabled } : {}),
      })
      const updated = mustFeed(feed.id)
      return { feed: feedView(updated, store) }
    },

    /** Remove a subscription; saved articles stay when starred or read later. */
    async feedRemove(params = {}) {
      const feed = mustFeed(params.id)
      const removed = store.removeFeed(feed.id)
      if (!removed) throw new ApiError('That subscription no longer exists.', 'feed_not_found', 404)
      return { removed: true, feedId: feed.id }
    },

    /** Refresh one subscription. */
    async feedRefresh(params = {}) {
      const feed = mustFeed(params.id)
      let result
      try { result = await engine.refreshFeed(feed.id, { signal: params.signal }) } catch (error) { rethrow(error, 'refresh_failed', 502) }
      return { ...result, state: store.stateForClient(ai.describe()) }
    },

    /** Refresh every enabled subscription. */
    async refresh(params = {}) {
      let result
      try { result = await engine.refreshAll({ signal: params.signal }) } catch (error) { rethrow(error, 'refresh_failed', 502) }
      return {
        added: result.added,
        failed: result.failed,
        at: result.at,
        results: result.results,
        state: store.stateForClient(ai.describe()),
      }
    },

    /**
     * Merge the curated default subscriptions back into the library.
     * Existing subscriptions are kept untouched, so this is safe to repeat.
     */
    async feedsRestore() {
      const added = store.restoreDefaultFeeds()
      if (added.length > 0) engine.refreshImported(added.map(feed => feed.id))
      const state = store.stateForClient(ai.describe())
      return {
        added: added.map(feed => ({ id: feed.id, title: feed.title, url: feed.url })),
        addedCount: added.length,
        existingCount: state.feeds.length - added.length,
        state,
      }
    },

    /** Recheck subscriptions (failing ones by default) and report recovery. */
    async feedsRecheck(params = {}) {
      const requested = Array.isArray(params.ids)
        ? params.ids.filter(id => typeof id === 'string' && id !== '').slice(0, 50)
        : []
      const targets = requested.length > 0
        ? requested
        : store.state.feeds.filter(feed => feed.error !== null).slice(0, 50).map(feed => feed.id)
      if (targets.length === 0) {
        return { checked: 0, failed: 0, results: [], state: store.stateForClient(ai.describe()) }
      }
      let results
      try { results = await engine.recheckFeeds(targets, { signal: params.signal }) } catch (error) { rethrow(error, 'refresh_failed', 502) }
      const failed = results.filter(result => result.error !== undefined).length
      return { checked: results.length, failed, results, state: store.stateForClient(ai.describe()) }
    },

    /** Delete invalid subscriptions, optionally including mere suspects. */
    async feedsPrune(params = {}) {
      const includeSuspect = params.includeSuspect === true
      const candidates = includeSuspect
        ? store.state.feeds.filter(feed => feed.error !== null)
        : store.invalidFeeds()
      const { removed, keptArticles } = store.removeFeeds(candidates.map(feed => feed.id))
      return {
        removed: removed.map(feed => ({
          id: feed.id, title: feed.title, url: feed.url, error: feed.error, failureCount: feed.failureCount,
        })),
        count: removed.length,
        keptArticles,
        state: store.stateForClient(ai.describe()),
      }
    },

    /** Remove every subscription; starred and read-later articles survive. */
    async feedsClear() {
      const { removed } = store.removeFeeds(store.state.feeds.map(feed => feed.id))
      // After clearing, every surviving article is a saved one.
      const keptArticles = store.state.articles.filter(article => article.starred === true || article.readLater === true).length
      return { count: removed.length, keptArticles, state: store.stateForClient(ai.describe()) }
    },

    /** Update read, star, or read-later state. */
    async mark(params = {}) {
      const article = mustArticle(params.id)
      const updated = store.mark(article.id, {
        ...(typeof params.read === 'boolean' ? { read: params.read } : {}),
        ...(typeof params.starred === 'boolean' ? { starred: params.starred } : {}),
        ...(typeof params.readLater === 'boolean' ? { readLater: params.readLater } : {}),
      })
      return {
        id: updated.id, read: updated.read, starred: updated.starred, readLater: updated.readLater,
      }
    },

    /** Mark a whole view, subscription, category, tag, or search read. */
    async markAll(params = {}) {
      const result = store.markAll({
        ...(typeof params.feedId === 'string' ? { feedId: params.feedId } : {}),
        ...(typeof params.categoryId === 'string' ? { categoryId: params.categoryId } : {}),
        ...(typeof params.tag === 'string' ? { tag: params.tag } : {}),
        ...(typeof params.text === 'string' ? { text: params.text } : {}),
        ...(typeof params.hideMuted === 'boolean' ? { hideMuted: params.hideMuted } : {}),
        view: params.view ?? 'all',
      })
      return { updated: result.updated, ids: result.ids, state: store.stateForClient(ai.describe()) }
    },

    /** Apply one read/star/read-later patch to many articles at once. */
    async markMany(params = {}) {
      const ids = (Array.isArray(params.ids) ? params.ids : [])
        .filter(id => typeof id === 'string' && id !== '')
      if (ids.length === 0) throw new ApiError('Choose at least one article to update.', 'invalid_ids', 400)
      if (ids.length > 20_000) throw new ApiError('Too many articles in one update.', 'too_many_ids', 400)
      const patch = {
        ...(typeof params.read === 'boolean' ? { read: params.read } : {}),
        ...(typeof params.starred === 'boolean' ? { starred: params.starred } : {}),
        ...(typeof params.readLater === 'boolean' ? { readLater: params.readLater } : {}),
      }
      if (Object.keys(patch).length === 0) throw new ApiError('Choose a field to update.', 'invalid_patch', 400)
      const updated = store.markMany(ids, patch)
      return { updated, state: store.stateForClient(ai.describe()) }
    },

    /** Add a category. */
    async categoryAdd(params = {}) {
      const category = store.addCategory(text(params.name, 'name', 80))
      return { category, state: store.stateForClient(ai.describe()) }
    },

    /** Rename a category. */
    async categoryRename(params = {}) {
      const category = store.renameCategory(text(params.id, 'id', 200), text(params.name, 'name', 80))
      if (category === undefined) throw new ApiError('That category no longer exists.', 'category_not_found', 404)
      return { category, state: store.stateForClient(ai.describe()) }
    },

    /** Delete a category; its feeds become uncategorized. */
    async categoryRemove(params = {}) {
      const removed = store.removeCategory(text(params.id, 'id', 200))
      return { removed, state: store.stateForClient(ai.describe()) }
    },

    /** Save the client-editable settings subset. */
    async settingsSave(params = {}) {
      const settings = store.saveSettings(params)
      return { settings, ai: ai.describe() }
    },

    /** Create or update a content filter rule. */
    async filterSave(params = {}) {
      const rule = store.saveFilter(params)
      return { rule, filters: store.state.filters }
    },

    /** Delete a content filter rule. */
    async filterRemove(params = {}) {
      const removed = store.removeFilter(text(params.id, 'id', 200))
      return { removed, filters: store.state.filters }
    },

    /** Import subscriptions from an OPML document. */
    async opmlImport(params = {}) {
      const source = String(params.opml ?? '')
      if (source.trim() === '') throw new ApiError('The OPML document is empty.')
      const parsed = importOpml(source)
      if (parsed.feeds.length === 0) throw new ApiError(parsed.errors[0] ?? 'No subscriptions were found in this OPML document.')
      const result = await engine.importSubscriptions(parsed.feeds)
      store.recordOpml({ ...result, errors: result.errors })
      return { ...result, state: store.stateForClient(ai.describe()) }
    },

    /** Export every subscription as OPML. */
    async opmlExport() {
      const opml = exportOpml(store.state.feeds, store.state.categories)
      return { opml, filename: `dsh-rss-${new Date().toISOString().slice(0, 10)}.opml` }
    },

    /** Summarize one article. */
    async aiSummarize(params = {}) {
      const article = mustArticle(params.id)
      const language = typeof params.language === 'string' ? params.language : ''
      const contentHash = hashId(article.contentHtml || article.summaryHtml, 'content')
      const cacheFresh = article.ai?.contentHash === undefined || article.ai.contentHash === contentHash
      if (article.ai?.summary && cacheFresh && params.force !== true && (language === '' || article.ai.summaryLanguage === language)) {
        return { summary: stripSummaryLabel(article.ai.summary), language, cached: true, route: ai.describe() }
      }
      const result = await ai.summarize(article, { language, signal: params.signal })
      store.updateArticle(article.id, { ai: { summaryLanguage: language || ai.targetLanguage(article) } })
      return { ...result, cached: false }
    },

    /** Translate one article. */
    async aiTranslate(params = {}) {
      const article = mustArticle(params.id)
      const target = typeof params.to === 'string' && params.to.trim() !== '' ? params.to.trim() : ai.targetLanguage(article)
      const contentHash = hashId(article.contentHtml || article.summaryHtml, 'content')
      const cacheFresh = article.ai?.translationHash === undefined || article.ai.translationHash === contentHash
      if (article.ai?.translation && cacheFresh && article.ai.translationLang === target && params.force !== true) {
        return { translation: article.ai.translation, language: target, cached: true, route: ai.describe() }
      }
      const result = await ai.translate(article, { to: target, signal: params.signal })
      return { ...result, cached: false }
    },

    /** Classify one article into categories and tags. */
    async aiClassify(params = {}) {
      const article = mustArticle(params.id)
      if (article.ai?.classifiedAt && params.force !== true) {
        return { categories: article.ai.categories, tags: article.ai.tags, relevance: article.ai.relevance, cached: true, route: ai.describe() }
      }
      const result = await ai.classify(article, { signal: params.signal })
      return { ...result, cached: false }
    },

    /** Answer a question about one article. */
    async aiAsk(params = {}) {
      const article = mustArticle(params.id)
      return ai.ask(article, { question: params.question, history: params.history, language: params.language, signal: params.signal })
    },

    /** Suggest three article-grounded questions for the Q&A composer. */
    async aiQuestions(params = {}) {
      const article = mustArticle(params.id)
      return ai.questions(article, { history: params.history, language: params.language, signal: params.signal })
    },

    /** Ask DeepSeek to rank the most relevant unread candidates. */
    async aiRecommend(params = {}) {
      const candidates = digestCandidates(store.state.articles, {
        feedWeights: store.state.interests.feeds,
        tagWeights: store.state.interests.tags,
        limit: Math.min(24, Math.max(6, Number(params.limit) || 16)),
      })
      const profile = {
        tags: Object.entries(store.state.interests.tags)
          .sort((left, right) => Number(right[1]) - Number(left[1]))
          .slice(0, 6)
          .map(([tag]) => tag),
        feeds: Object.entries(store.state.interests.feeds)
          .sort((left, right) => Number(right[1]) - Number(left[1]))
          .slice(0, 4)
          .map(([feedId]) => store.state.feeds.find(feed => feed.id === feedId)?.title ?? feedId),
      }
      const result = await ai.recommend(candidates, { profile, signal: params.signal })
      const items = result.picks.map(pick => {
        const article = store.getArticle(pick.id)
        if (article === undefined) return null
        const feed = store.state.feeds.find(item => item.id === article.feedId)
        return {
          id: article.id,
          title: article.title,
          feedTitle: feed?.title ?? '',
          publishedAt: article.publishedAt,
          tags: article.tags,
          url: article.url,
          score: pick.score,
          reason: pick.reason,
        }
      }).filter(item => item !== null)
      return { items, route: result.route }
    },

    /** Write a brief over the most relevant unread articles. */
    async aiBrief(params = {}) {
      const candidates = digestCandidates(store.state.articles, {
        feedWeights: store.state.interests.feeds,
        tagWeights: store.state.interests.tags,
        limit: Math.min(20, Math.max(3, Number(params.limit) || 10)),
      })
      return ai.brief(candidates, { language: params.language, signal: params.signal })
    },

    /** Providers and models for the settings panel. */
    async aiModels() {
      return ai.models()
    },

    /** Reading statistics and filter counts. */
    async stats() {
      return store.stateForClient(ai.describe())
    },
  }

  return {
    methods,
    /**
     * Dispatch one operation by name.
     * @param {string} name - operation key.
     * @param {object} params - untrusted parameters.
     * @returns {Promise<unknown>}
     */
    async call(name, params) {
      if (!Object.hasOwn(methods, name)) throw new ApiError(`Unknown operation: ${name}`, 'unknown_method', 404)
      const method = methods[name]
      try {
        return await method(params ?? {})
      } catch (error) {
        if (error instanceof ApiError || error instanceof AiUnavailableError || error instanceof AiFailureError) throw error
        if (Number.isInteger(error?.status) && typeof error?.code === 'string') {
          throw new ApiError(error instanceof Error ? error.message : 'The operation failed.', error.code, error.status)
        }
        logger.warn?.(`rss: ${name} failed: ${error instanceof Error ? error.message : String(error)}`)
        throw new ApiError(error instanceof Error ? error.message : 'The operation failed.', 'operation_failed', 500)
      }
    },
  }
}
